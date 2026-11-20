import { emitSyncMetrics } from './metrics';
import { s3Snapshot, SnapshotStore } from './snapshot';

// The shared run of every kind of venue metadata the registry keeps (listing specs, incentive programs, later fee
// schedules and fee tiers): which units a run covers, where each unit's snapshot lives, how a unit's outcome becomes
// metrics and alarms, and when the run fails. What a mode does is the kind's own; the database-safety rules each mode
// keeps are in each kind's header and pinned by its tests.

export const MODES = ['new', 'sweep', 'reconcile', 'missing'] as const;
export type Mode = typeof MODES[number];
// The modes that read a whole population: always one venue at a time, so the database carries one at once.
export const POPULATION_MODES: readonly Mode[] = ['reconcile', 'missing'];

/** What one run covers: a venue, and for a kind kept per account (fee tiers), one account on it. */
export interface Unit {
  venue: string;
  scope?: string;
}

/** A scheduled run's event: a mode, optionally one venue (else every venue of the kind) and a named read. */
export interface RunRequest {
  mode?: unknown;
  venue?: unknown;
  variant?: unknown;
}

export type Snapshots<S> = (unit: Unit) => SnapshotStore<S>;

export interface RunContext<S> {
  now: Date;
  snapshots: Snapshots<S>;
  variant?: string;
}

/**
 * A unit's outcome as counts, each emitted as a metric. Two are read by the harness: `Refused` (writes the registry
 * turned down) fails the run like a venue that couldn't be read, and `NoSnapshot` (a sweep that had to seed its
 * snapshot first) reports the unit unhealthy, so neither passes as a quiet success.
 */
export type Counts = Record<string, number>;

export interface Kind<S> {
  /** The kind's name: its metrics' `Kind`, its snapshots' prefix in the cache bucket. */
  name: string;
  venues: readonly string[];
  modes: readonly Mode[];
  /** Named reads a mode can be asked for (Kalshi incentives' `payouts`), each from its own schedule. */
  variants?: readonly string[];
  /** The units on a venue; one per venue unless the kind is kept per account. */
  units?(venue: string): Promise<Unit[]>;
  run(mode: Mode, unit: Unit, ctx: RunContext<S>): Promise<Counts>;
}

export function snapshotKey(kind: string, unit: Unit): string {
  return `${kind}/${unit.venue}${unit.scope ? `/${unit.scope}` : ''}.json.gz`;
}

export function s3Snapshots<S>(bucket: string, kind: string): Snapshots<S> {
  return unit => s3Snapshot<S>(bucket, snapshotKey(kind, unit));
}

export interface UnitOutcome {
  unit: Unit;
  counts?: Counts;
  error?: string;
}

/** Checks a scheduled event against the kind, so a misconfigured rule fails loudly instead of syncing nothing. */
export function parseRequest<S>(kind: Kind<S>, request: RunRequest): { mode: Mode; venue?: string; variant?: string } {
  const { mode, venue, variant } = request;
  if (!kind.modes.includes(mode as Mode)) {
    throw new Error(`The ${kind.name} sync needs a mode of ${kind.modes.join(', ')}, not ${JSON.stringify(mode)}`);
  }
  if (venue === undefined && POPULATION_MODES.includes(mode as Mode)) {
    throw new Error(`A ${kind.name} ${mode} reads a whole population, so it runs for one venue at a time; name one`);
  }
  if (venue !== undefined && !kind.venues.includes(venue as string)) {
    throw new Error(`The ${kind.name} sync has no venue ${JSON.stringify(venue)}`);
  }
  if (variant !== undefined && !(kind.variants ?? []).includes(variant as string)) {
    throw new Error(`The ${kind.name} sync has no read ${JSON.stringify(variant)}`);
  }
  return { mode: mode as Mode, venue: venue as string | undefined, variant: variant as string | undefined };
}

/**
 * Runs a mode for a venue (or every venue of the kind), each venue's units one after another and the venues side by
 * side. A unit that fails doesn't stop the others, but fails the run, so the kind's fault alarm fires; every unit
 * reports `Ok` (0 or 1), `Seconds` (what the schedule's read budgets are checked against) and its counts, which the
 * heartbeat alarms read.
 */
export async function runScheduled<S>(kind: Kind<S>, request: RunRequest, ctx: { now: Date; snapshots: Snapshots<S> }) {
  const { mode, venue, variant } = parseRequest(kind, request);
  const venues = venue === undefined ? kind.venues : [venue];
  const outcomes = (await Promise.all(venues.map(async (v): Promise<UnitOutcome[]> => {
    const units = kind.units ? await kind.units(v) : [{ venue: v }];
    const done: UnitOutcome[] = [];
    for (const unit of units) {
      const started = Date.now();
      const seconds = () => Math.round((Date.now() - started) / 1000);
      try {
        const counts = await kind.run(mode, unit, { now: ctx.now, snapshots: ctx.snapshots, variant });
        const healthy = !(counts.Refused > 0) && !(counts.NoSnapshot > 0);
        // A sweep that found its snapshot reports a 0, so its NoSnapshot alarm clears on the next sweep: an alarm left
        // with no new datapoints can hold its last state long after the one sweep that seeded it.
        const seeded: Counts = mode === 'sweep' ? { NoSnapshot: 0 } : {};
        emitSyncMetrics(kind.name, mode, unit.venue, { Ok: healthy ? 1 : 0, Seconds: seconds(), ...seeded, ...counts }, ctx.now);
        done.push({ unit, counts });
      } catch (error) {
        console.error(`The ${kind.name} sync (${mode}) for ${describe(unit)} failed:`,
          error instanceof Error ? error.stack : error);
        emitSyncMetrics(kind.name, mode, unit.venue, { Ok: 0, Seconds: seconds() }, ctx.now);
        done.push({ unit, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return done;
  }))).flat();
  console.log(`The ${kind.name} sync (${mode}${variant ? `, ${variant}` : ''}):`, JSON.stringify(outcomes));
  const failed = outcomes.filter(o => o.error !== undefined || (o.counts?.Refused ?? 0) > 0);
  if (failed.length > 0) {
    throw new Error(`The ${kind.name} sync (${mode}) failed for ${failed.map(o => describe(o.unit)).join(', ')}`);
  }
  return outcomes;
}

function describe(unit: Unit): string {
  return unit.scope ? `${unit.venue} (${unit.scope})` : unit.venue;
}
