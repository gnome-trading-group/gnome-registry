-- Why someone took an alert, optionally: "known issue, venue maintenance until 3pm". Shown wherever the
-- acknowledgement is (Slack, the controller), so the next person doesn't chase the same thing.
ALTER TABLE alert.alert ADD COLUMN acknowledged_reason TEXT;
