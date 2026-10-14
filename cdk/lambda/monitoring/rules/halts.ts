import { PoolClient } from 'pg';
import { Finding, finding, Mode } from './types';

// Every enabled kill switch, except those of sessions that have ended or are being stopped: a stop kills its own
// session, which is routine. Which mode a halt matters to: a session's own; a strategy's, live if any of its live
// sessions is active (a strategy halt stops them all); an exchange-wide or global one, always live. One with no
// session shows on both overviews, as it applies to both.
export async function halts(client: PoolClient): Promise<Finding[]> {
  const kills = (await client.query(`
    SELECT p.policy_id, p.strategy_id, p.listing_id, p.exchange_id, p.session_id, p.date_modified, s.mode AS session_mode,
      st.name AS strategy_name, l.exchange_security_symbol AS symbol, e.exchange_name, h.actor, h.reason,
      EXISTS (SELECT 1 FROM strategy.session ls WHERE ls.strategy_id = p.strategy_id AND ls.mode = 'live'
        AND ls.status IN ('SUBMITTED', 'STARTING', 'RUNNING')) AS strategy_live
    FROM risk.policy p
    LEFT JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    LEFT JOIN sm.exchange e ON e.exchange_id = p.exchange_id
    LEFT JOIN strategy.session s ON s.session_id = p.session_id
    LEFT JOIN LATERAL (
      SELECT actor, reason FROM risk.policy_history ph WHERE ph.policy_id = p.policy_id
      ORDER BY ph.history_id DESC LIMIT 1
    ) h ON TRUE
    WHERE p.policy_type = 'KILL_SWITCH' AND p.enabled
      AND (p.session_id IS NULL OR s.status IN ('SUBMITTED', 'STARTING', 'RUNNING'))
    ORDER BY p.policy_id`)).rows;

  return kills.map(k => {
    const mode: Mode = k.session_id !== null ? k.session_mode
      : k.strategy_id !== null && !k.strategy_live ? 'paper' : 'live';
    const fields = {
      strategyId: k.strategy_id, strategyName: k.strategy_name, sessionId: k.session_id, listingId: k.listing_id,
      symbol: k.symbol, exchangeId: k.exchange_id, exchangeName: k.exchange_name, actor: k.actor ?? null,
      detail: k.reason || null, since: k.date_modified?.toISOString() ?? null,
      visibleIn: k.session_id !== null ? [mode] : ['live', 'paper'] as Mode[],
    };
    const key = [k.policy_id];
    if (k.exchange_id !== null && k.strategy_id === null) {
      return finding(mode, 'critical', 'EXCHANGE_HALT', key, `All trading on ${k.exchange_name} is halted`, fields);
    }
    if (k.exchange_id !== null) {
      return finding(mode, 'warning', 'STRATEGY_EXCHANGE_HALT', key, `Strategy halted on ${k.exchange_name}`, fields);
    }
    if (k.strategy_id === null && k.listing_id === null) {
      return finding(mode, 'critical', 'GLOBAL_HALT', key, 'All trading is halted', fields);
    }
    if (k.session_id !== null) return finding(mode, 'warning', 'SESSION_HALT', key, 'Session killed', fields);
    if (k.strategy_id !== null && k.listing_id === null) {
      return finding(mode, 'warning', 'STRATEGY_HALT', key, 'Strategy killed', fields);
    }
    return finding(mode, 'warning', 'LISTING_HALT', key,
      k.strategy_id === null ? 'Listing halted for every strategy' : 'Listing halted', fields);
  });
}
