import { NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { gzipSync } from 'zlib';
import { hashOf, s3Snapshot } from '../lambda/sync/metadata/snapshot';

function fakeS3(handle: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  const client = { send: jest.fn(async (command: unknown) => { sent.push(command); return handle(command); }) } as unknown as S3Client;
  return { client, sent };
}

const refused = (status: number) =>
  new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: status } });

describe('a snapshot in S3', () => {
  it('reads back what was saved, with the version to save over', async () => {
    const body = gzipSync(JSON.stringify({ a: 1 }));
    const { client } = fakeS3(() => ({ ETag: '"v1"', Body: { transformToByteArray: async () => new Uint8Array(body) } }));
    expect(await s3Snapshot('b', 'specs/K.json.gz', client).load()).toEqual({ value: { a: 1 }, version: '"v1"' });
  });

  it('is none before one is saved', async () => {
    const { client } = fakeS3(() => { throw new NoSuchKey({ message: 'none', $metadata: {} }); });
    expect(await s3Snapshot('b', 'k', client).load()).toBeNull();
  });

  it('saves only over the version it read, or only where none exists', async () => {
    const { client, sent } = fakeS3(() => ({}));
    const store = s3Snapshot('b', 'k', client);
    expect(await store.save({ a: 1 }, '"v1"')).toBe(true);
    expect(await store.save({ a: 1 }, null)).toBe(true);
    await store.replace({ a: 1 });
    const inputs = sent.map(c => (c as PutObjectCommand).input);
    expect(inputs.map(i => [i.IfMatch, i.IfNoneMatch])).toEqual([['"v1"', undefined], [undefined, '*'], [undefined, undefined]]);
    expect(inputs[0]).toMatchObject({ Bucket: 'b', Key: 'k', ContentEncoding: 'gzip' });
  });

  it('reports a save another run got in first, and throws anything else', async () => {
    expect(await s3Snapshot('b', 'k', fakeS3(() => { throw refused(412); }).client).save({}, '"v1"')).toBe(false);
    expect(await s3Snapshot('b', 'k', fakeS3(() => { throw refused(409); }).client).save({}, '"v1"')).toBe(false);
    await expect(s3Snapshot('b', 'k', fakeS3(() => { throw refused(403); }).client).save({}, '"v1"')).rejects.toThrow();
  });

  it('hashes a value the same whatever order its keys come in', () => {
    expect(hashOf({ a: 1, b: [{ x: 1, y: null }] })).toBe(hashOf({ b: [{ y: null, x: 1 }], a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});
