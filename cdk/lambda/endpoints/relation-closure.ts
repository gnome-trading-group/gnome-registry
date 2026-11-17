// How stored relationship rows compose into the complete relation: a port of gnomepy's `registry/relations.close`,
// which the classifier and every Python consumer use, so the registry and they agree on what the rows mean. Both are
// checked against the same golden case (test/fixtures/relation-closure.json, written by gnomepy).
//
// 1. IMPLIES is transitive; EQUIVALENT is IMPLIES both ways.
// 2. Contraposition through complements (a BINARY event's two securities): A ⇒ B gives not-B ⇒ not-A.
// 3. Unflagged rows compose freely.
// 4. A flagged row composes only with unflagged paths on either side, never with another flagged row, and the result
//    carries that row's flags.
// 5. A pair reachable several ways takes the route with the fewest flags (unflagged first).

export interface RelationEdge {
  securityIdA: number;
  securityIdB: number;
  relationshipType: 'EQUIVALENT' | 'IMPLIES';
  flags: string[];
}

// a ⇒ b, for a != b, to the flags of its best route.
export type Relation = Map<number, Map<number, string[]>>;

export function implies(rel: Relation, a: number, b: number): string[] | undefined {
  return rel.get(a)?.get(b);
}

function compareFlags(x: string[], y: string[]): number {
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

class Bits {
  readonly words: Uint32Array;

  constructor(size: number) {
    this.words = new Uint32Array((size + 31) >>> 5);
  }

  set(i: number): void {
    this.words[i >>> 5] |= 1 << (i & 31);
  }

  or(other: Bits): void {
    for (let w = 0; w < this.words.length; w++) this.words[w] |= other.words[w];
  }

  *each(): Generator<number> {
    for (let w = 0; w < this.words.length; w++) {
      let word = this.words[w];
      while (word !== 0) {
        const low = word & -word;
        yield (w << 5) + (31 - Math.clz32(low));
        word ^= low;
      }
    }
  }
}

const pairKey = (a: number, b: number) => `${a},${b}`;
const flaggedKey = (a: number, b: number, flags: string[]) => `${a},${b},${flags.join('|')}`;

interface Directed {
  unflagged: Map<string, [number, number]>;
  flagged: Map<string, [number, number, string[]]>;
}

function directed(edges: RelationEdge[], complements: Map<number, number>): Directed {
  const out: Directed = { unflagged: new Map(), flagged: new Map() };
  for (const e of edges) {
    const pairs: [number, number][] = [[e.securityIdA, e.securityIdB]];
    if (e.relationshipType === 'EQUIVALENT') pairs.push([e.securityIdB, e.securityIdA]);
    const flags = [...e.flags].sort();
    for (const [x, y] of pairs) {
      const both: [number, number][] = [[x, y]];
      const cx = complements.get(x);
      const cy = complements.get(y);
      if (cx !== undefined && cy !== undefined) both.push([cy, cx]);
      for (const [a, b] of both) {
        if (a === b) continue;
        if (flags.length) out.flagged.set(flaggedKey(a, b, flags), [a, b, flags]);
        else out.unflagged.set(pairKey(a, b), [a, b]);
      }
    }
  }
  return out;
}

// Equivalence classes of the nodes under directed reachability, and each class's descendants (itself included).
class Classes {
  readonly of = new Map<number, number>();
  readonly members: number[][] = [];
  readonly desc: Bits[] = [];

  constructor(nodes: number[], arcs: [number, number][]) {
    const sorted = [...new Set(nodes)].sort((a, b) => a - b);
    const succ = new Map<number, number[]>(sorted.map(n => [n, []]));
    for (const [a, b] of arcs) succ.get(a)?.push(b);
    // Iterative Tarjan: classes come out sinks first, so descendants are complete when a class is closed.
    const index = new Map<number, number>();
    const low = new Map<number, number>();
    const stack: number[] = [];
    const onStack = new Set<number>();
    let counter = 0;
    for (const root of sorted) {
      if (index.has(root)) continue;
      const work: [number, number][] = [[root, 0]];
      while (work.length) {
        const [node, i] = work.pop() as [number, number];
        if (i === 0) {
          index.set(node, counter);
          low.set(node, counter);
          counter++;
          stack.push(node);
          onStack.add(node);
        }
        let recurse = false;
        const next = succ.get(node) as number[];
        for (let j = i; j < next.length; j++) {
          const n = next[j];
          if (!index.has(n)) {
            work.push([node, j + 1]);
            work.push([n, 0]);
            recurse = true;
            break;
          }
          if (onStack.has(n)) low.set(node, Math.min(low.get(node) as number, index.get(n) as number));
        }
        if (recurse) continue;
        if (low.get(node) === index.get(node)) {
          const members: number[] = [];
          for (;;) {
            const m = stack.pop() as number;
            onStack.delete(m);
            this.of.set(m, this.members.length);
            members.push(m);
            if (m === node) break;
          }
          this.members.push(members.sort((a, b) => a - b));
        }
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent) as number, low.get(node) as number));
        }
      }
    }
    const size = this.members.length;
    const succClasses: Set<number>[] = this.members.map(() => new Set());
    for (const [a, b] of arcs) {
      const ca = this.of.get(a) as number;
      const cb = this.of.get(b) as number;
      if (ca !== cb) succClasses[ca].add(cb);
    }
    for (let c = 0; c < size; c++) {
      const mask = new Bits(size);
      mask.set(c);
      for (const d of succClasses[c]) mask.or(this.desc[d]);
      this.desc.push(mask);
    }
  }
}

function put(rel: Relation, a: number, b: number, flags: string[]): void {
  let row = rel.get(a);
  if (!row) rel.set(a, (row = new Map()));
  row.set(b, flags);
}

function compose(d: Directed): Relation {
  const unflagged = [...d.unflagged.values()];
  const flagged = [...d.flagged.values()];
  const nodes = [...unflagged.flat(), ...flagged.flatMap(([a, b]) => [a, b])];
  const classes = new Classes(nodes, unflagged);
  const rel: Relation = new Map();
  classes.members.forEach((members, c) => {
    for (const dc of classes.desc[c].each()) {
      for (const a of members) for (const b of classes.members[dc]) if (a !== b) put(rel, a, b, []);
    }
  });
  const byFlags = new Map<string, { flags: string[]; arcs: [number, number][] }>();
  for (const [a, b, flags] of flagged) {
    const key = flags.join('|');
    const entry = byFlags.get(key) ?? { flags, arcs: [] };
    entry.arcs.push([classes.of.get(a) as number, classes.of.get(b) as number]);
    byFlags.set(key, entry);
  }
  const size = classes.members.length;
  for (const { flags, arcs } of [...byFlags.values()].sort((x, y) => compareFlags(x.flags, y.flags))) {
    const seeded: Bits[] = classes.members.map(() => new Bits(size));
    for (const [ca, cb] of arcs) seeded[ca].or(classes.desc[cb]);
    classes.members.forEach((members, c) => {
      const reach = new Bits(size);
      for (const x of classes.desc[c].each()) reach.or(seeded[x]);
      for (const dc of reach.each()) {
        for (const a of members) {
          for (const b of classes.members[dc]) {
            if (a === b) continue;
            const prior = implies(rel, a, b);
            if (prior === undefined || compareFlags(flags, prior) < 0) put(rel, a, b, flags);
          }
        }
      }
    });
  }
  return rel;
}

// The complete relation the rows give under the rules above.
export function closeRelation(edges: RelationEdge[], complements: Map<number, number>): Relation {
  const d = directed(edges, complements);
  for (;;) {
    const rel = compose(d);
    // A composed pair has a contrapositive too, even when a security on its route has no complement; adding them can
    // open new routes, so compose again until nothing new appears.
    let grew = false;
    for (const [a, row] of rel) {
      const ca = complements.get(a);
      if (ca === undefined) continue;
      for (const [b, flags] of row) {
        const cb = complements.get(b);
        if (cb === undefined || cb === ca) continue;
        const prior = implies(rel, cb, ca);
        if (prior !== undefined && compareFlags(prior, flags) <= 0) continue;
        grew = true;
        if (flags.length) d.flagged.set(flaggedKey(cb, ca, flags), [cb, ca, flags]);
        else d.unflagged.set(pairKey(cb, ca), [cb, ca]);
      }
    }
    if (!grew) return rel;
  }
}
