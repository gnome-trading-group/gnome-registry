import { Delivery, Severity } from '../model';
import { sendWithRetry } from './http';

// Every alert, as one message per alert in the stage's channel; resolving it edits that message and replies in its
// thread, so the channel reads as a list of what's wrong and what isn't any more.

const COLOR: Record<Severity, string> = { CRITICAL: '#d32f2f', ERROR: '#f57c00', WARNING: '#fbc02d', INFO: '#1976d2' };
const RESOLVED_COLOR = '#2e7d32';
const ICON: Record<Severity, string> = { CRITICAL: ':red_circle:', ERROR: ':large_orange_circle:', WARNING: ':large_yellow_circle:', INFO: ':large_blue_circle:' };

// Slack reads <, > and & as markup (<!channel> pings everyone), so text from strategies and venues is escaped.
export function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface SlackTarget {
  token: string;
  channel: string;
  controllerUrl: string;
}

const CONTEXT_LABELS: [string, string][] = [
  ['strategy', 'Strategy'], ['symbol', 'Listing'], ['exchange', 'Exchange'], ['account', 'Account'],
  ['subject', 'Part'], ['alarmName', 'Alarm'], ['region', 'Region'],
];

export function messageFor(d: Delivery, controllerUrl: string, resolved: boolean) {
  const heading = resolved
    ? `:white_check_mark: *Resolved:* ${escape(d.title)}`
    : `${ICON[d.severity]} *${d.severity}* ${escape(d.title)}${d.unpersisted ? ' _(not recorded: registry unreachable)_' : ''}`;
  const facts = CONTEXT_LABELS.filter(([name]) => d.labels[name]).map(([name, label]) => `*${label}:* ${escape(d.labels[name])}`);
  if (d.sessionId) facts.push(`*Session:* ${escape(d.sessionId)}${d.mode ? ` (${d.mode})` : ''}`);
  if (d.actor) facts.push(`*By:* ${escape(d.actor)}`);

  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: heading } }];
  if (d.body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: escape(d.body) } });
  if (facts.length > 0) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: facts.join('  ·  ') }] });
  if (!resolved && d.runbook) {
    const steps = d.runbook.firstSteps.map((s, i) => `${i + 1}. ${escape(s)}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${escape(d.runbook.summary)}\n${steps}` } });
  }
  const buttons: { text: string; url: string }[] = [];
  if (d.runbook) buttons.push({ text: 'Runbook', url: d.runbook.url });
  if (d.sessionId) buttons.push({ text: 'Session', url: `${controllerUrl}/sessions/${encodeURIComponent(d.sessionId)}` });
  buttons.push({ text: 'Alerts', url: `${controllerUrl}/system/alerts` });
  for (const link of d.links) buttons.push({ text: link.title, url: link.url });
  blocks.push({
    type: 'actions',
    elements: buttons.slice(0, 5).map(b => ({ type: 'button', text: { type: 'plain_text', text: b.text }, url: b.url })),
  });
  const fallback = `${resolved ? 'Resolved' : d.severity}: ${d.title}`;
  return { text: fallback, attachments: [{ color: resolved ? RESOLVED_COLOR : COLOR[d.severity], blocks }] };
}

async function call(method: string, token: string, payload: unknown): Promise<any> {
  const res = await sendWithRetry(() => fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }));
  const json = await res.json() as { ok: boolean; error?: string; ts?: string };
  if (!res.ok || !json.ok) throw new Error(`Slack ${method} failed: ${res.status} ${json.error ?? ''}`);
  return json;
}

/** @return the message's ts, so resolving the alert can edit it */
export async function sendToSlack(d: Delivery, target: SlackTarget): Promise<string | null> {
  const { token, channel, controllerUrl } = target;
  if (d.status === 'FIRING') {
    const posted = await call('chat.postMessage', token, { channel, ...messageFor(d, controllerUrl, false) });
    return posted.ts ?? null;
  }
  if (!d.slackTs) {
    const posted = await call('chat.postMessage', token, { channel, ...messageFor(d, controllerUrl, true) });
    return posted.ts ?? null;
  }
  await call('chat.update', token, { channel, ts: d.slackTs, ...messageFor(d, controllerUrl, true) });
  await call('chat.postMessage', token, { channel, thread_ts: d.slackTs, text: `:white_check_mark: Resolved` });
  return d.slackTs;
}
