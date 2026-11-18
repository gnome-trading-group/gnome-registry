-- The zone, by this account's name (us-east-2b, as availability_zone is), of the gateway a session trades through in
-- its region, as the launcher saw it when placing the session; null when that gateway wasn't running, or the session
-- trades through none. Beside availability_zone it shows a session placed in another zone than its gateway (no
-- capacity there, or a zone the caller named).
ALTER TABLE strategy.session ADD COLUMN gateway_zone VARCHAR(20);
