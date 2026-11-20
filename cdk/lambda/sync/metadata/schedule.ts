import { SPEC_SYNC_EXCHANGES } from '../../endpoints/spec-refresh-queue';
import { Mode, POPULATION_MODES } from './kind';

// When every kind's runs fire. Each run that reads a venue has a budget (minutes it may take); no two of one venue
// overlap, so a venue's rate limit is never shared by two runs at once, and the passes over a whole population
// (reconcile, missing) never overlap at all, so the database carries at most one at a time. scheduleOverlaps checks
// both, and the stack's test runs it.

export interface ScheduleEntry {
  kind: string;
  mode: Mode;
  // Every venue of the kind when absent (the every-minute new-listing pass, which reads only recent listings).
  venue?: string;
  variant?: string;
  // Minutes past the hour it starts, in the UTC `hours` given (every hour when absent). `everyMinute` instead.
  minutes?: number[];
  hours?: number[];
  everyMinute?: boolean;
  budgetMinutes: number;
}

const SLOT_MINUTES = 12;
// The daily whole-population passes run in these hours, in the slots the hourly specs reconcile leaves free.
const SPECS_MISSING_HOUR = 8;
const INCENTIVES_RECONCILE_HOUR = 9;
const HOURLY = [...Array(24).keys()].filter(h => h !== SPECS_MISSING_HOUR && h !== INCENTIVES_RECONCILE_HOUR);

// Each spec venue's slot in the hour; a venue's runs of every kind sit at fixed offsets from it.
const slot = (venue: string) => SPEC_SYNC_EXCHANGES.indexOf(venue) * SLOT_MINUTES;
const every15 = (start: number) => [0, 15, 30, 45].map(m => (start + m) % 60).sort((a, b) => a - b);

export const INCENTIVE_VENUES = ['KALSHI', 'POLYMARKET_INTL', 'POLYMARKET_US'];

export function schedule(): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [{ kind: 'specs', mode: 'new', everyMinute: true, budgetMinutes: 0 }];
  for (const venue of SPEC_SYNC_EXCHANGES) {
    const r = slot(venue);
    entries.push(
      { kind: 'specs', mode: 'reconcile', venue, minutes: [r], hours: HOURLY, budgetMinutes: 5 },
      { kind: 'specs', mode: 'sweep', venue, minutes: every15(r + 6), budgetMinutes: 3 },
      // At night in the US.
      { kind: 'specs', mode: 'missing', venue, minutes: [r], hours: [SPECS_MISSING_HOUR], budgetMinutes: 5 },
    );
  }
  for (const venue of INCENTIVE_VENUES) {
    const r = slot(venue);
    entries.push(
      { kind: 'incentives', mode: 'sweep', venue, minutes: every15(r + 10), budgetMinutes: 3 },
      { kind: 'incentives', mode: 'reconcile', venue, minutes: [r], hours: [INCENTIVES_RECONCILE_HOUR], budgetMinutes: 5 },
    );
  }
  // Kalshi pays around 06:00 ET; this read also takes the programs it paid in the last weeks.
  entries.push({ kind: 'incentives', mode: 'sweep', venue: 'KALSHI', variant: 'payouts', minutes: [(slot('KALSHI') + 13) % 60], hours: [11], budgetMinutes: 3 });
  return entries;
}

/** Each run's [start, end) minutes of the UTC day. */
function occurrences(entry: ScheduleEntry): [number, number][] {
  if (entry.everyMinute) return [];
  const hours = entry.hours ?? [...Array(24).keys()];
  return hours.flatMap(h => (entry.minutes ?? []).map(m => [h * 60 + m, h * 60 + m + entry.budgetMinutes] as [number, number]));
}

function label(entry: ScheduleEntry): string {
  return `${entry.kind} ${entry.mode}${entry.variant ? ` (${entry.variant})` : ''}${entry.venue ? ` ${entry.venue}` : ''}`;
}

function clashes(runs: { at: [number, number]; entry: ScheduleEntry }[]): string[] {
  const sorted = [...runs].sort((a, b) => a.at[0] - b.at[0]);
  const found: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const [before, after] = [sorted[i - 1], sorted[i]];
    if (after.at[0] < before.at[1]) {
      found.push(`${label(before.entry)} at minute ${before.at[0]} runs into ${label(after.entry)} at minute ${after.at[0]}`);
    }
  }
  return found;
}

/** Runs that would overlap: two reading one venue, or two reading a whole population. Empty when the schedule holds. */
export function scheduleOverlaps(entries: ScheduleEntry[]): string[] {
  const runs = entries.flatMap(entry => occurrences(entry).map(at => ({ at, entry })));
  const byVenue = new Map<string, typeof runs>();
  for (const run of runs) {
    if (run.entry.venue) byVenue.set(run.entry.venue, [...(byVenue.get(run.entry.venue) ?? []), run]);
  }
  return [
    ...[...byVenue.values()].flatMap(clashes),
    ...clashes(runs.filter(r => POPULATION_MODES.includes(r.entry.mode))),
  ];
}

/** The EventBridge cron fields of an entry. */
export function cronOf(entry: ScheduleEntry): { minute: string; hour?: string } {
  if (entry.everyMinute) return { minute: '*' };
  return { minute: (entry.minutes ?? []).join(','), ...(entry.hours !== undefined ? { hour: entry.hours.join(',') } : {}) };
}

/**
 * How long a run may go without a healthy run before its heartbeat alarms: `evaluationPeriods` periods of
 * `periodMinutes`, every one of them missing or unhealthy. Hourly gets four, since the specs reconcile skips the two
 * hours the daily passes take.
 */
export function heartbeatOf(entry: ScheduleEntry): { periodMinutes: number; evaluationPeriods: number } {
  if (entry.hours?.length === 1) return { periodMinutes: 24 * 60, evaluationPeriods: 2 };
  if ((entry.minutes?.length ?? 0) > 1) return { periodMinutes: 15, evaluationPeriods: 3 };
  return { periodMinutes: 60, evaluationPeriods: 4 };
}

/**
 * Heartbeats the schedule alone would set off: a period not yet reached its run counts as missing, so one over E
 * periods alarms if E - 1 periods in a row before it have no run. Empty when every heartbeat holds.
 */
export function heartbeatGaps(entries: ScheduleEntry[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.venue || entry.variant || (entry.mode !== 'sweep' && entry.mode !== 'reconcile')) continue;
    const { periodMinutes, evaluationPeriods } = heartbeatOf(entry);
    const periodsPerDay = (24 * 60) / periodMinutes;
    // Two days, so a gap across midnight shows.
    const covered = new Set(occurrences(entry).flatMap(([start]) => [0, 1].map(day => Math.floor((day * 24 * 60 + start) / periodMinutes))));
    let run = 0;
    for (let p = 0; p < 2 * periodsPerDay; p++) {
      run = covered.has(p) ? 0 : run + 1;
      if (run >= evaluationPeriods - 1) {
        found.push(`${label(entry)}: ${run} ${periodMinutes}-minute periods with no run, for a heartbeat over ${evaluationPeriods}`);
        break;
      }
    }
  }
  return found;
}
