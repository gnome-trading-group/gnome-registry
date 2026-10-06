-- Sessions that ended before the session monitor began releasing kills on instance termination still hold an
-- enabled kill switch, which blocks nothing but reads as an active halt. The hour's margin skips any stop whose
-- instance might still be terminating.
SELECT set_config('gnome.actor', 'system', true), set_config('gnome.reason', 'session ended before kill release existed', true);

UPDATE risk.policy p
SET enabled = false, date_modified = NOW()
FROM strategy.session s
WHERE p.policy_type = 'KILL_SWITCH'
  AND p.enabled
  AND p.session_id = s.session_id
  AND s.status IN ('STOPPED', 'FAILED')
  AND COALESCE(s.stopped_at, s.date_modified) < NOW() - INTERVAL '1 hour';
