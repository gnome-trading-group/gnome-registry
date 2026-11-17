import { implies, Relation } from './relation-closure';

// Which held contracts offset each other, and the outcomes they can settle into together.
//
// Each contract is a proposition that is true (pays $1) or false (pays $0). The relation (relation-closure.ts) and the
// events' contract types constrain them:
//   a ⇒ b                 a row or route says so; with complements, a ⇒ not-b and not-a ⇒ b too
//   a xor its complement  a BINARY event's two contracts
//   at most one           the outcomes of a MULTI_OUTCOME event (exactly one when every outcome is present)
// A group is a set of contracts joined by any constraint; a world is one assignment that breaks none. Only
// constraints the rows state are known: a missing one adds worlds that can't happen, so a group's worst world is never
// better than the truth.

export const BINARY = 7;
export const MULTI_OUTCOME = 8;
// Above this many contracts a group isn't enumerated (2^n assignments); the largest held in prod was 7 (2026-11-17).
export const MAX_GROUP_CONTRACTS = 20;

export interface ContractFacts {
  securityId: number;
  eventId: number | null;
  contractType: number;
  // The other contract of a two-contract BINARY event.
  complement: number | null;
}

// Every outcome of each MULTI_OUTCOME event that touches the contracts, by event.
export type EventOutcomes = Map<number, number[]>;

type Clause = [number, boolean, number, boolean];

export interface Group {
  securityIds: number[];
  tooLarge: boolean;
  // Each world: the contracts true in it. Empty when tooLarge.
  worlds: Set<number>[];
  // Flags of the relationships between the group's contracts, deduplicated.
  flags: string[];
}

function equivalent(rel: Relation, a: number, b: number): boolean {
  return a === b || (implies(rel, a, b) !== undefined && implies(rel, b, a) !== undefined);
}

// The constraints between two contracts as clauses (x is xTrue, or y is yTrue).
function pairClauses(rel: Relation, facts: Map<number, ContractFacts>, u: number, v: number): Clause[] {
  const out: Clause[] = [];
  const cu = facts.get(u)?.complement ?? null;
  const cv = facts.get(v)?.complement ?? null;
  if (cu === v) return [[u, true, v, true], [u, false, v, false]];
  if (implies(rel, u, v) !== undefined) out.push([u, false, v, true]);
  if (implies(rel, v, u) !== undefined) out.push([v, false, u, true]);
  if (cv !== null && implies(rel, u, cv) !== undefined) out.push([u, false, v, false]);
  if (cu !== null && implies(rel, cu, v) !== undefined) out.push([u, true, v, true]);
  return out;
}

function pairFlags(rel: Relation, u: number, v: number): string[] {
  return [...(implies(rel, u, v) ?? []), ...(implies(rel, v, u) ?? [])];
}

interface Choice {
  members: number[][];
  exactlyOne: boolean;
}

// The MULTI_OUTCOME events constraining the contracts: per event, the contracts standing for each of its outcomes.
function choices(rel: Relation, ids: Set<number>, outcomes: EventOutcomes): Choice[] {
  const out: Choice[] = [];
  for (const members of outcomes.values()) {
    const present = members
      .map(m => [m, ...(rel.get(m)?.keys() ?? [])].filter(v => ids.has(v) && equivalent(rel, v, m)))
      .filter(s => s.length > 0);
    if (present.length < 2) continue;
    out.push({ members: present, exactlyOne: present.length === members.length });
  }
  return out;
}

// The contracts that may share a constraint with u: what u or its complement implies, and their complements. A pair
// is found from at least one of its two sides.
function candidates(rel: Relation, facts: Map<number, ContractFacts>, u: number): Set<number> {
  const out = new Set<number>();
  const cu = facts.get(u)?.complement ?? null;
  if (cu !== null) out.add(cu);
  for (const x of rel.get(u)?.keys() ?? []) {
    out.add(x);
    const cx = facts.get(x)?.complement ?? null;
    if (cx !== null) out.add(cx);
  }
  if (cu !== null) for (const x of rel.get(cu)?.keys() ?? []) out.add(x);
  return out;
}

class UnionFind {
  private readonly parent = new Map<number, number>();

  find(x: number): number {
    let root = this.parent.get(x) ?? x;
    while (root !== (this.parent.get(root) ?? root)) root = this.parent.get(root) ?? root;
    this.parent.set(x, root);
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function enumerate(ids: number[], clauses: Clause[], groupChoices: Choice[]): Set<number>[] {
  const position = new Map(ids.map((id, i) => [id, i]));
  // Each clause is checked once both its contracts are assigned: at the later of the two.
  const due: Clause[][] = ids.map(() => []);
  for (const c of clauses) due[Math.max(position.get(c[0]) as number, position.get(c[2]) as number)].push(c);
  const value: boolean[] = new Array(ids.length).fill(false);
  const worlds: Set<number>[] = [];
  let assigned = 0;
  // Equivalent contracts stand for one outcome together (their clauses keep them equal), so one of them is read.
  const choiceOk = (complete: boolean) => groupChoices.every(ch => {
    let trueCount = 0;
    for (const standing of ch.members) {
      const i = position.get(standing[0]) as number;
      if (i < assigned && value[i]) trueCount++;
    }
    return trueCount <= 1 && !(complete && ch.exactlyOne && trueCount !== 1);
  });
  const walk = (i: number) => {
    if (i === ids.length) {
      if (choiceOk(true)) worlds.push(new Set(ids.filter((_, k) => value[k])));
      return;
    }
    for (const v of [true, false]) {
      value[i] = v;
      assigned = i + 1;
      const ok = due[i].every(([x, xt, y, yt]) =>
        value[position.get(x) as number] === xt || value[position.get(y) as number] === yt);
      if (ok && choiceOk(false)) walk(i + 1);
    }
    assigned = i;
  };
  walk(0);
  return worlds;
}

// The groups the contracts form, each with its worlds.
export function buildGroups(
  securityIds: number[], rel: Relation, facts: Map<number, ContractFacts>, outcomes: EventOutcomes,
): Group[] {
  const ids = [...new Set(securityIds)].sort((a, b) => a - b);
  const uf = new UnionFind();
  const clauses: Clause[] = [];
  const flags = new Map<number, Set<string>>();
  const idSet = new Set(ids);
  const seen = new Set<string>();
  for (const u of ids) {
    for (const v of candidates(rel, facts, u)) {
      if (!idSet.has(v) || v === u) continue;
      const [a, b] = u < v ? [u, v] : [v, u];
      const key = `${a},${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = pairClauses(rel, facts, a, b);
      if (found.length === 0) continue;
      clauses.push(...found);
      uf.union(a, b);
      const fs = pairFlags(rel, a, b);
      if (fs.length) flags.set(a, new Set([...(flags.get(a) ?? []), ...fs]));
    }
  }
  const allChoices = choices(rel, idSet, outcomes);
  for (const ch of allChoices) {
    const flat = ch.members.flat();
    for (const v of flat.slice(1)) uf.union(flat[0], v);
  }
  const members = new Map<number, number[]>();
  for (const id of ids) members.set(uf.find(id), [...(members.get(uf.find(id)) ?? []), id]);

  return [...members.values()].map(group => {
    const inGroup = new Set(group);
    const groupFlags = new Set<string>();
    for (const [id, fs] of flags) if (inGroup.has(id)) fs.forEach(f => groupFlags.add(f));
    const tooLarge = group.length > MAX_GROUP_CONTRACTS;
    const groupClauses = clauses.filter(c => inGroup.has(c[0]));
    const groupChoices = allChoices.filter(ch => inGroup.has(ch.members[0][0]));
    return {
      securityIds: group,
      tooLarge,
      worlds: tooLarge ? [] : enumerate(group, groupClauses, groupChoices),
      flags: [...groupFlags].sort(),
    };
  });
}

// A contract as true or false in a world.
export interface Literal {
  securityId: number;
  holds: boolean;
}

// Whether one literal implies another, through the relation, binary complements and a multi-outcome event's
// exclusivity (one outcome winning means each other one didn't).
export function literalImplies(rel: Relation, facts: Map<number, ContractFacts>, x: Literal, y: Literal): boolean {
  const fx = facts.get(x.securityId);
  const fy = facts.get(y.securityId);
  if (x.holds && !y.holds && x.securityId !== y.securityId && fx?.contractType === MULTI_OUTCOME
    && fy?.contractType === MULTI_OUTCOME && fx.eventId === fy.eventId) return true;
  const cx = facts.get(x.securityId)?.complement ?? null;
  const cy = facts.get(y.securityId)?.complement ?? null;
  if (x.holds && y.holds) return implies(rel, x.securityId, y.securityId) !== undefined;
  if (x.holds) return cy === x.securityId || (cy !== null && implies(rel, x.securityId, cy) !== undefined);
  if (y.holds) return cx === y.securityId || (cx !== null && implies(rel, cx, y.securityId) !== undefined);
  return implies(rel, y.securityId, x.securityId) !== undefined;
}

// What a world is, at its most specific: its literals that no other literal of it implies, one of each equivalent set.
export function strongest(rel: Relation, facts: Map<number, ContractFacts>, ids: number[], world: Set<number>): Literal[][] {
  const literals = ids.map(id => ({ securityId: id, holds: world.has(id) }));
  const strict = (x: Literal, y: Literal) => literalImplies(rel, facts, x, y) && !literalImplies(rel, facts, y, x);
  const top = literals.filter(y => !literals.some(x => x !== y && strict(x, y)));
  const sets: Literal[][] = [];
  for (const lit of top) {
    const same = sets.find(set => literalImplies(rel, facts, set[0], lit) && literalImplies(rel, facts, lit, set[0]));
    if (same) same.push(lit);
    else sets.push([lit]);
  }
  return sets;
}
