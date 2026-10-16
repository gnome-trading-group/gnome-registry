import { AlertEvent, Mode, Runbook, Severity, SEVERITIES } from './model';
import * as runbooks from './runbooks.generated.json';

// How loudly each type of alert pages. Severity is for a live session in prod; paper sessions and the dev stage are
// capped at ERROR so they never page, and so is CUSTOM, whose severity a strategy picks.
//   CRITICAL  money is at risk now: someone is paged
//   ERROR     needs a person today
//   WARNING   worth a look
//   INFO      for the record

interface AlertType {
  severity: Severity | ((event: AlertEvent) => Severity);
  // Ticks a rule's finding must persist before it notifies; 1 notifies at once.
  debounce: number;
  // Raised about a stop, so it still goes out while the session is stopping.
  aboutStopping?: boolean;
}

// Kill switches page when nobody chose them: the OMS escalating a breach, a ledger failure or a reject streak; a
// starting session halting an order it can't account for; anything written straight to the database. Every other
// actor (a person in the controller, the launcher, Slack, the system releasing a stopped session's kill) is for the
// record only.
export function isAutomaticActor(actor: string | null | undefined): boolean {
  return actor == null || actor === '' || actor === 'oms' || actor.startsWith('session ');
}

const halt: AlertType = { severity: e => isAutomaticActor(e.actor) ? 'CRITICAL' : 'INFO', debounce: 1 };

export const ALERT_TYPES: Record<string, AlertType> = {
  // The monitoring rules (lambda/monitoring/rules), one per finding kind.
  GLOBAL_HALT: halt,
  EXCHANGE_HALT: halt,
  STRATEGY_HALT: halt,
  STRATEGY_EXCHANGE_HALT: halt,
  LISTING_HALT: halt,
  SESSION_HALT: halt,
  SILENT: { severity: 'CRITICAL', debounce: 1 },
  LEDGER_FENCED: { severity: 'CRITICAL', debounce: 1 },
  LEDGER_FAILING: { severity: 'CRITICAL', debounce: 1 },
  RISK_STALE: { severity: 'CRITICAL', debounce: 1 },
  RISK_UNGUARDED: { severity: 'CRITICAL', debounce: 1 },
  POLICY_UNBUILDABLE: { severity: 'CRITICAL', debounce: 1 },
  LATCHES_DROPPED: { severity: 'CRITICAL', debounce: 1 },
  AGENT_EXITED: { severity: 'CRITICAL', debounce: 1 },
  // A GC pause or a slow venue call shows on the overview but mustn't page.
  AGENT_STALLED: { severity: 'ERROR', debounce: 2 },
  RECONNECTING: { severity: 'WARNING', debounce: 2 },
  BOOK_RESYNCS: { severity: 'WARNING', debounce: 1 },
  RATE_LIMIT_THROTTLING: { severity: 'WARNING', debounce: 3 },
  FAILED: { severity: 'CRITICAL', debounce: 1 },
  START_STUCK: { severity: 'ERROR', debounce: 1 },
  STOP_STUCK: { severity: 'ERROR', debounce: 1, aboutStopping: true },
  NEEDS_REVIEW: { severity: 'ERROR', debounce: 1 },
  NO_PRICE: { severity: 'INFO', debounce: 1 },
  SETTLEMENT_PENDING: { severity: 'WARNING', debounce: 1 },
  SETTLEMENT_BLOCKED: { severity: 'WARNING', debounce: 1 },
  RECON_MISMATCH: { severity: 'CRITICAL', debounce: 1 },
  RECON_STALE: { severity: 'ERROR', debounce: 1 },
  BALANCE_LOW: { severity: 'WARNING', debounce: 1 },
  SHARD_BALANCE_LOW: { severity: 'WARNING', debounce: 1 },
  ALLOCATION_EXCEEDS_BALANCE: { severity: 'ERROR', debounce: 1 },
  DRAINING_EXPOSURE: { severity: 'WARNING', debounce: 1 },
  ACCOUNT_DUE_FOR_ROTATION: { severity: 'INFO', debounce: 1 },
  ACCOUNT_READY_TO_RETIRE: { severity: 'INFO', debounce: 1 },
  FEE_MISMATCH: { severity: 'INFO', debounce: 1 },
  FEE_SCHEDULE_MISSING: { severity: 'INFO', debounce: 1 },
  FEE_SCHEDULE_CHANGED: { severity: 'INFO', debounce: 1 },
  FEE_TYPE_UNSUPPORTED: { severity: 'INFO', debounce: 1 },
  // The tick's own: several sessions going silent at once is more likely the heartbeat path than the sessions.
  SESSIONS_SILENT_MULTIPLE: { severity: 'CRITICAL', debounce: 1 },

  // Reported events.
  FATAL_ERROR: { severity: 'CRITICAL', debounce: 1 },
  STOP_WITHOUT_KILL: { severity: 'CRITICAL', debounce: 1, aboutStopping: true },
  SHUTDOWN_FAILED: { severity: 'CRITICAL', debounce: 1, aboutStopping: true },
  LAUNCH_FAILED: { severity: 'ERROR', debounce: 1 },
  LAUNCH_SUCCEEDED: { severity: 'INFO', debounce: 1 },
  SESSION_STOPPED_AUTO: { severity: 'INFO', debounce: 1, aboutStopping: true },
  // A strategy ending its own session; WARNING when it couldn't close everything it held before its time ran out.
  SESSION_EXITED: { severity: e => e.severity === 'WARNING' ? 'WARNING' : 'INFO', debounce: 1, aboutStopping: true },
  // A scheduled run's output feeds trading (a launcher rule reads it); whoever started a run by hand saw it fail.
  PIPELINE_FAILED: { severity: e => e.labels?.trigger === 'scheduled' ? 'ERROR' : 'INFO', debounce: 1 },
  CUSTOM: { severity: e => e.severity ?? 'WARNING', debounce: 1 },

  // From the alarm's name: cdk-monitoring-constructs ends it with the tier it was declared under.
  CLOUDWATCH_ALARM: { severity: e => e.severity ?? 'WARNING', debounce: 1 },
};

export function alertType(type: string): AlertType {
  return ALERT_TYPES[type] ?? ALERT_TYPES.CUSTOM;
}

// An unknown type is kept but downgraded, so a producer deployed before the catalog that knows it isn't lost.
export function normalizeType(event: AlertEvent): AlertEvent {
  if (ALERT_TYPES[event.type]) return event;
  return { ...event, type: 'CUSTOM', severity: 'WARNING', labels: { ...event.labels, originalType: event.type } };
}

export function rank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

function cap(severity: Severity, max: Severity): Severity {
  return rank(severity) < rank(max) ? max : severity;
}

export function severityOf(event: AlertEvent, mode: Mode | null, stage: string): Severity {
  let severity = (() => {
    const s = alertType(event.type).severity;
    return typeof s === 'function' ? s(event) : s;
  })();
  if (event.type === 'CUSTOM') severity = cap(severity, 'ERROR');
  if (mode === 'paper' || stage !== 'prod') severity = cap(severity, 'ERROR');
  return severity;
}

// CloudWatch alarm names start with their service's prefix ("Registry-…"), the same grouping the System page uses.
export function cloudwatchService(alarmName: string): string {
  const dash = alarmName.indexOf('-');
  return dash > 0 ? alarmName.slice(0, dash) : 'Other';
}

export function runbookFor(event: AlertEvent): Runbook | null {
  const book = runbooks as { alerts: Record<string, Runbook>; cloudwatch: Record<string, Runbook> };
  if (event.type === 'CLOUDWATCH_ALARM') {
    return book.cloudwatch[cloudwatchService(event.labels?.alarmName ?? '')] ?? null;
  }
  return book.alerts[event.type] ?? null;
}
