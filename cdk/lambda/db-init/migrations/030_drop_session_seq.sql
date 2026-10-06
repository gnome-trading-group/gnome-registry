-- Kalshi client order ids carry the session id itself, so sessions need no separate short number.
ALTER TABLE strategy.session DROP COLUMN session_seq;
