import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';
import { avgEntryPrice, MarkInputs, markPrice, notional, pnl, PositionState } from './ledger-math';
import { lifetimePnl, sessionPnl } from './pnl-math';
import {
  ListingInfo, loadListingInfo, loadSessionStates, loadStrategyState, SessionListingState, StrategyListingState,
} from './pnl-state';

// A strategy's (or one session's) prediction-market positions grouped by event, with what each would be worth if each
// outcome won.
// Contracts settle at $1 if their outcome wins and $0 otherwise, and exactly one outcome of a market wins:
//   BINARY         two contracts on one market (YES/NO, or two named sides), sharing the market's id
//   MULTI_OUTCOME  one contract per outcome of the event, the outcomes mutually exclusive
// A scenario is the PnL of the positions on that market if that outcome won: the strategy's lifetime PnL, or for
// ?sessionId= the session's PnL (from $0 at its start, as pnl-math defines it). It covers only those contracts: a
// hedge on another listing (a perp, say) pays the same whoever wins and isn't in it. Positions on listings that
// aren't event contracts are returned as they are, under `other`.

const BINARY = 7;
const MULTI_OUTCOME = 8;
const DOLLAR = 1_000_000_000n;

class BadRequest extends Error {}

interface Contract {
  eventId: number;
  contractId: number;
  outcome: string;
  contractType: number;
  listingId: number | null;
  marketKey: string;
  symbol: string | null;
}

interface Held {
  listingId: number;
  symbol: string | null;
  exchangeId: number | null;
  tickSize: string | null;
  lotSize: string | null;
  netQuantity: string;
  avgEntryPrice: string;
  markPrice: string;
  unrealized: string;
  total: string;
}

function money(value: bigint): string {
  return value.toString();
}

// A binary market's two contracts share the venue id before the ':' (a Kalshi ticker, a Polymarket condition id).
function marketKey(contractType: number, eventId: number, exchangeSecurityId: string | null): string {
  if (contractType === BINARY && exchangeSecurityId) return `${eventId}/${exchangeSecurityId.split(':')[0]}`;
  return `${eventId}`;
}

// The lifetime PnL of a position if its contract settled at `settle`.
function settledPnl(position: PositionState, settle: bigint): bigint {
  const signedCost = position.netQuantity < 0n ? -position.totalCost : position.totalCost;
  return position.realizedPnl - position.totalFees + notional(settle, position.netQuantity) - signedCost;
}

// A position and how it's valued: now, and if its contract settled at a price.
interface Holding {
  listingId: number;
  position: PositionState;
  mark: MarkInputs | null;
  total: () => bigint;
  settled: (settle: bigint) => bigint;
}

function strategyHolding(state: StrategyListingState): Holding {
  return {
    listingId: state.listingId,
    position: state.position,
    mark: state.mark,
    total: () => lifetimePnl(state.position, state.mark).total,
    settled: settle => settledPnl(state.position, settle),
  };
}

// Session PnL leaves out what its inherited inventory was worth when it started.
function sessionHolding(state: SessionListingState): Holding {
  const valued = (mark: MarkInputs | null) => sessionPnl({
    opening: state.opening, openingMark: state.openingMark, current: state.current, mark,
  });
  const openingUnrealized = valued(state.mark).openingUnrealized;
  return {
    listingId: state.listingId,
    position: state.current,
    mark: state.mark,
    total: () => valued(state.mark).total,
    settled: settle => settledPnl(state.current, settle) - openingUnrealized,
  };
}

function heldRow(holding: Holding, info: ListingInfo | undefined): Held {
  const unrealized = pnl(holding.position, holding.mark).unrealizedPnl;
  const net = holding.position.netQuantity;
  return {
    listingId: holding.listingId,
    symbol: info?.symbol ?? null,
    exchangeId: info?.exchangeId ?? null,
    tickSize: info?.tickSize ?? null,
    lotSize: info?.lotSize ?? null,
    netQuantity: net.toString(),
    avgEntryPrice: avgEntryPrice(holding.position).toString(),
    markPrice: markPrice(holding.mark).toString(),
    unrealized: money(unrealized),
    total: money(holding.total()),
  };
}

async function loadHoldings(
  client: PoolClient, params: Record<string, string | undefined>, now: Date,
): Promise<Holding[]> {
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new BadRequest('sessionId must be a session id');
    return (await loadSessionStates(client, [params.sessionId], now)).map(sessionHolding);
  }
  const strategyId = parsePositiveInt(params.strategyId);
  if (strategyId === undefined || Number.isNaN(strategyId)) throw new BadRequest('strategyId or sessionId is required');
  let mode;
  try {
    mode = parseMode(params.mode);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
  if (!mode) throw new BadRequest('mode is required');
  return (await loadStrategyState(client, mode, strategyId, now)).listings.map(strategyHolding);
}

export async function events(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  const holdings = await loadHoldings(client, params, now);
  const listingIds = holdings.map(h => h.listingId);
  const traded = (await client.query(`
    SELECT l.listing_id, l.exchange_security_id, l.exchange_security_symbol AS symbol, s.contract_type, ev.event_id
    FROM sm.listing l
    JOIN sm.security s ON s.security_id = l.security_id
    LEFT JOIN LATERAL (
      SELECT ec.event_id FROM sm.event_contract ec JOIN sm.event e ON e.event_id = ec.event_id
      WHERE ec.security_id = l.security_id AND e.exchange_id = l.exchange_id
      ORDER BY ec.event_id DESC LIMIT 1
    ) ev ON TRUE
    WHERE l.listing_id = ANY($1::int[])`, [listingIds])).rows;
  const tradedById = new Map(traded.map(t => [t.listing_id as number, t]));
  const info = await loadListingInfo(client, listingIds);
  const isContract = (t: { contract_type: number; event_id: number | null } | undefined) =>
    !!t && t.event_id !== null && (t.contract_type === BINARY || t.contract_type === MULTI_OUTCOME);

  const eventIds = [...new Set(traded.filter(isContract).map(t => t.event_id as number))];
  const eventRows = eventIds.length === 0 ? [] : (await client.query(
    'SELECT event_id, title, expiry, resolved FROM sm.event WHERE event_id = ANY($1::int[])', [eventIds])).rows;
  const contracts: Contract[] = eventIds.length === 0 ? [] : (await client.query(`
    SELECT ec.event_id, ec.event_contract_id, ec.outcome_label, s.contract_type, l.listing_id, l.exchange_security_id,
      l.exchange_security_symbol AS symbol
    FROM sm.event_contract ec
    JOIN sm.event e ON e.event_id = ec.event_id
    JOIN sm.security s ON s.security_id = ec.security_id
    LEFT JOIN sm.listing l ON l.security_id = ec.security_id AND l.exchange_id = e.exchange_id
    WHERE ec.event_id = ANY($1::int[])
    ORDER BY ec.event_contract_id`, [eventIds])).rows.map(r => ({
    eventId: r.event_id, contractId: r.event_contract_id, outcome: r.outcome_label, contractType: r.contract_type,
    listingId: r.listing_id, marketKey: marketKey(r.contract_type, r.event_id, r.exchange_security_id), symbol: r.symbol,
  }));

  const positions = new Map(holdings.map(h => [h.listingId, h]));
  const heldKeys = new Set(holdings
    .filter(l => isContract(tradedById.get(l.listingId)))
    .map(l => {
      const t = tradedById.get(l.listingId);
      return marketKey(t.contract_type, t.event_id, t.exchange_security_id);
    }));

  const out = eventRows.map(e => {
    const markets = [...heldKeys].filter(key => key === `${e.event_id}` || key.startsWith(`${e.event_id}/`)).map(key => {
      const outcomes = contracts.filter(c => c.marketKey === key);
      const held = outcomes.filter(c => c.listingId !== null && positions.has(c.listingId));
      const kind = outcomes[0]?.contractType === BINARY ? 'BINARY' : 'MULTI_OUTCOME';
      const holding = (c: Contract) => positions.get(c.listingId as number) as Holding;
      const current = held.reduce((sum, c) => sum + holding(c).total(), 0n);
      const scenarioFor = (winner: Contract | null) => held.reduce(
        (sum, c) => sum + holding(c).settled(winner !== null && c.contractId === winner.contractId ? DOLLAR : 0n), 0n);
      // Every outcome the strategy holds gets its own scenario; the rest all pay the same, so they share one.
      const unheld = outcomes.filter(c => !held.includes(c));
      const scenarios = [
        ...held.map(c => ({ label: c.outcome, pnl: scenarioFor(c) })),
        ...(unheld.length === 1 ? [{ label: unheld[0].outcome, pnl: scenarioFor(unheld[0]) }] : []),
        ...(unheld.length > 1 ? [{ label: `Any of the other ${unheld.length} outcomes`, pnl: scenarioFor(null) }] : []),
      ].map(s => ({ label: s.label, pnl: money(s.pnl), change: money(s.pnl - current) }));
      const values = scenarios.map(s => BigInt(s.pnl));
      // A binary market's two sides are one bet: long NO is short YES.
      const netExposure = kind === 'BINARY' && outcomes.length === 2
        ? {
          outcome: outcomes[0].outcome,
          quantity: (
            (positions.get(outcomes[0].listingId as number)?.position.netQuantity ?? 0n)
            - (positions.get(outcomes[1].listingId as number)?.position.netQuantity ?? 0n)
          ).toString(),
        }
        : null;
      return {
        key,
        kind,
        outcomes: outcomes.map(c => ({
          outcome: c.outcome,
          listingId: c.listingId,
          symbol: c.symbol,
          held: c.listingId !== null && positions.has(c.listingId)
            ? heldRow(positions.get(c.listingId) as Holding, info.get(c.listingId))
            : null,
        })),
        netExposure,
        current: money(current),
        scenarios,
        worst: values.length ? money(values.reduce((a, b) => (b < a ? b : a))) : null,
        best: values.length ? money(values.reduce((a, b) => (b > a ? b : a))) : null,
      };
    });
    return { eventId: e.event_id, title: e.title, expiry: e.expiry, resolved: e.resolved, markets };
  });

  const other = holdings
    .filter(h => !isContract(tradedById.get(h.listingId)))
    .map(h => heldRow(h, info.get(h.listingId)));
  return { asOf: now.toISOString(), events: out, other };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, await events(client, event.queryStringParameters ?? {}, new Date()));
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    console.error('PnL events error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
