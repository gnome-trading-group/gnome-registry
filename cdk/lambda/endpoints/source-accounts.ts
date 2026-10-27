import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, withTransaction } from './base';
import { connectLedgerDatabase, createResponse, isPositiveInt } from './ledger-common';

// Market-data accounts per source. Registering one is the API key's (the account-creation Lambda, which writes the key
// to Secrets Manager: only the secret's name comes here); reading is open to shards, people and bots; retiring one or
// changing its budget is a person's, so the change is attributed.

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9/_+=.@-]+$/;
const STATUSES = ['ACTIVE', 'RETIRED'];

export class SourceAccountError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface IRegisterSourceAccount {
  sourceCode: string;
  label: string;
  secretName: string;
  connectionBudget?: number | null;
  note?: string;
  actor: string;
}

export interface IModifySourceAccount {
  accountId: number;
  status?: string;
  connectionBudget?: number | null;
  note?: string;
}

export function parseRegistration(body: string): IRegisterSourceAccount {
  const a = JSON.parse(body) as IRegisterSourceAccount;
  if (typeof a.sourceCode !== 'string' || a.sourceCode.length === 0) {
    throw new SourceAccountError(400, 'sourceCode is required');
  }
  if (typeof a.label !== 'string' || !LABEL_PATTERN.test(a.label)) {
    throw new SourceAccountError(400, 'label must be lowercase letters, digits and dashes, like md-1');
  }
  if (typeof a.secretName !== 'string' || !SECRET_NAME_PATTERN.test(a.secretName)) {
    throw new SourceAccountError(400, 'secretName must be a Secrets Manager secret name');
  }
  if (a.connectionBudget != null && !isPositiveInt(a.connectionBudget)) {
    throw new SourceAccountError(400, 'connectionBudget must be a positive integer or null');
  }
  if (typeof a.actor !== 'string' || a.actor.trim().length === 0) throw new SourceAccountError(400, 'actor is required');
  return a;
}

/**
 * Records an account, or refreshes one already recorded under that label: setting a new key for an account replaces
 * its secret in place, so the row only needs touching. A retired account stays retired until a person reactivates it.
 */
export async function registerAccount(client: PoolClient, a: IRegisterSourceAccount) {
  const source = (await client.query('SELECT source_id FROM md.source WHERE code = $1', [a.sourceCode])).rows[0];
  if (!source) throw new SourceAccountError(400, `Unknown source ${a.sourceCode}`);
  return (await client.query(
    `INSERT INTO md.source_account (source_id, label, secret_name, connection_budget, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id, label) DO UPDATE SET
       secret_name = EXCLUDED.secret_name,
       connection_budget = COALESCE(EXCLUDED.connection_budget, md.source_account.connection_budget),
       note = COALESCE(EXCLUDED.note, md.source_account.note),
       date_modified = NOW()
     RETURNING *`,
    [source.source_id, a.label, a.secretName, a.connectionBudget ?? null, a.note ?? null, a.actor],
  )).rows[0];
}

export async function listAccounts(client: PoolClient, params: Record<string, string | undefined>) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.sourceId !== undefined) {
    values.push(Number(params.sourceId));
    where.push(`a.source_id = $${values.length}`);
  }
  if (params.sourceCode !== undefined) {
    values.push(params.sourceCode);
    where.push(`s.code = $${values.length}`);
  }
  if (params.label !== undefined) {
    values.push(params.label);
    where.push(`a.label = $${values.length}`);
  }
  return (await client.query(
    `SELECT a.*, s.code AS source_code
     FROM md.source_account a JOIN md.source s USING (source_id)
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.code, a.label`,
    values,
  )).rows;
}

export async function modifyAccount(client: PoolClient, m: IModifySourceAccount) {
  if (!isPositiveInt(m.accountId)) throw new SourceAccountError(400, 'accountId must be a positive integer');
  const updates: string[] = [];
  const values: unknown[] = [];
  if (m.status !== undefined) {
    if (!STATUSES.includes(m.status)) throw new SourceAccountError(400, `status must be one of ${STATUSES.join(', ')}`);
    values.push(m.status);
    updates.push(`status = $${values.length}`);
  }
  if (m.connectionBudget !== undefined) {
    if (m.connectionBudget !== null && !isPositiveInt(m.connectionBudget)) {
      throw new SourceAccountError(400, 'connectionBudget must be a positive integer or null');
    }
    values.push(m.connectionBudget);
    updates.push(`connection_budget = $${values.length}`);
  }
  if (m.note !== undefined) {
    values.push(m.note);
    updates.push(`note = $${values.length}`);
  }
  if (updates.length === 0) throw new SourceAccountError(400, 'Nothing to change: give status, connectionBudget or note');
  values.push(m.accountId);
  const row = (await client.query(
    `UPDATE md.source_account SET ${updates.join(', ')}, date_modified = NOW()
     WHERE account_id = $${values.length} RETURNING *`,
    values,
  )).rows[0];
  if (!row) throw new SourceAccountError(404, `Unknown account ${m.accountId}`);
  return row;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    if (event.httpMethod === 'GET') {
      return createResponse(200, await listAccounts(client, event.queryStringParameters ?? {}));
    }
    if (event.httpMethod === 'POST') {
      const registration = parseRegistration(event.body ?? '');
      const row = await withTransaction(client, (c) => registerAccount(c, registration),
        { actor: registration.actor, reason: 'market-data account set' });
      return createResponse(200, row);
    }
    if (event.httpMethod === 'PATCH') {
      const change = JSON.parse(event.body ?? '{}') as IModifySourceAccount;
      const row = await withTransaction(client, (c) => modifyAccount(c, change),
        { actor: getActor(event), reason: 'market-data account changed' });
      return createResponse(200, row);
    }
    return createResponse(400, { message: `Unsupported ${event.httpMethod} ${event.resource}` });
  } catch (error) {
    if (error instanceof SourceAccountError) return createResponse(error.statusCode, { message: error.message });
    if (error instanceof SyntaxError) return createResponse(400, { message: 'Body is not valid JSON' });
    const message = error instanceof Error ? error.message : String(error);
    console.error('Source account error:', message);
    return createResponse(500, { message });
  } finally {
    client.release();
  }
};
