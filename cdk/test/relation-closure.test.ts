import { readFileSync } from 'fs';
import { join } from 'path';
import { closeRelation, implies, Relation, RelationEdge } from '../lambda/endpoints/relation-closure';

interface ClosureCase {
  edges: RelationEdge[];
  complements: [number, number][];
  relation: [number, number, string[]][];
}

// Every pair of a relation, as gnomepy writes them: [a, b, flags], sorted.
function pairs(rel: Relation): [number, number, string[]][] {
  const out: [number, number, string[]][] = [];
  for (const [a, row] of rel) for (const [b, flags] of row) out.push([a, b, flags]);
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

function close(edges: RelationEdge[], complements: [number, number][] = []): Relation {
  return closeRelation(edges, new Map(complements));
}

const eq = (a: number, b: number, flags: string[] = []): RelationEdge =>
  ({ securityIdA: a, securityIdB: b, relationshipType: 'EQUIVALENT', flags });
const imp = (a: number, b: number, flags: string[] = []): RelationEdge =>
  ({ securityIdA: a, securityIdB: b, relationshipType: 'IMPLIES', flags });

describe('relation closure', () => {
  it('matches gnomepy on prod rows: a Rotten Tomatoes ladder, esports matches and flagged rows', () => {
    // Written by gnomepy's relations.close over the connected rows of held prod securities (2026-11-17).
    const fixture: ClosureCase = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'relation-closure.json'), 'utf8'));
    const rel = close(fixture.edges, fixture.complements);
    expect(pairs(rel)).toEqual(fixture.relation);
  });

  it('chains implications and reverses them through complements', () => {
    // 1 ⇒ 2 ⇒ 3, with complements 1/11, 2/12, 3/13.
    const rel = close([imp(1, 2), imp(2, 3)], [[1, 11], [11, 1], [2, 12], [12, 2], [3, 13], [13, 3]]);
    expect(implies(rel, 1, 3)).toEqual([]);
    expect(implies(rel, 13, 11)).toEqual([]);
    expect(implies(rel, 3, 1)).toBeUndefined();
  });

  it('composes a flagged row only with unflagged paths, keeping its flags', () => {
    const rel = close([eq(1, 2), eq(2, 3, ['VOID_RULES_DIFFER']), eq(3, 4), eq(4, 5, ['DEADLINE_DIFFERS'])]);
    expect(implies(rel, 1, 4)).toEqual(['VOID_RULES_DIFFER']);
    expect(implies(rel, 3, 5)).toEqual(['DEADLINE_DIFFERS']);
    // Two flagged rows never compose.
    expect(implies(rel, 1, 5)).toBeUndefined();
  });

  it('takes the route with the fewest flags', () => {
    const rel = close([imp(1, 2, ['VOID_RULES_DIFFER']), imp(1, 3), imp(3, 2)]);
    expect(implies(rel, 1, 2)).toEqual([]);
  });
});
