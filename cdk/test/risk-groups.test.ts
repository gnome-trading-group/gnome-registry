import { closeRelation, RelationEdge } from '../lambda/endpoints/relation-closure';
import { BINARY, buildGroups, ContractFacts, EventOutcomes, MULTI_OUTCOME, strongest } from '../lambda/endpoints/risk-groups';

const eq = (a: number, b: number, flags: string[] = []): RelationEdge =>
  ({ securityIdA: a, securityIdB: b, relationshipType: 'EQUIVALENT', flags });
const imp = (a: number, b: number): RelationEdge => ({ securityIdA: a, securityIdB: b, relationshipType: 'IMPLIES', flags: [] });

const DOLLAR = 1_000_000_000n;

// Binary pairs (a, b) on one event each, and the rest as given; settled maps a contract to what it settled at.
function facts(pairs: [number, number][], multi: Record<number, number[]> = {}, settled: Record<number, bigint> = {}) {
  const out = new Map<number, ContractFacts>();
  const settlement = (id: number) => settled[id] ?? null;
  pairs.forEach(([a, b], i) => {
    out.set(a, { securityId: a, eventId: 100 + i, contractType: BINARY, complement: b, settlement: settlement(a) });
    out.set(b, { securityId: b, eventId: 100 + i, contractType: BINARY, complement: a, settlement: settlement(b) });
  });
  const outcomes: EventOutcomes = new Map();
  for (const [eventId, members] of Object.entries(multi)) {
    outcomes.set(Number(eventId), members);
    for (const m of members) {
      out.set(m, { securityId: m, eventId: Number(eventId), contractType: MULTI_OUTCOME, complement: null, settlement: settlement(m) });
    }
  }
  const complements = new Map<number, number>();
  for (const f of out.values()) if (f.complement !== null) complements.set(f.securityId, f.complement);
  return { facts: out, outcomes, complements };
}

const worldsOf = (worlds: Set<number>[]) => worlds.map(w => [...w].sort((a, b) => a - b)).sort();

describe('risk groups', () => {
  it('joins a match across venues: long team A on one, NO on team A on the other, two worlds', () => {
    // PM Intl tokens A=1/B=2, Kalshi "A wins" yes=3/no=4, and A on PM ≡ yes on Kalshi.
    const f = facts([[1, 2], [3, 4]]);
    const rel = closeRelation([eq(1, 3)], f.complements);
    const groups = buildGroups([1, 4], rel, f.facts, f.outcomes);
    expect(groups).toHaveLength(1);
    expect(worldsOf(groups[0].worlds)).toEqual([[1], [4]]);
  });

  it('enumerates a threshold ladder: n strikes give n + 1 worlds', () => {
    // Score > 70 (3) ⇒ > 60 (2) ⇒ > 50 (1).
    const f = facts([]);
    const rel = closeRelation([imp(3, 2), imp(2, 1)], f.complements);
    const [group] = buildGroups([1, 2, 3], rel, f.facts, f.outcomes);
    expect(worldsOf(group.worlds)).toEqual([[], [1], [1, 2], [1, 2, 3]]);
    // Above 60 and not above 70: both literals are needed to say so.
    expect(strongest(rel, f.facts, [1, 2, 3], new Set([1, 2]))).toEqual([
      [{ securityId: 2, holds: true }], [{ securityId: 3, holds: false }],
    ]);
  });

  it('lets at most one outcome of a multi-outcome event win, and exactly one when all are held', () => {
    const f = facts([], { 9: [5, 6, 7] });
    const rel = closeRelation([], f.complements);
    expect(worldsOf(buildGroups([5, 6], rel, f.facts, f.outcomes)[0].worlds)).toEqual([[], [5], [6]]);
    expect(worldsOf(buildGroups([5, 6, 7], rel, f.facts, f.outcomes)[0].worlds)).toEqual([[5], [6], [7]]);
  });

  it('carries a multi-outcome event to equivalent contracts on another venue', () => {
    // 8 (another venue) ≡ outcome 5; holding 8 and outcome 6 means they can't both win.
    const f = facts([], { 9: [5, 6, 7] });
    const rel = closeRelation([eq(8, 5)], f.complements);
    const groups = buildGroups([6, 8], rel, f.facts, f.outcomes);
    expect(groups).toHaveLength(1);
    expect(worldsOf(groups[0].worlds)).toEqual([[], [6], [8]]);
  });

  it('keeps unrelated contracts apart and reports the flags joining a group', () => {
    const f = facts([[1, 2], [3, 4], [10, 11]]);
    const rel = closeRelation([eq(1, 3, ['VOID_RULES_DIFFER'])], f.complements);
    const groups = buildGroups([1, 3, 10], rel, f.facts, f.outcomes);
    expect(groups.map(g => g.securityIds)).toEqual([[1, 3], [10]]);
    expect(groups[0].flags).toEqual(['VOID_RULES_DIFFER']);
    expect(worldsOf(groups[0].worlds)).toEqual([[], [1, 3]]);
  });

  it('fixes the worlds by what has settled elsewhere, and splits off the rest as divergent', () => {
    // Falcons vs JUMBO: Polymarket Intl tokens 1 (Falcons) / 2 (JUMBO), still open; Kalshi's two-outcome event,
    // 5 (JUMBO) paid and 6 (Falcons) not. The strategy holds only the Polymarket tokens now.
    const f = facts([[1, 2]], { 9: [5, 6] }, { 5: DOLLAR, 6: 0n });
    const rel = closeRelation([eq(1, 6), eq(2, 5)], f.complements);
    const [group] = buildGroups([1, 2], rel, f.facts, f.outcomes);
    expect(worldsOf(group.worlds)).toEqual([[2]]);
    expect(worldsOf(group.divergent)).toEqual([[1]]);
  });

  it('decides nothing from a fractional settlement or from venues that already disagree', () => {
    const fraction = facts([[1, 2], [3, 4]], {}, { 3: 460_000_000n, 4: 540_000_000n });
    const [half] = buildGroups([1, 2], closeRelation([eq(1, 3)], fraction.complements), fraction.facts, fraction.outcomes);
    expect([worldsOf(half.worlds), half.divergent, half.flags]).toEqual([[[1], [2]], [], ['SETTLED_AT_FRACTION']]);

    // Venue A paid 3, venue B paid 6's complement; 3 ≡ 6, so they disagree.
    const split = facts([[1, 2], [3, 4], [5, 6]], {}, { 3: DOLLAR, 4: 0n, 5: DOLLAR, 6: 0n });
    const rel = closeRelation([eq(1, 3), eq(1, 6)], split.complements);
    const [group] = buildGroups([1, 2], rel, split.facts, split.outcomes);
    expect([worldsOf(group.worlds), group.flags]).toEqual([[[1], [2]], ['SETTLED_DIFFERENTLY']]);
  });

  it("doesn't enumerate a group past the cap", () => {
    const ids = Array.from({ length: 22 }, (_, i) => i + 1);
    const f = facts([]);
    const rel = closeRelation(ids.slice(1).map(i => imp(i, i - 1)), f.complements);
    const [group] = buildGroups(ids, rel, f.facts, f.outcomes);
    expect(group.tooLarge).toBe(true);
    expect(group.worlds).toEqual([]);
  });
});
