import { PoolClient } from 'pg';
import { IFeeDefinition } from './definition';

export type FeeScope = 'LISTING' | 'FEE_EVENT' | 'FEE_GROUP' | 'EXCHANGE';
// Most specific first: the first scope with a schedule in force decides a listing's fees.
const SCOPE_ORDER: FeeScope[] = ['LISTING', 'FEE_EVENT', 'FEE_GROUP', 'EXCHANGE'];

export interface IScheduleRow {
  fee_schedule_id: string;
  scope: FeeScope;
  effective_from: Date;
  recorded_at: Date;
  definition: IFeeDefinition | null;
}

export interface ITimelineEntry {
  effectiveFrom: string;
  effectiveTo: string | null;
  scope: FeeScope;
  feeScheduleId: string;
  definition: IFeeDefinition;
}

// One listing's fees over time from the schedules of its four scopes. Each entry holds from its effectiveFrom until
// the next entry's (effectiveTo, exclusive; null for the last). A time no entry covers has no known fees.
// from/to trim the result to the entries in force at some point in [from, to].
export function resolveTimeline(rows: IScheduleRow[], from?: Date, to?: Date): ITimelineEntry[] {
  // Within one scope, the latest recorded_at for each effective_from wins (a correction replaces the original).
  const perScope = new Map<FeeScope, IScheduleRow[]>();
  for (const scope of SCOPE_ORDER) {
    const byEffective = new Map<number, IScheduleRow>();
    for (const row of rows.filter((r) => r.scope === scope)) {
      const key = row.effective_from.getTime();
      const current = byEffective.get(key);
      if (!current || row.recorded_at.getTime() > current.recorded_at.getTime()
        || (row.recorded_at.getTime() === current.recorded_at.getTime()
          && BigInt(row.fee_schedule_id) > BigInt(current.fee_schedule_id))) {
        byEffective.set(key, row);
      }
    }
    perScope.set(scope, [...byEffective.values()].sort((a, b) => a.effective_from.getTime() - b.effective_from.getTime()));
  }

  const changes = [...new Set(rows.map((r) => r.effective_from.getTime()))].sort((a, b) => a - b);
  const segments: { start: number; row: IScheduleRow | null }[] = [];
  for (const at of changes) {
    let winner: IScheduleRow | null = null;
    for (const scope of SCOPE_ORDER) {
      const inForce = perScope.get(scope)!.filter((r) => r.effective_from.getTime() <= at).pop();
      if (inForce && inForce.definition !== null) {
        winner = inForce;
        break;
      }
    }
    const last = segments[segments.length - 1];
    if (last && last.row?.fee_schedule_id === winner?.fee_schedule_id) continue;
    segments.push({ start: at, row: winner });
  }

  const entries: ITimelineEntry[] = [];
  segments.forEach((segment, i) => {
    const end = i + 1 < segments.length ? segments[i + 1].start : null;
    if (!segment.row) return;
    if (from && end !== null && end <= from.getTime()) return;
    if (to && segment.start > to.getTime()) return;
    entries.push({
      effectiveFrom: new Date(segment.start).toISOString(),
      effectiveTo: end === null ? null : new Date(end).toISOString(),
      scope: segment.row.scope,
      feeScheduleId: String(segment.row.fee_schedule_id),
      definition: segment.row.definition!,
    });
  });
  return entries;
}

/**
 * Each listing's resolved fee timeline from the stored schedules of its four scopes; with knownAsOf, as the registry
 * stood then (schedules recorded later are left out).
 */
export async function loadTimelines(
  client: PoolClient, listingIds: number[], from?: Date, to?: Date, knownAsOf?: string | null,
): Promise<Map<number, ITimelineEntry[]>> {
  const result = await client.query(
    `SELECT l.listing_id, f.fee_schedule_id, f.effective_from, f.recorded_at, f.definition,
            CASE WHEN f.listing_id IS NOT NULL THEN 'LISTING' WHEN f.fee_event IS NOT NULL THEN 'FEE_EVENT'
                 WHEN f.fee_group IS NOT NULL THEN 'FEE_GROUP' ELSE 'EXCHANGE' END AS scope
     FROM sm.listing l JOIN sm.fee_schedule f ON f.exchange_id = l.exchange_id AND (
       f.listing_id = l.listing_id OR f.fee_event = l.fee_event OR f.fee_group = l.fee_group
       OR (f.listing_id IS NULL AND f.fee_event IS NULL AND f.fee_group IS NULL))
     WHERE l.listing_id = ANY($1::int[])
       AND ($2::timestamptz IS NULL OR f.recorded_at <= $2::timestamptz)`,
    [listingIds, knownAsOf ?? null]);
  const byListing = new Map<number, IScheduleRow[]>(listingIds.map((id) => [id, []]));
  for (const row of result.rows) byListing.get(row.listing_id)!.push(row);
  return new Map(listingIds.map((id) => [id, resolveTimeline(byListing.get(id)!, from, to)]));
}

/** The entry in force at `at`, or undefined where no fees are known. */
export function entryAt(timeline: ITimelineEntry[], at: Date): ITimelineEntry | undefined {
  const t = at.getTime();
  return timeline.find((e) => Date.parse(e.effectiveFrom) <= t && (e.effectiveTo === null || t < Date.parse(e.effectiveTo)));
}
