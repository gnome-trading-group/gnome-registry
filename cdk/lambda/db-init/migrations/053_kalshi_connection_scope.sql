-- Kalshi counts market-data connections per account, not per key: measured 2026-10-27 against prod with two keys of
-- one account, the first opened 200 and the second none while those were held. A second key on an account adds no
-- connections; more capacity takes another account. connections_per_scope stays 180, room under the 200 for a
-- connection being replaced make-before-break.
UPDATE md.source SET connection_scope = 'ACCOUNT', date_modified = NOW() WHERE adapter = 'KALSHI';
