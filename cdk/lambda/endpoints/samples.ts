import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse } from './ledger-common';

// Samples: a time series of readings from the platform's processes (ops.sample, migration 076). Each row is a subject
// (a kind of process and its id), a sample kind, a moment and data the registry never reads. A session's heartbeat
// carries its samples; order gateways and shards, which have no heartbeat here, post theirs to the samples API
// (SamplesApiStack), which also serves every read.

// Every subject kind and the ids it takes. The kind is part of every row's key, so ids of different kinds can't
// collide; a new kind of process is one entry here.
export const SUBJECT_KINDS: Record<string, RegExp> = {
  // The registry's session id.
  session: /^[A-Za-z0-9_-]{1,128}$/,
  // The gateway key, stable across the gateway's restarts (its task id goes in the data).
  gateway: /^(live|paper):[a-z0-9_]{1,64}:[a-z0-9_-]{1,64}$/,
  // The collection shard id.
  shard: /^[a-z0-9][a-z0-9-]{0,63}$/,
};

// Sessions write through their heartbeat, which first checks the session may still write.
export const POSTED_SUBJECT_KINDS = ['gateway', 'shard'];

export const MAX_SAMPLES_PER_POST = 300;
// A process's clock may run a little ahead; anything older than a day was held through an outage its own buffer would
// have dropped.
export const MAX_FUTURE_MS = 5 * 60_000;
export const MAX_AGE_MS = 24 * 3_600_000;
export const MAX_POST_BYTES = 128 * 1024;
// Rows are read before the page's byte cap applies, and a latency sample can run to tens of KB: kept small enough
// that a full page never strains the Lambda's memory.
export const DEFAULT_READ_LIMIT = 500;
export const MAX_READ_LIMIT = 2_000;
export const MAX_KINDS = 16;
// Under the Lambda response limit (MAX_RESPONSE_BYTES) with room for the envelope: a page stops early once its rows
// reach this, and `next` carries on from there.
export const READ_PAGE_BYTES = 4_000_000;
// Thinning (`everyMs`): one sample per bucket of at least a second and at most a day.
export const MIN_EVERY_MS = 1_000;
export const MAX_EVERY_MS = 86_400_000;

const KIND = /^[a-z][a-z0-9._-]{0,63}$/;

export class BadRequest extends Error {}

export interface Sample {
  kind: string;
  tsMs: number;
  data: Record<string, unknown>;
}

export function isSubject(subjectKind: unknown, subjectId: unknown): boolean {
  if (typeof subjectKind !== 'string' || typeof subjectId !== 'string') return false;
  const pattern = Object.prototype.hasOwnProperty.call(SUBJECT_KINDS, subjectKind) ? SUBJECT_KINDS[subjectKind] : undefined;
  return pattern !== undefined && pattern.test(subjectId);
}

/** The well-formed samples in a post's `samples`, and how many were dropped as malformed or out of range. */
export function parseSamples(raw: unknown, nowMs: number): { samples: Sample[]; dropped: number } {
  if (raw === undefined || raw === null) return { samples: [], dropped: 0 };
  if (!Array.isArray(raw)) return { samples: [], dropped: 1 };
  const samples: Sample[] = [];
  let dropped = Math.max(0, raw.length - MAX_SAMPLES_PER_POST);
  for (const item of raw.slice(0, MAX_SAMPLES_PER_POST)) {
    const kind = item?.kind;
    const tsMs = item?.tsMs;
    const data = item?.data;
    const valid = typeof kind === 'string' && KIND.test(kind)
      && Number.isSafeInteger(tsMs) && tsMs >= nowMs - MAX_AGE_MS && tsMs <= nowMs + MAX_FUTURE_MS
      && data !== null && typeof data === 'object' && !Array.isArray(data);
    if (valid) {
      samples.push({ kind, tsMs, data });
    } else {
      dropped++;
    }
  }
  return { samples, dropped };
}

/**
 * Stores a subject's samples, ignoring any already stored (a re-send after an answer was lost). Its own statement, so a
 * failure (no partition for the day, say) leaves whatever else the caller wrote standing.
 *
 * @return how many were new
 */
export async function storeSamples(client: PoolClient, subjectKind: string, subjectId: string, samples: Sample[]): Promise<number> {
  if (samples.length === 0) return 0;
  const result = await client.query(`
    INSERT INTO ops.sample (subject_kind, subject_id, kind, ts, data)
    SELECT $1, $2, s.kind, TIMESTAMPTZ 'epoch' + s.ts_ms * INTERVAL '1 millisecond', s.data
    FROM jsonb_to_recordset($3::jsonb) AS s(kind TEXT, ts_ms BIGINT, data JSONB)
    ON CONFLICT DO NOTHING`,
  [subjectKind, subjectId, JSON.stringify(samples.map(s => ({ kind: s.kind, ts_ms: s.tsMs, data: s.data })))]);
  return result.rowCount ?? 0;
}

/** A gateway's or shard's posted samples: `{subjectKind, subjectId, samples}`. */
export async function ingest(client: PoolClient, body: string, nowMs: number): Promise<{ stored: number; dropped: number }> {
  if (Buffer.byteLength(body) > MAX_POST_BYTES) throw new BadRequest(`A post may be at most ${MAX_POST_BYTES} bytes`);
  let parsed: { subjectKind?: unknown; subjectId?: unknown; samples?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BadRequest('Body must be JSON');
  }
  const { subjectKind, subjectId } = parsed ?? {};
  if (!POSTED_SUBJECT_KINDS.includes(subjectKind as string)) {
    throw new BadRequest(`subjectKind must be one of ${POSTED_SUBJECT_KINDS.join(', ')}`);
  }
  if (!isSubject(subjectKind, subjectId)) throw new BadRequest(`subjectId is not a ${subjectKind} id`);
  const { samples, dropped } = parseSamples(parsed.samples, nowMs);
  if (dropped > 0) console.warn(`${subjectKind} ${subjectId}: dropped ${dropped} malformed or out-of-range samples`);
  return { stored: await storeSamples(client, subjectKind as string, subjectId as string, samples), dropped };
}

function parseTimeMs(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(ms)) throw new BadRequest(`${name} must be epoch milliseconds or an ISO time`);
  return ms;
}

// Where the next page starts: after (tsMs, kind) in the page's order. A thinned read's tsMs is a bucket's start.
interface Cursor {
  tsMs: number;
  kind: string;
}

function parseCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined || value === '') return undefined;
  const at = value.indexOf(':');
  const tsMs = Number(value.slice(0, at));
  const kind = value.slice(at + 1);
  if (at < 1 || !Number.isSafeInteger(tsMs) || !KIND.test(kind)) throw new BadRequest('after must be a next cursor');
  return { tsMs, kind };
}

function parseEveryMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const everyMs = Number(value);
  if (!Number.isInteger(everyMs) || everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS) {
    throw new BadRequest(`everyMs must be ${MIN_EVERY_MS} to ${MAX_EVERY_MS}`);
  }
  return everyMs;
}

export interface SamplePage {
  samples: Sample[];
  // Pass as `after` for the rest; null once there is nothing more in the window.
  next: string | null;
}

/**
 * A subject's samples of one kind (`kind`), of several (`kinds`, comma-separated) or of every kind under a prefix
 * (`kindPrefix`, e.g. `latency.`), oldest first, from `from` (inclusive) to `to` (exclusive), each epoch ms or ISO;
 * `after` continues a page (repeat the other parameters). With `everyMs`, only the first sample of each kind in each
 * bucket of that many ms (from the epoch), ordered by bucket then kind: a long range thinned to a chart's worth. A thinned
 * counter is one sample's change, not the bucket's sum.
 */
export async function readSamples(client: PoolClient, params: Record<string, string | undefined>): Promise<SamplePage> {
  const { subjectKind, subjectId } = params;
  if (!isSubject(subjectKind, subjectId)) throw new BadRequest('subjectKind and subjectId must name a subject');
  const selectors = [params.kind, params.kinds, params.kindPrefix].filter(v => v !== undefined);
  if (selectors.length !== 1) throw new BadRequest('Give exactly one of kind, kinds or kindPrefix');
  const kinds = params.kind !== undefined ? [params.kind] : params.kinds?.split(',');
  if (kinds && (kinds.length > MAX_KINDS || !kinds.every(k => KIND.test(k)))) {
    throw new BadRequest(`kinds must be 1 to ${MAX_KINDS} sample kinds`);
  }
  const prefix = params.kindPrefix;
  if (prefix !== undefined && !KIND.test(prefix)) throw new BadRequest('kindPrefix is not a kind prefix');
  const fromMs = parseTimeMs(params.from, 'from');
  const toMs = parseTimeMs(params.to, 'to');
  const after = parseCursor(params.after);
  const everyMs = parseEveryMs(params.everyMs);
  const limit = params.limit === undefined ? DEFAULT_READ_LIMIT : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new BadRequest(`limit must be 1 to ${MAX_READ_LIMIT}`);
  }

  const values: unknown[] = [subjectKind, subjectId];
  const where = ['subject_kind = $1', 'subject_id = $2'];
  const at = (ms: number) => {
    values.push(ms);
    return `TIMESTAMPTZ 'epoch' + $${values.length}::bigint * INTERVAL '1 millisecond'`;
  };
  if (kinds) {
    values.push(kinds);
    where.push(`kind = ANY($${values.length}::text[])`);
  } else {
    // A kind holds no LIKE wildcard but '_', which is escaped.
    values.push(`${prefix!.replace(/_/g, '\\_')}%`);
    where.push(`kind LIKE $${values.length}`);
  }
  if (fromMs !== undefined) where.push(`ts >= ${at(fromMs)}`);
  if (toMs !== undefined) where.push(`ts < ${at(toMs)}`);

  let query: string;
  if (everyMs === undefined) {
    if (after !== undefined) {
      const ts = at(after.tsMs);
      values.push(after.kind);
      where.push(`(ts, kind) > (${ts}, $${values.length})`);
    }
    values.push(limit + 1);
    query = `SELECT kind, (EXTRACT(EPOCH FROM ts) * 1000)::BIGINT AS ts_ms, NULL::BIGINT AS bucket_ms, data
      FROM ops.sample WHERE ${where.join(' AND ')} ORDER BY ts, kind LIMIT $${values.length}`;
  } else {
    values.push(everyMs);
    const bucket = `date_bin($${values.length}::bigint * INTERVAL '1 millisecond', ts, TIMESTAMPTZ 'epoch')`;
    let resume = '';
    if (after !== undefined) {
      // Nothing before the cursor's bucket can follow it, so the inner read starts there.
      where.push(`ts >= ${at(after.tsMs)}`);
      const bucketAt = at(after.tsMs);
      values.push(after.kind);
      resume = `WHERE (bucket, kind) > (${bucketAt}, $${values.length})`;
    }
    values.push(limit + 1);
    query = `SELECT kind, (EXTRACT(EPOCH FROM ts) * 1000)::BIGINT AS ts_ms,
        (EXTRACT(EPOCH FROM bucket) * 1000)::BIGINT AS bucket_ms, data
      FROM (SELECT DISTINCT ON (kind, ${bucket}) kind, ${bucket} AS bucket, ts, data FROM ops.sample
        WHERE ${where.join(' AND ')} ORDER BY kind, ${bucket}, ts) thinned
      ${resume}
      ORDER BY bucket, kind LIMIT $${values.length}`;
  }
  const rows = (await client.query(query, values)).rows;

  const samples: Sample[] = [];
  let bytes = 0;
  let last: { kind: string; tsMs: number; bucketMs: number | null } | null = null;
  for (const row of rows.slice(0, limit)) {
    const sample = { kind: row.kind, tsMs: Number(row.ts_ms), data: row.data };
    bytes += Buffer.byteLength(JSON.stringify(sample));
    if (samples.length > 0 && bytes > READ_PAGE_BYTES) break;
    samples.push(sample);
    last = { kind: row.kind, tsMs: sample.tsMs, bucketMs: row.bucket_ms === null ? null : Number(row.bucket_ms) };
  }
  if (samples.length === rows.length || !last) return { samples, next: null };
  return { samples, next: `${last.bucketMs ?? last.tsMs}:${last.kind}` };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return createResponse(400, { message: 'Invalid HTTP method' });
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    if (event.httpMethod === 'POST') return createResponse(200, await ingest(client, event.body ?? '', Date.now()));
    return createResponse(200, await readSamples(client, event.queryStringParameters ?? {}));
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
