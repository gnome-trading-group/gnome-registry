// The one shape every alert takes, whichever source raised it: the monitoring rules' tick, a service or session
// reporting an event (the ingest API, or PutEvents straight onto the bus from inside the account), or a CloudWatch
// alarm. Everything reaches the sinks the same way: bus → router → store.record (the only place an alert's state
// changes) → sinks.

export type Severity = 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO';
export const SEVERITIES: Severity[] = ['CRITICAL', 'ERROR', 'WARNING', 'INFO'];
export type Source = 'tick' | 'ingest' | 'cloudwatch';
export type Action = 'FIRING' | 'RESOLVED' | 'REDELIVER';
export type Sink = 'slack' | 'incidentio';
export type Mode = 'live' | 'paper';

// The bus every alert event travels on, and the detail-type its events carry. The name is fixed so a stack can grant
// PutEvents on it without depending on the stack that creates it.
export const ALERT_BUS_NAME = 'gnome-alerts';
export const ALERT_EVENT_SOURCE = 'gnome.alerts';
export const ALERT_DETAIL_TYPE = 'Alert';
export const METRICS_NAMESPACE = 'Gnome/Alerting';

export interface AlertEvent {
  action: Action;
  // One problem across its occurrences: repeats of an open key update it rather than notifying again.
  key: string;
  type: string;
  source: Source;
  // Only CUSTOM alerts and CloudWatch alarms bring their own; every other type's comes from the catalog.
  severity?: Severity;
  title: string;
  body?: string | null;
  actor?: string | null;
  strategyId?: number | null;
  sessionId?: string | null;
  listingId?: number | null;
  exchangeId?: number | null;
  accountId?: number | null;
  // Taken from the session when there is one; otherwise as given, and an alert with neither is about infrastructure.
  mode?: Mode | null;
  // Display context (strategy name, symbol, account, the agent a finding is about…) and routing hints: `route:
  // slack-only` keeps an alert off the pager.
  labels?: Record<string, string>;
  links?: { title: string; url: string }[];
  // When the state changed at the source; an event older than what the store already has is dropped.
  stateAt: string;
  // A resolve nobody needs to hear about (an event's day-old row closing).
  silent?: boolean;
}

export interface Runbook {
  summary: string;
  firstSteps: string[];
  url: string;
}

// An alert the router must deliver, as the store records it.
export interface Delivery {
  alertId: number | null;
  key: string;
  type: string;
  source: Source;
  status: 'FIRING' | 'RESOLVED';
  severity: Severity;
  title: string;
  body: string | null;
  actor: string | null;
  mode: Mode | null;
  strategyId: number | null;
  sessionId: string | null;
  listingId: number | null;
  exchangeId: number | null;
  accountId: number | null;
  labels: Record<string, string>;
  links: { title: string; url: string }[];
  runbook: Runbook | null;
  firstSeen: string;
  slackTs: string | null;
  sinks: Sink[];
  // Set when the store couldn't be reached: delivered anyway, but nothing recorded it.
  unpersisted?: boolean;
}

export type StoreRequest =
  | { op: 'detect'; now?: string }
  | { op: 'record'; event: AlertEvent; now?: string }
  | { op: 'markDelivered'; alertId: number; sink: Sink; slackTs?: string | null };

export type RecordResult = { notify: false } | { notify: true; delivery: Delivery };
