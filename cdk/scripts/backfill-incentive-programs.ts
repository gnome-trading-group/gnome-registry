// Records Kalshi's past incentive programs, which the incentive sync doesn't read (it reads the unpaid ones, and a
// day's payouts). Reads every program Kalshi lists and posts those that started on or after --since, as BACKFILL,
// through the same route as the sync; the registry drops any it already holds unchanged. Safe to rerun.
//
//   REGISTRY_API_URL=https://<api>/api REGISTRY_API_KEY=<key> \
//     npx ts-node scripts/backfill-incentive-programs.ts [--since 2026-07-01] [--pause-ms 250] [--dry-run]
//
// --pause-ms waits between posts. Inserting hundreds of thousands of rows back to back slowed the shared database
// enough that other endpoints couldn't open connections, so pace it in prod.
import { postInChunks, registryPost } from '../lambda/sync/incentive-sync';
import { resolveApiKey } from '../lambda/sync/registry-client';
import { parseKalshiIncentiveProgram, readKalshiIncentivePages } from '../lambda/sync/venues/kalshi';
import { IncentiveProgramReading } from '../lambda/sync/venues/types';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const since = new Date(option('since') ?? '2026-07-01T00:00:00Z');
  if (Number.isNaN(since.getTime())) throw new Error('--since must be a date');
  const programs = (await readKalshiIncentivePages('all', since))
    .filter(p => Date.parse(p.start_date) >= since.getTime())
    .map(parseKalshiIncentiveProgram)
    .filter((p): p is IncentiveProgramReading => p !== null);
  console.log(`${programs.length} Kalshi liquidity programs started since ${since.toISOString()}`);
  if (process.argv.includes('--dry-run')) return;
  const pauseMs = Number(option('pause-ms') ?? 0);
  const post = registryPost(await resolveApiKey());
  let posted = 0;
  const paced: typeof post = async (rows, exchangeCode, source) => {
    const result = await post(rows, exchangeCode, source);
    posted += rows.length;
    if (posted % 20_000 < rows.length) console.log(`posted ${posted} of ${programs.length}`);
    await new Promise(resolve => setTimeout(resolve, pauseMs));
    return result;
  };
  const result = await postInChunks(paced, programs, 'KALSHI', 'BACKFILL');
  console.log(`inserted ${result.inserted}, unchanged ${result.unchanged}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
