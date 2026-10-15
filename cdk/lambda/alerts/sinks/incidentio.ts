import { Delivery } from '../model';
import { sendWithRetry } from './http';

// The pager. incident.io takes alerts on an HTTP alert source: one with the same deduplication key while it fires is
// the same alert, and a resolved event closes it. Its alert route turns them into incidents and escalates to whoever
// is on call; grouping by the Session attribute keeps one dead session to one incident.

export interface IncidentIoTarget {
  alertSourceConfigId: string;
  token: string;
  controllerUrl: string;
}

export function eventFor(d: Delivery, controllerUrl: string) {
  const lines = [d.body, d.actor ? `By: ${d.actor}` : null].filter(Boolean) as string[];
  if (d.runbook) {
    lines.push('', d.runbook.summary, ...d.runbook.firstSteps.map((s, i) => `${i + 1}. ${s}`), '', `[Runbook](${d.runbook.url})`);
  }
  const metadata: Record<string, unknown> = {
    severity: d.severity, type: d.type, source: d.source, mode: d.mode, alert_id: d.alertId,
    strategy_id: d.strategyId, session_id: d.sessionId, listing_id: d.listingId, exchange_id: d.exchangeId,
    account_id: d.accountId, actor: d.actor, runbook_url: d.runbook?.url ?? null, stage: process.env.STAGE,
    ...d.labels,
  };
  return {
    title: d.title,
    description: lines.join('\n'),
    deduplication_key: d.key,
    // Acknowledged in the controller: someone has it, so the page stops.
    status: d.status === 'FIRING' && !d.acknowledgedBy ? 'firing' : 'resolved',
    source_url: d.sessionId ? `${controllerUrl}/sessions/${encodeURIComponent(d.sessionId)}` : `${controllerUrl}/system/alerts`,
    metadata,
  };
}

export async function sendToIncidentIo(d: Delivery, target: IncidentIoTarget): Promise<void> {
  const res = await sendWithRetry(() => fetch(
    `https://api.incident.io/v2/alert_events/http/${encodeURIComponent(target.alertSourceConfigId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
      body: JSON.stringify(eventFor(d, target.controllerUrl)),
    }));
  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`incident.io refused the alert: ${res.status} ${await res.text()}`);
  }
}
