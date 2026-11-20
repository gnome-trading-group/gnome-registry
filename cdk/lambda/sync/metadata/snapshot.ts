import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';

// What a venue sync last read from its venue, kept outside the registry's database so a sweep can tell what changed
// at the venue without reading every row it holds. It only says what to check: the database stays the source of
// truth, and a lost or stale snapshot costs a sync extra checks, never a wrong row.

export interface Stored<T> {
  value: T;
  // The version the snapshot was read at; a save conditioned on it fails if another run saved since.
  version: string | null;
}

export interface SnapshotStore<T> {
  load(): Promise<Stored<T> | null>;
  /** Saves over `version` (null: only if none exists); false when another run saved first. */
  save(value: T, version: string | null): Promise<boolean>;
  /** Saves whatever another run saved meanwhile: for a run that rebuilds the whole snapshot. */
  replace(value: T): Promise<void>;
}

const s3 = new S3Client({});

export function s3Snapshot<T>(bucket: string, key: string, client: S3Client = s3): SnapshotStore<T> {
  const put = (value: T, condition: { IfMatch?: string; IfNoneMatch?: string }) => client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: gzipSync(JSON.stringify(value)), ContentType: 'application/json', ContentEncoding: 'gzip',
    ...condition,
  }));
  return {
    async load() {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = Buffer.from(await object.Body!.transformToByteArray());
        return { value: JSON.parse(gunzipSync(body).toString('utf8')) as T, version: object.ETag ?? null };
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
    async save(value, version) {
      try {
        await put(value, version === null ? { IfNoneMatch: '*' } : { IfMatch: version });
        return true;
      } catch (error) {
        // 412: saved since this run loaded it; 409: a save racing this one.
        if (error instanceof S3ServiceException && [409, 412].includes(error.$metadata.httpStatusCode ?? 0)) return false;
        throw error;
      }
    },
    async replace(value) {
      await put(value, {});
    },
  };
}

/** A short hash of a value that doesn't depend on its keys' order. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
