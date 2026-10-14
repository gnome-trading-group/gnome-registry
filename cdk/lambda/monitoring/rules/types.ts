// What the monitoring rules find wrong with trading right now. The controller's overview shows these, and the alert
// tick pages on them, so a change here changes who gets woken up: keys must stay stable (a new key resolves the old
// alert and opens a new one), and severity here is only how the overview ranks a finding, never how loudly it pages
// (that's the alert catalog's job).

export type Mode = 'live' | 'paper';
export type DisplaySeverity = 'critical' | 'warning' | 'info';

export interface Finding {
  kind: string;
  // Identifies one problem across ticks: the kind plus whatever it concerns. Never built from a title, which carries
  // live durations.
  key: string;
  // The part of the target the finding is about when ids alone don't say (an agent's or gateway's name).
  subject: string | null;
  // Who the problem matters to, for routing; one mode per finding.
  mode: Mode;
  // The overview pages it shows on. Defaults to its own mode; a halt with no session shows on both.
  visibleIn: Mode[];
  severity: DisplaySeverity;
  title: string;
  detail: string | null;
  since: string | null;
  strategyId: number | null;
  strategyName: string | null;
  sessionId: string | null;
  listingId: number | null;
  symbol: string | null;
  exchangeId: number | null;
  exchangeName: string | null;
  accountId: number | null;
  accountLabel: string | null;
  // Who last turned a kill switch on (halts only).
  actor: string | null;
  // Numbers behind the title, for alerts to use without parsing it.
  facts: Record<string, number>;
  // False for what the overview shows but nobody should be paged about.
  alertable: boolean;
}

export type FindingFields = Partial<Omit<Finding, 'kind' | 'key' | 'severity' | 'title' | 'mode'>>;

export function finding(mode: Mode, severity: DisplaySeverity, kind: string, keyParts: (string | number | null)[],
  title: string, fields: FindingFields = {}): Finding {
  return {
    kind, key: [kind, ...keyParts.map(p => p ?? '-')].join(':'), mode, severity, title,
    subject: null, visibleIn: [mode], detail: null, since: null, strategyId: null, strategyName: null, sessionId: null,
    listingId: null, symbol: null, exchangeId: null, exchangeName: null, accountId: null, accountLabel: null,
    actor: null, facts: {}, alertable: true, ...fields,
  };
}

export function seconds(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

export function money(value: unknown): string {
  const v = typeof value === 'bigint' ? value : BigInt(String(value ?? 0));
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  return `${sign}$${abs / 1_000_000_000n}.${String((abs % 1_000_000_000n) / 10_000_000n).padStart(2, '0')}`;
}
