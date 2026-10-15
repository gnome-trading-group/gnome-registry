import { Delivery, Severity } from '../model';
import { sendWithRetry } from './http';

// Every alert as one message in the stage's channel, laid out like AWS Chatbot's alarm messages: a coloured bar,
// a bold header, the reason, what it concerns as labelled fields, the first thing to do, and the runbook. Resolving it
// turns the same message green and short, so the channel reads as what's still wrong. Colours are Slack's own.

const COLOR: Record<Severity, string> = { CRITICAL: '#E01E5A', ERROR: '#A4262C', WARNING: '#ECB22E', INFO: '#36C5F0' };
const RESOLVED_COLOR = '#2EB67D';
// Taken in hand but not over: muted until it clears.
const ACKNOWLEDGED_COLOR = '#9EA0A6';
const ICON: Record<Severity, string> = {
  CRITICAL: ':rotating_light:', ERROR: ':x:', WARNING: ':warning:', INFO: ':information_source:',
};
const SEVERITY_LABEL: Record<Severity, string> = { CRITICAL: 'Critical', ERROR: 'Error', WARNING: 'Warning', INFO: 'Info' };
// What an alert concerns, in the order the fields show it.
const FIELDS: [string, string][] = [
  ['strategy', 'Strategy'], ['symbol', 'Listing'], ['exchange', 'Exchange'], ['account', 'Account'],
  ['subject', 'Part'], ['rule', 'Rule'], ['pipeline', 'Pipeline'], ['alarmName', 'Alarm'], ['region', 'Region'],
];
// Slack shows at most ten fields, two to a row.
const MAX_FIELDS = 10;

// Slack reads <, > and & as markup (<!channel> pings everyone), so text from strategies and venues is escaped.
export function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface SlackTarget {
  token: string;
  channel: string;
  controllerUrl: string;
  stage: string;
}

function since(firstSeen: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(firstSeen).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 || hours >= 24 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

function utcTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

// A stack trace keeps its lines in a code block; anything else reads as a quote.
function reason(body: string): string {
  const text = escape(body);
  return text.includes('\n') ? `\`\`\`${text}\`\`\`` : text.split('\n').map(line => `> ${line}`).join('\n');
}

export function firingMessage(d: Delivery, target: Pick<SlackTarget, 'controllerUrl' | 'stage'>) {
  const header = `${ICON[d.severity]}  *${SEVERITY_LABEL[d.severity]}*  ·  *${escape(d.title)}*`
    + (d.unpersisted ? '\n_Not recorded: the registry was unreachable_' : '');
  const fields = FIELDS.filter(([key]) => d.labels[key]).map(([key, label]) => [label, escape(d.labels[key])]);
  if (d.mode) fields.push(['Mode', d.mode]);
  if (d.sessionId) fields.push(['Session', escape(d.sessionId)]);
  if (d.actor) fields.push(['By', escape(d.actor)]);
  if (d.status === 'FIRING' && d.labels.since) fields.push(['Since', utcTime(d.labels.since)]);

  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: header } }];
  if (d.body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: reason(d.body) } });
  if (fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: fields.slice(0, MAX_FIELDS).map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}*\n${value}` })),
    });
  }
  if (d.runbook?.firstSteps[0]) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:point_right:  ${escape(d.runbook.firstSteps[0])}` } });
  }
  const buttons: { text: string; url: string; primary?: boolean }[] = [];
  if (d.runbook) buttons.push({ text: ':book:  Runbook', url: d.runbook.url, primary: true });
  if (d.sessionId) buttons.push({ text: 'Session', url: `${target.controllerUrl}/sessions/${encodeURIComponent(d.sessionId)}` });
  for (const link of d.links) buttons.push({ text: link.title, url: link.url });
  buttons.push({ text: 'All alerts', url: `${target.controllerUrl}/system/alerts` });
  blocks.push({
    type: 'actions',
    elements: buttons.slice(0, 3).map(b => ({
      type: 'button', text: { type: 'plain_text', text: b.text }, url: b.url, ...(b.primary ? { style: 'primary' } : {}),
    })),
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `gnome alerts  ·  ${target.stage}  ·  first seen ${utcTime(d.firstSeen)}` }],
  });
  return {
    text: `${SEVERITY_LABEL[d.severity]}: ${d.title}`,
    attachments: [{ color: COLOR[d.severity], blocks }],
  };
}

export function resolvedMessage(d: Delivery, target: Pick<SlackTarget, 'stage'>, now: Date) {
  const by = d.acknowledgedBy ? `  ·  acknowledged by ${escape(d.acknowledgedBy)}` : '';
  const note = d.acknowledgedReason ? [{ type: 'section', text: { type: 'mrkdwn', text: reason(d.acknowledgedReason) } }] : [];
  return {
    text: `Resolved: ${d.title}`,
    attachments: [{
      color: RESOLVED_COLOR,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark:  *Resolved*  ·  ${escape(d.title)}` } },
        ...note,
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${SEVERITY_LABEL[d.severity]}  ·  after ${since(d.firstSeen, now)}${by}  ·  gnome alerts  ·  ${target.stage}` }],
        },
      ],
    }],
  };
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

export function acknowledgedMessage(d: Delivery, target: Pick<SlackTarget, 'stage'>, now: Date) {
  return {
    text: `Acknowledged: ${d.title}`,
    attachments: [{
      color: ACKNOWLEDGED_COLOR,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:ballot_box_with_check:  *Acknowledged*  ·  ${escape(d.title)}` } },
        ...(d.acknowledgedReason ? [{ type: 'section', text: { type: 'mrkdwn', text: reason(d.acknowledgedReason) } }] : []),
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `by ${escape(d.acknowledgedBy ?? 'someone')}  ·  ${SEVERITY_LABEL[d.severity]}  ·  open ${since(d.firstSeen, now)}`
              + `  ·  resolves when it clears  ·  ${target.stage}`,
          }],
        },
      ],
    }],
  };
}

/** @return the message's ts, so resolving the alert can edit it */
export async function sendToSlack(d: Delivery, target: SlackTarget, now = new Date()): Promise<string | null> {
  const { token, channel } = target;
  if (d.status === 'FIRING' && !d.acknowledgedBy) {
    const posted = await call('chat.postMessage', token, { channel, ...firingMessage(d, target) });
    return posted.ts ?? null;
  }
  const message = d.status === 'FIRING' ? acknowledgedMessage(d, target, now) : resolvedMessage(d, target, now);
  if (!d.slackTs) {
    const posted = await call('chat.postMessage', token, { channel, ...message });
    return posted.ts ?? null;
  }
  await call('chat.update', token, { channel, ts: d.slackTs, ...message });
  return d.slackTs;
}
