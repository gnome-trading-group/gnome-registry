-- An operator asking for a running order gateway to be rolled onto the release a fresh start would run, without
-- cancelling its orders. Only the request lives here: gnome-orchestrator's gateway reconciler carries the roll out and
-- records how it went in its `order-gateway#<key>#roll` item in `service-endpoints`. A request is new while it is later
-- than the one that item last took.
ALTER TABLE account_master.gateway
    ADD COLUMN roll_requested_at TIMESTAMPTZ,
    ADD COLUMN roll_requested_by TEXT;
