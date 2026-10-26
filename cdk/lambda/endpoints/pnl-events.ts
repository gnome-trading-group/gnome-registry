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
//   ?status=active (default)  events with a contract still held, soonest to close first, and other listings held
//   ?status=history           events with every contract flat, most recently resolved first, a page at a time:
//                             &limit= (default 50, max 200), &before=nextBefore. The first page also carries the
//                             newest flat other listings, up to limit.
// Both carry counts of each, so a page can say what it hasn't loaded.

const BINARY = 7;
const MULTI_OUTCOME = 8;
const DOLLAR = 1_000_000_000n;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

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
  lastFillAt: Date | null;
  total: () => bigint;
  settled: (settle: bigint) => bigint;
}

function strategyHolding(state: StrategyListingState): Holding {
  return {
    listingId: state.listingId,
    position: state.position,
    mark: state.mark,
    lastFillAt: state.lastFillAt,
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
    lastFillAt: state.lastFillAt,
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
  return combineAccounts((await loadStrategyState(client, mode, strategyId, now)).listings.map(strategyHolding));
}

function newest(a: Date | null, b: Date | null): Date | null {
  if (a === null || b === null) return a ?? b;
  return a > b ? a : b;
}

// A listing the strategy holds on several venue accounts is one holding here: its outcomes are the same whichever
// account holds them, so the quantities add and each account's PnL is summed.
function combineAccounts(holdings: Holding[]): Holding[] {
  const byListing = new Map<number, Holding>();
  for (const h of holdings) {
    const prior = byListing.get(h.listingId);
    byListing.set(h.listingId, prior === undefined ? h : {
      listingId: h.listingId,
      position: {
        netQuantity: prior.position.netQuantity + h.position.netQuantity,
        totalCost: prior.position.totalCost + h.position.totalCost,
        realizedPnl: prior.position.realizedPnl + h.position.realizedPnl,
        totalFees: prior.position.totalFees + h.position.totalFees,
      },
      mark: h.mark,
      lastFillAt: newest(prior.lastFillAt, h.lastFillAt),
      total: () => prior.total() + h.total(),
      settled: settle => prior.settled(settle) + h.settled(settle),
    });
  }
  return [...byListing.values()];
}

interface Page {
  limit: number;
  before: { time: number | null; eventId: number } | null;
}

function parseStatus(params: Record<string, string | undefined>): Page | null {
  const status = params.status ?? 'active';
  if (status === 'active') return null;
  if (status !== 'history') throw new BadRequest('status must be active or history');
  const limit = parsePositiveInt(params.limit) ?? DEFAULT_HISTORY_LIMIT;
  if (Number.isNaN(limit) || limit > MAX_HISTORY_LIMIT) throw new BadRequest(`limit must be 1 to ${MAX_HISTORY_LIMIT}`);
  if (params.before === undefined) return { limit, before: null };
  if (!params.before.includes(',')) throw new BadRequest('before must be a nextBefore from an earlier page');
  const [time, id] = [params.before.slice(0, params.before.lastIndexOf(',')), params.before.split(',').pop()];
  const eventId = parsePositiveInt(id);
  const at = time === '' ? null : Date.parse(time);
  if (eventId === undefined || Number.isNaN(eventId) || Number.isNaN(at)) {
    throw new BadRequest('before must be a nextBefore from an earlier page');
  }
  return { limit, before: { time: at, eventId } };
}

interface EventRow {
  event_id: number;
  title: string;
  expiry: Date | null;
  resolved: boolean;
  resolved_at: Date | null;
}

// History runs most recently resolved (or, unresolved, due) first; undated events last.
function historyTime(e: EventRow): number | null {
  const at = e.resolved_at ?? e.expiry;
  return at === null ? null : at.getTime();
}

function olderThan(e: EventRow, before: { time: number | null; eventId: number }): boolean {
  const time = historyTime(e);
  if (before.time === null) return time === null && e.event_id < before.eventId;
  return time === null || time < before.time || (time === before.time && e.event_id < before.eventId);
}

export async function events(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  const page = parseStatus(params);
  const holdings = await loadHoldings(client, params, now);
  const isHeld = (h: Holding) => h.position.netQuantity !== 0n;
  const traded = (await client.query(`
    SELECT l.listing_id, l.exchange_security_id, s.contract_type, ev.event_id
    FROM sm.listing l
    JOIN sm.security s ON s.security_id = l.security_id
    LEFT JOIN LATERAL (
      SELECT ec.event_id FROM sm.event_contract ec JOIN sm.event e ON e.event_id = ec.event_id
      WHERE ec.security_id = l.security_id AND e.exchange_id = l.exchange_id
      ORDER BY ec.event_id DESC LIMIT 1
    ) ev ON TRUE
    WHERE l.listing_id = ANY($1::int[])`, [holdings.map(h => h.listingId)])).rows;
  const contractOf = new Map(traded
    .filter(t => t.event_id !== null && (t.contract_type === BINARY || t.contract_type === MULTI_OUTCOME))
    .map(t => [t.listing_id as number, t]));

  // An event is active while any of its contracts is held, whatever became of the others.
  const activeIds = new Set(holdings.filter(isHeld).flatMap(h => contractOf.get(h.listingId)?.event_id ?? []));
  const historyIds = [...new Set(holdings.flatMap(h => contractOf.get(h.listingId)?.event_id ?? []))]
    .filter(id => !activeIds.has(id));
  const flatOther = holdings.filter(h => !isHeld(h) && !contractOf.has(h.listingId));

  let eventRows: EventRow[];
  let other: Holding[];
  let nextBefore: string | null = null;
  if (page === null) {
    eventRows = activeIds.size === 0 ? [] : (await client.query(
      `SELECT event_id, title, expiry, resolved, resolved_at FROM sm.event WHERE event_id = ANY($1::int[])
       ORDER BY expiry NULLS LAST, event_id`, [[...activeIds]])).rows;
    other = holdings.filter(h => isHeld(h) && !contractOf.has(h.listingId));
  } else {
    const all: EventRow[] = historyIds.length === 0 ? [] : (await client.query(
      `SELECT event_id, title, expiry, resolved, resolved_at FROM sm.event WHERE event_id = ANY($1::int[])
       ORDER BY COALESCE(resolved_at, expiry) DESC NULLS LAST, event_id DESC`, [historyIds])).rows;
    const before = page.before;
    eventRows = (before === null ? all : all.filter(e => olderThan(e, before))).slice(0, page.limit);
    if (eventRows.length === page.limit) {
      const last = eventRows[eventRows.length - 1];
      nextBefore = `${last.resolved_at?.toISOString() ?? last.expiry?.toISOString() ?? ''},${last.event_id}`;
    }
    other = before !== null ? [] : [...flatOther]
      .sort((a, b) => (b.lastFillAt?.getTime() ?? 0) - (a.lastFillAt?.getTime() ?? 0))
      .slice(0, page.limit);
  }

  const eventIds = eventRows.map(e => e.event_id);
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
  const outcomesOf = new Map<string, Contract[]>();
  for (const c of contracts) outcomesOf.set(c.marketKey, [...(outcomesOf.get(c.marketKey) ?? []), c]);

  const positions = new Map(holdings.map(h => [h.listingId, h]));
  const shown = new Set(eventIds);
  const marketsOf = new Map<number, Set<string>>();
  for (const h of holdings) {
    const t = contractOf.get(h.listingId);
    if (!t || !shown.has(t.event_id)) continue;
    const keys = marketsOf.get(t.event_id) ?? new Set<string>();
    marketsOf.set(t.event_id, keys.add(marketKey(t.contract_type, t.event_id, t.exchange_security_id)));
  }
  const info = await loadListingInfo(client, [
    ...contracts.flatMap(c => (c.listingId !== null && positions.has(c.listingId) ? [c.listingId] : [])),
    ...other.map(h => h.listingId),
  ]);

  const out = eventRows.map(e => {
    const markets = [...(marketsOf.get(e.event_id) ?? [])].map(key => {
      const outcomes = outcomesOf.get(key) ?? [];
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
    return { eventId: e.event_id, title: e.title, expiry: e.expiry, resolved: e.resolved, resolvedAt: e.resolved_at, markets };
  });

  return {
    asOf: now.toISOString(),
    events: out,
    other: other.map(h => heldRow(h, info.get(h.listingId))),
    counts: { active: activeIds.size, history: historyIds.length, flatOther: flatOther.length },
    nextBefore,
  };
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
