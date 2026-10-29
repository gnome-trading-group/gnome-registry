import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse } from './ledger-common';
import { sql } from './sql';

// Shared by the proposition-subject, merge, proposition and relationship-reconcile routes: subjects, their merge
// chains, and the handler wrapper.

const MAX_ALIAS_DEPTH = 64;

export class PropositionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw new PropositionError(400, `${name} must be a positive integer`);
  }
  return value;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new PropositionError(400, `${name} is required`);
  return value;
}

export function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new PropositionError(400, `${name} must be an array of strings`);
  }
  return value;
}

/** The subject a merge chain ends at: the subject itself when it is not an alias. */
export async function canonicalSubject(client: PoolClient, subjectId: number): Promise<number> {
  const rows = (await client.query(sql`
    WITH RECURSIVE chain(subject_id, depth) AS (
      SELECT ${subjectId}::int, 0
      UNION ALL
      SELECT a.canonical_subject_id, c.depth + 1
      FROM sm.proposition_subject_alias a JOIN chain c ON a.alias_subject_id = c.subject_id
      WHERE c.depth < ${MAX_ALIAS_DEPTH}
    )
    SELECT subject_id FROM chain ORDER BY depth DESC LIMIT 1`)).rows;
  return rows[0].subject_id;
}

/** The subject and every subject merged into it, directly or through a chain. */
export async function subjectTree(client: PoolClient, subjectId: number): Promise<number[]> {
  return (await client.query(sql`
    WITH RECURSIVE tree(subject_id) AS (
      SELECT ${subjectId}::int
      UNION
      SELECT a.alias_subject_id FROM sm.proposition_subject_alias a JOIN tree t ON a.canonical_subject_id = t.subject_id
    )
    SELECT subject_id FROM tree`)).rows.map((r) => r.subject_id);
}

/** Marks subjects as due a fresh derivation. */
export async function touchSubjects(client: PoolClient, subjectIds: number[]) {
  if (subjectIds.length === 0) return;
  await client.query(sql`UPDATE sm.proposition_subject SET date_modified = now() WHERE subject_id = ANY(${subjectIds}::int[])`);
}

export async function requireSubject(client: PoolClient, subjectId: number) {
  const row = (await client.query(sql`SELECT * FROM sm.proposition_subject WHERE subject_id = ${subjectId}`)).rows[0];
  if (!row) throw new PropositionError(404, `Unknown subject ${subjectId}`);
  return row;
}

type Route = (client: PoolClient, event: APIGatewayProxyEvent) => Promise<unknown>;

/** One Lambda's handler: the route for the request's method, with input errors answered as 4xx. */
export function propositionHandler(name: string, routes: Partial<Record<string, Route>>) {
  return async (event: APIGatewayProxyEvent) => {
    const route = routes[event.httpMethod];
    if (!route) return createResponse(400, { message: `Unsupported ${event.httpMethod} ${event.resource}` });
    const pool = await connectLedgerDatabase();
    const client = await pool.connect();
    try {
      return createResponse(200, await route(client, event));
    } catch (error) {
      if (error instanceof PropositionError) return createResponse(error.statusCode, { message: error.message });
      if (error instanceof SyntaxError) return createResponse(400, { message: 'Body is not valid JSON' });
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${name} error:`, message);
      return createResponse(500, { message });
    } finally {
      client.release();
    }
  };
}

export function parseBody(event: APIGatewayProxyEvent): unknown {
  if (!event.body) throw new PropositionError(400, 'Missing body');
  return JSON.parse(event.body);
}
