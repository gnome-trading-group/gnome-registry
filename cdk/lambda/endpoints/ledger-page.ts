import { isSessionId, parseMode, parsePositiveInt } from './ledger-common';

// Shared paging and filters for the controller's fills and orders lists: one session, or one strategy in one mode,
// newest first. `before` pages back through older rows; `after` fetches only rows newer than the newest one shown,
// for polling. Cursors are the rows' own sequence numbers, so rows arriving meanwhile are never skipped or repeated.

export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 1000;

export interface PageQuery {
  where: string[];
  values: unknown[];
  limit: number;
  after: boolean;
}

export function pageFilters(
  params: Record<string, string | undefined>, alias: string, sequence: string, timeColumn: string,
): PageQuery {
  const values: unknown[] = [];
  const where: string[] = [];
  const add = (clause: (placeholder: string) => string, value: unknown) => {
    values.push(value);
    where.push(clause(`$${values.length}`));
  };
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new Error('sessionId must be a session id');
    add(p => `${alias}.session_id = ${p}`, params.sessionId);
  } else {
    const strategyId = parsePositiveInt(params.strategyId);
    const mode = parseMode(params.mode);
    if (strategyId === undefined || Number.isNaN(strategyId) || !mode) {
      throw new Error('Either sessionId, or strategyId and mode, are required');
    }
    add(p => `${alias}.strategy_id = ${p}`, strategyId);
    add(p => `${alias}.mode = ${p}`, mode);
  }
  const listingId = parsePositiveInt(params.listingId);
  if (Number.isNaN(listingId)) throw new Error('listingId must be a positive integer');
  if (listingId !== undefined) add(p => `${alias}.listing_id = ${p}`, listingId);
  for (const [name, op] of [['start', '>='], ['end', '<=']] as const) {
    const value = params[name];
    if (!value) continue;
    if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO time`);
    add(p => `${alias}.${timeColumn} ${op} ${p}`, value);
  }
  const before = params.before ? BigInt(params.before) : undefined;
  const after = params.after ? BigInt(params.after) : undefined;
  if (before !== undefined && after !== undefined) throw new Error('before and after cannot be combined');
  if (before !== undefined) add(p => `${alias}.${sequence} < ${p}`, before.toString());
  if (after !== undefined) add(p => `${alias}.${sequence} > ${p}`, after.toString());
  const limit = Math.min(parsePositiveInt(params.limit) || DEFAULT_PAGE, MAX_PAGE);
  return { where, values, limit, after: after !== undefined };
}

export function listingColumns(alias: string): string {
  return `
    LEFT JOIN sm.listing l ON l.listing_id = ${alias}.listing_id
    LEFT JOIN LATERAL (
      SELECT tick_size, lot_size FROM sm.listing_spec s WHERE s.listing_id = ${alias}.listing_id
      ORDER BY recorded_at DESC LIMIT 1
    ) spec ON TRUE`;
}

// Newest first; a poll for newer rows takes the oldest of them first, so a burst larger than a page is never cut
// off in the middle, and the caller re-sorts.
export function pageOrder(sequence: string, page: PageQuery): string {
  return `ORDER BY ${sequence} ${page.after ? 'ASC' : 'DESC'} LIMIT ${page.limit}`;
}
