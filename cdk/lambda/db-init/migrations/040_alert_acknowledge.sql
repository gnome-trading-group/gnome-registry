-- Acknowledging an alert: someone has it in hand. An ongoing problem (a monitoring rule's finding, a CloudWatch alarm)
-- stays open while it lasts, so it can't page again, and resolves on its own once it clears; Slack and incident.io are
-- told it's been taken. A reported event has nothing left to wait for, so closing it resolves it.
ALTER TABLE alert.alert
    ADD COLUMN acknowledged_by TEXT,
    ADD COLUMN acknowledged_at TIMESTAMPTZ;
