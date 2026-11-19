import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';
import { avgEntryPrice, MarkInputs, markPrice, notional, pnl, PositionState, PRICE_SCALE } from './ledger-math';
import { lifetimePnl, sessionPnl } from './pnl-math';
import {
  ListingInfo, loadListingInfo, loadSessionStates, loadStrategyState, SessionListingState, StrategyListingState,
} from './pnl-state';
import { PriceBand } from './price-bands';
import { closeRelation, Relation, RelationEdge } from './relation-closure';
import { BINARY, buildGroups, ContractFacts, EventOutcomes, Literal, MULTI_OUTCOME, strongest } from './risk-groups';
import { sameVoidRule, voidRule } from './void-rules';

// Prediction-market positions grouped by what offsets what, with what the group would be worth in every outcome.
// A group is the contracts the relationship rows, binary complements and multi-outcome events tie together
// (risk-groups.ts): the same match on three venues, a ladder of score thresholds, an event's outcomes. Contracts
// settle at $1 if true and $0 if not; each world is one way they can settle together, and its PnL is the group's PnL
// then: the strategy's lifetime PnL, for ?sessionId= the session's (from $0 at its start, as pnl-math defines it), or
// for ?firm=true every strategy's. Positions on listings that aren't event contracts (a perp hedge) pay the same in
// every world and are returned as they are, under `other`.
//   locked  the worst world: what the group makes however it settles, if the venues settle it alike. Contracts
//           already settled fix the worlds (risk-groups.ts): once one venue pays an outcome, its equivalents follow
//   divergent the worlds against what has settled, which happen only if a venue still open settles differently
//   void    added when the group's venues void markets differently (void-rules.ts), or a relationship between its
//           contracts is flagged VOID_RULES_DIFFER: every contract paid by its venue's void rule
//   worst   the lowest of locked, void and divergent
//   ?status=active (default)  groups with a contract still held, soonest to close first; a flat contract in the same
//                             group stays in it, since its realized PnL is part of the group's
//   ?status=history           groups with every contract flat, most recently resolved first, a page at a time:
//                             &limit= (default 50, max 200), &before=nextBefore. The first page also carries the
//                             newest flat other listings, up to limit. Not for ?firm=true.
// Both count the active groups, the flat contracts outside them (counting their groups would mean closing every
// contract ever traded) and the flat other listings, so a page can say what it hasn't loaded.

const DOLLAR = PRICE_SCALE;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

class BadRequest extends Error {}

const money = (value: bigint) => value.toString();
const min = (values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));
const max = (values: bigint[]) => values.reduce((a, b) => (b > a ? b : a));

// The lifetime PnL of a position if its contract settled at `settle`.
function settledPnl(position: PositionState, settle: bigint): bigint {
  const signedCost = position.netQuantity < 0n ? -position.totalCost : position.totalCost;
  return position.realizedPnl - position.totalFees + notional(settle, position.netQuantity) - signedCost;
}

// A position and how it's valued: now, and if its contract settled at a price.
interface Holding {
  strategyId: number;
  listingId: number;
  position: PositionState;
  mark: MarkInputs | null;
  lastFillAt: Date | null;
  total: () => bigint;
  settled: (settle: bigint) => bigint;
}

function strategyHolding(state: StrategyListingState): Holding {
  return {
    strategyId: state.strategyId,
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
    strategyId: state.strategyId,
    listingId: state.listingId,
    position: state.current,
    mark: state.mark,
    lastFillAt: state.lastFillAt,
    total: () => valued(state.mark).total,
    settled: settle => settledPnl(state.current, settle) - openingUnrealized,
  };
}

const isHeld = (h: Holding) => h.position.netQuantity !== 0n;

function newest(a: Date | null, b: Date | null): Date | null {
  if (a === null || b === null) return a ?? b;
  return a > b ? a : b;
}

// A listing a strategy holds on several venue accounts is one holding here: its outcomes are the same whichever
// account holds them, so the quantities add and each account's PnL is summed. Strategies stay apart.
function combineAccounts(holdings: Holding[]): Holding[] {
  const byKey = new Map<string, Holding>();
  for (const h of holdings) {
    const key = `${h.strategyId}:${h.listingId}`;
    const prior = byKey.get(key);
    byKey.set(key, prior === undefined ? h : {
      strategyId: h.strategyId,
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
  return [...byKey.values()];
}

interface Scope {
  firm: boolean;
  holdings: Holding[];
}

async function loadHoldings(client: PoolClient, params: Record<string, string | undefined>, now: Date): Promise<Scope> {
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new BadRequest('sessionId must be a session id');
    return { firm: false, holdings: (await loadSessionStates(client, [params.sessionId], now)).map(sessionHolding) };
  }
  let mode;
  try {
    mode = parseMode(params.mode);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
  if (params.firm === 'true') {
    if (!mode) throw new BadRequest('mode is required');
    return { firm: true, holdings: combineAccounts((await loadStrategyState(client, mode, null, now)).listings.map(strategyHolding)) };
  }
  const strategyId = parsePositiveInt(params.strategyId);
  if (strategyId === undefined || Number.isNaN(strategyId)) {
    throw new BadRequest('strategyId, sessionId or firm=true is required');
  }
  if (!mode) throw new BadRequest('mode is required');
  return { firm: false, holdings: combineAccounts((await loadStrategyState(client, mode, strategyId, now)).listings.map(strategyHolding)) };
}

interface Page {
  limit: number;
  before: { time: number | null; key: number } | null;
}

function parseStatus(params: Record<string, string | undefined>, firm: boolean): Page | null {
  const status = params.status ?? 'active';
  if (status === 'active') return null;
  if (status !== 'history') throw new BadRequest('status must be active or history');
  if (firm) throw new BadRequest('status=history is per strategy or session, not firm');
  const limit = parsePositiveInt(params.limit) ?? DEFAULT_HISTORY_LIMIT;
  if (Number.isNaN(limit) || limit > MAX_HISTORY_LIMIT) throw new BadRequest(`limit must be 1 to ${MAX_HISTORY_LIMIT}`);
  if (params.before === undefined) return { limit, before: null };
  if (!params.before.includes(',')) throw new BadRequest('before must be a nextBefore from an earlier page');
  const time = params.before.slice(0, params.before.lastIndexOf(','));
  const key = parsePositiveInt(params.before.split(',').pop());
  const at = time === '' ? null : Date.parse(time);
  if (key === undefined || Number.isNaN(key) || Number.isNaN(at)) {
    throw new BadRequest('before must be a nextBefore from an earlier page');
  }
  return { limit, before: { time: at, key } };
}

// A traded listing's contract: its event on the listing's own venue, and how it reads.
interface ListingContract {
  listingId: number;
  securityId: number;
  exchangeCode: string | null;
  contractType: number;
  eventId: number;
  title: string;
  outcome: string;
  expiry: Date | null;
  resolved: boolean;
  resolvedAt: Date | null;
}

async function loadContracts(client: PoolClient, listingIds: number[]): Promise<Map<number, ListingContract>> {
  if (listingIds.length === 0) return new Map();
  const rows = (await client.query(`
    SELECT l.listing_id, l.security_id, x.exchange_code, s.contract_type, ev.event_id, ev.title, ev.outcome_label,
      ev.expiry, ev.resolved, ev.resolved_at
    FROM sm.listing l
    JOIN sm.security s ON s.security_id = l.security_id
    LEFT JOIN sm.exchange x ON x.exchange_id = l.exchange_id
    JOIN LATERAL (
      SELECT ec.event_id, ec.outcome_label, e.title, e.expiry, e.resolved, e.resolved_at
      FROM sm.event_contract ec JOIN sm.event e ON e.event_id = ec.event_id
      WHERE ec.security_id = l.security_id AND e.exchange_id = l.exchange_id
      ORDER BY ec.event_id DESC LIMIT 1
    ) ev ON TRUE
    WHERE l.listing_id = ANY($1::int[]) AND s.contract_type = ANY($2::int[])`,
  [listingIds, [BINARY, MULTI_OUTCOME]])).rows;
  return new Map(rows.map(r => [r.listing_id as number, {
    listingId: r.listing_id, securityId: r.security_id, exchangeCode: r.exchange_code, contractType: r.contract_type,
    eventId: r.event_id, title: r.title, outcome: r.outcome_label, expiry: r.expiry, resolved: r.resolved,
    resolvedAt: r.resolved_at,
  }]));
}

interface RelationInputs {
  rel: Relation;
  facts: Map<number, ContractFacts>;
  outcomes: EventOutcomes;
  reached: Set<number>;
}

// Every security connected to the seeds through relationship rows and binary complements, the rows among them closed
// into the full relation, and the events constraining them. The reach is walked first and everything else is read by
// id: joined into one statement, the planner can't size the recursion and scans the security master.
async function loadRelation(client: PoolClient, seeds: number[]): Promise<RelationInputs> {
  if (seeds.length === 0) return { rel: new Map(), facts: new Map(), outcomes: new Map(), reached: new Set() };
  const complementOf = (column: string) => `(
    SELECT o.security_id FROM sm.event_contract ec
    JOIN sm.event_contract o ON o.event_id = ec.event_id AND o.security_id <> ec.security_id
    JOIN sm.security s ON s.security_id = ec.security_id AND s.contract_type = ${BINARY}
    JOIN sm.security so ON so.security_id = o.security_id AND so.contract_type = ${BINARY}
    WHERE ec.security_id = ${column}
      AND (SELECT count(*) FROM sm.event_contract n WHERE n.event_id = ec.event_id) = 2
    LIMIT 1)`;
  const reached: number[] = (await client.query(`
    WITH RECURSIVE reach(security_id) AS (
      SELECT unnest($1::int[])
      UNION
      SELECT n.security_id FROM reach CROSS JOIN LATERAL (
        SELECT r.security_id_b AS security_id FROM sm.contract_relationship r WHERE r.security_id_a = reach.security_id
        UNION ALL
        SELECT r.security_id_a FROM sm.contract_relationship r WHERE r.security_id_b = reach.security_id
        UNION ALL
        SELECT ${complementOf('reach.security_id')} AS security_id
      ) n
      WHERE n.security_id IS NOT NULL
    )
    SELECT security_id FROM reach`, [seeds])).rows.map(r => r.security_id);

  const edges: RelationEdge[] = (await client.query(`
    SELECT security_id_a, security_id_b, relationship_type, flags FROM sm.contract_relationship
    WHERE security_id_a = ANY($1::int[])`, [reached])).rows.map(r => ({
    securityIdA: r.security_id_a, securityIdB: r.security_id_b, relationshipType: r.relationship_type, flags: r.flags ?? [],
  }));

  const members = (await client.query(`
    SELECT ec.event_id, ec.security_id, s.contract_type, ec.settlement_price FROM sm.event_contract ec
    JOIN sm.security s ON s.security_id = ec.security_id
    WHERE ec.event_id IN (SELECT event_id FROM sm.event_contract WHERE security_id = ANY($1::int[]))`,
  [reached])).rows;
  const byEvent = new Map<number, { securityId: number; contractType: number; settlement: bigint | null }[]>();
  for (const m of members) {
    byEvent.set(m.event_id, [...(byEvent.get(m.event_id) ?? []), {
      securityId: m.security_id, contractType: m.contract_type,
      settlement: m.settlement_price === null ? null : BigInt(m.settlement_price),
    }]);
  }
  const facts = new Map<number, ContractFacts>();
  const outcomes: EventOutcomes = new Map();
  for (const [eventId, contracts] of byEvent) {
    const binaryPair = contracts.length === 2 && contracts.every(c => c.contractType === BINARY);
    for (const c of contracts) {
      const other = binaryPair ? contracts.find(o => o.securityId !== c.securityId)?.securityId ?? null : null;
      facts.set(c.securityId, {
        securityId: c.securityId, eventId, contractType: c.contractType, complement: other, settlement: c.settlement,
      });
    }
    if (contracts.some(c => c.contractType === MULTI_OUTCOME)) {
      outcomes.set(eventId, contracts.filter(c => c.contractType === MULTI_OUTCOME).map(c => c.securityId));
    }
  }
  const complements = new Map<number, number>();
  for (const f of facts.values()) if (f.complement !== null) complements.set(f.securityId, f.complement);
  return { rel: closeRelation(edges, complements), facts, outcomes, reached: new Set(reached) };
}

interface Leg {
  holding: Holding;
  contract: ListingContract;
}

interface HeldRow {
  listingId: number;
  symbol: string | null;
  exchangeId: number | null;
  priceBands: PriceBand[] | null;
  lotSize: string | null;
  netQuantity: string;
  avgEntryPrice: string;
  markPrice: string | null;
  unrealized: string;
  total: string;
}

function heldRow(holding: Holding, info: ListingInfo | undefined): HeldRow {
  return {
    listingId: holding.listingId,
    symbol: info?.symbol ?? null,
    exchangeId: info?.exchangeId ?? null,
    priceBands: info?.priceBands ?? null,
    lotSize: info?.lotSize ?? null,
    netQuantity: holding.position.netQuantity.toString(),
    avgEntryPrice: avgEntryPrice(holding.position).toString(),
    markPrice: markPrice(holding.mark)?.toString() ?? null,
    unrealized: money(pnl(holding.position, holding.mark).unrealizedPnl),
    total: money(holding.total()),
  };
}

// How a contract reads on its own: a named outcome as itself, a yes/no contract as its event's question.
function contractLabel(c: ListingContract): { text: string; named: boolean } {
  const outcome = (c.outcome ?? '').trim();
  if (/^yes$/i.test(outcome)) return { text: c.title, named: false };
  if (/^no$/i.test(outcome)) return { text: `Not: ${c.title}`, named: false };
  return { text: outcome || c.title, named: true };
}

// A world named by its most specific literals, each set of equivalent ones by one name (a named outcome first).
function worldLabel(
  rel: Relation, facts: Map<number, ContractFacts>, ids: number[], world: Set<number>,
  labels: Map<number, { text: string; named: boolean }>,
): string {
  const name = (lit: Literal) => {
    const label = labels.get(lit.securityId) ?? { text: `#${lit.securityId}`, named: false };
    if (lit.holds) return label;
    return { text: label.text.startsWith('Not: ') ? label.text.slice(5) : `Not: ${label.text}`, named: label.named };
  };
  return strongest(rel, facts, ids, world)
    .map(set => set.map(name).sort((a, b) => Number(b.named) - Number(a.named))[0].text)
    .join(' · ');
}

function groupTime(legs: Leg[]): number | null {
  const times = legs.map(l => (l.contract.resolvedAt ?? l.contract.expiry)?.getTime() ?? null).filter((t): t is number => t !== null);
  return times.length ? Math.max(...times) : null;
}

function olderThan(time: number | null, key: number, before: { time: number | null; key: number }): boolean {
  if (before.time === null) return time === null && key < before.key;
  return time === null || time < before.time || (time === before.time && key < before.key);
}

function valueGroup(
  key: number, legs: Leg[], worlds: Set<number>[], divergentWorlds: Set<number>[], tooLarge: boolean, flags: string[],
  rel: Relation, facts: Map<number, ContractFacts>, info: Map<number, ListingInfo>, firm: boolean,
) {
  const sorted = [...legs].sort((a, b) =>
    (a.contract.expiry?.getTime() ?? Infinity) - (b.contract.expiry?.getTime() ?? Infinity)
    || a.contract.eventId - b.contract.eventId || a.holding.listingId - b.holding.listingId
    || a.holding.strategyId - b.holding.strategyId);
  const labels = new Map(sorted.map(l => [l.contract.securityId, contractLabel(l.contract)]));
  const current = sorted.reduce((sum, l) => sum + l.holding.total(), 0n);
  const valueOf = (world: Set<number>) => {
    const value = sorted.reduce((sum, l) => sum + l.holding.settled(world.has(l.contract.securityId) ? DOLLAR : 0n), 0n);
    const paying = sorted.reduce((sum, l) => sum + (world.has(l.contract.securityId) ? l.holding.position.netQuantity : 0n), 0n);
    return { world, value, paying };
  };
  const valued = worlds.map(valueOf);
  const diverging = divergentWorlds.map(valueOf);

  const rules = sorted.map(l => voidRule(l.contract.exchangeCode));
  const rulesDiffer = rules.some(r => !sameVoidRule(r, rules[0]));
  const voidValue = rulesDiffer || flags.includes('VOID_RULES_DIFFER')
    ? sorted.reduce((sum, l, i) => {
      const rule = rules[i];
      const mark = markPrice(l.holding.mark);
      if (rule?.kind === 'FIXED') return sum + l.holding.settled(rule.price);
      return sum + (mark === null ? l.holding.total() : l.holding.settled(mark));
    }, 0n)
    : null;

  const values = valued.map(v => v.value);
  const locked = values.length ? min(values) : null;
  const risks = [...values, ...diverging.map(v => v.value), ...(voidValue === null ? [] : [voidValue])];
  const worst = locked === null ? null : min(risks);
  const payingCounts = valued.map(v => v.paying);
  const rows = (list: typeof valued) => list
    .map(v => ({
      label: worldLabel(rel, facts, [...labels.keys()], v.world, labels),
      paysListingIds: sorted.filter(l => v.world.has(l.contract.securityId)).map(l => l.holding.listingId),
      pnl: money(v.value),
      change: money(v.value - current),
      paying: v.paying.toString(),
    }))
    .sort((a, b) => (BigInt(a.pnl) < BigInt(b.pnl) ? -1 : BigInt(a.pnl) > BigInt(b.pnl) ? 1 : a.label.localeCompare(b.label)));
  const first = sorted[0].contract;
  return {
    key,
    title: first.title,
    expiry: sorted.map(l => l.contract.expiry).filter((d): d is Date => d !== null)
      .reduce<Date | null>((a, b) => (a === null || b < a ? b : a), null),
    resolved: sorted.every(l => l.contract.resolved),
    resolvedAt: sorted.map(l => l.contract.resolvedAt).reduce<Date | null>(newest, null),
    exchangeIds: [...new Set(sorted.map(l => info.get(l.holding.listingId)?.exchangeId ?? null))].filter(x => x !== null),
    strategyIds: firm ? [...new Set(sorted.map(l => l.holding.strategyId))].sort((a, b) => a - b) : undefined,
    legs: sorted.map(l => ({
      strategyId: l.holding.strategyId,
      eventId: l.contract.eventId,
      eventTitle: l.contract.title,
      outcome: labels.get(l.contract.securityId)?.text ?? l.contract.outcome,
      settlementPrice: facts.get(l.contract.securityId)?.settlement?.toString() ?? null,
      held: heldRow(l.holding, info.get(l.holding.listingId)),
    })),
    current: money(current),
    worlds: rows(valued),
    divergent: rows(diverging),
    void: voidValue === null ? null : { pnl: money(voidValue), change: money(voidValue - current) },
    locked: locked === null ? null : money(locked),
    worst: worst === null ? null : money(worst),
    best: values.length ? money(max(values)) : null,
    gap: payingCounts.length ? (max(payingCounts) - min(payingCounts)).toString() : null,
    flags,
    tooLarge,
  };
}

export async function groups(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  const { firm, holdings } = await loadHoldings(client, params, now);
  const page = parseStatus(params, firm);
  const contracts = await loadContracts(client, [...new Set(holdings.map(h => h.listingId))]);
  const legsAll: Leg[] = holdings.flatMap(h => {
    const contract = contracts.get(h.listingId);
    return contract ? [{ holding: h, contract }] : [];
  });
  const heldSecurities = [...new Set(legsAll.filter(l => isHeld(l.holding)).map(l => l.contract.securityId))];
  const flatOther = holdings.filter(h => !isHeld(h) && !contracts.has(h.listingId));

  // Active groups need only what the held contracts reach; history groups need every traded contract's.
  const seeds = page === null ? heldSecurities : [...new Set(legsAll.map(l => l.contract.securityId))];
  const { rel, facts, outcomes, reached } = await loadRelation(client, seeds);
  const legs = page === null ? legsAll.filter(l => reached.has(l.contract.securityId)) : legsAll;
  const built = buildGroups(legs.map(l => l.contract.securityId), rel, facts, outcomes)
    .map(g => {
      const inGroup = new Set(g.securityIds);
      return { ...g, key: g.securityIds[0], legs: legs.filter(l => inGroup.has(l.contract.securityId)) };
    });
  const active = built.filter(g => g.legs.some(l => isHeld(l.holding)));
  const inActive = new Set(active.flatMap(g => g.legs.map(l => l.contract.securityId)));
  const flatContracts = new Set(legsAll.filter(l => !inActive.has(l.contract.securityId)).map(l => l.contract.securityId)).size;

  let shown: typeof built;
  let other: Holding[];
  let nextBefore: string | null = null;
  if (page === null) {
    shown = active.sort((a, b) => {
      const ea = Math.min(...a.legs.map(l => l.contract.expiry?.getTime() ?? Infinity));
      const eb = Math.min(...b.legs.map(l => l.contract.expiry?.getTime() ?? Infinity));
      return ea - eb || a.key - b.key;
    });
    other = holdings.filter(h => isHeld(h) && !contracts.has(h.listingId));
  } else {
    const before = page.before;
    const history = built.filter(g => !g.legs.some(l => isHeld(l.holding)))
      .map(g => ({ g, time: groupTime(g.legs) }))
      .sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity) || b.g.key - a.g.key)
      .filter(x => before === null || olderThan(x.time, x.g.key, before));
    shown = history.slice(0, page.limit).map(x => x.g);
    if (shown.length === page.limit) {
      const last = history[page.limit - 1];
      nextBefore = `${last.time === null ? '' : new Date(last.time).toISOString()},${last.g.key}`;
    }
    other = before !== null ? [] : [...flatOther]
      .sort((a, b) => (b.lastFillAt?.getTime() ?? 0) - (a.lastFillAt?.getTime() ?? 0))
      .slice(0, page.limit);
  }

  const info = await loadListingInfo(client, [
    ...new Set([...shown.flatMap(g => g.legs.map(l => l.holding.listingId)), ...other.map(h => h.listingId)]),
  ]);
  return {
    asOf: now.toISOString(),
    groups: shown.map(g => valueGroup(g.key, g.legs, g.worlds, g.divergent, g.tooLarge, g.flags, rel, facts, info, firm)),
    other: other.map(h => ({ strategyId: h.strategyId, ...heldRow(h, info.get(h.listingId)) })),
    counts: { active: active.length, flatContracts, flatOther: flatOther.length },
    nextBefore,
  };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, await groups(client, event.queryStringParameters ?? {}, new Date()));
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    console.error('PnL groups error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
