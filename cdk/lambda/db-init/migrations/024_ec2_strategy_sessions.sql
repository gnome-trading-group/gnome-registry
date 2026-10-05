-- Strategy sessions run on per-session EC2 instances instead of Fargate tasks.
-- Status gains STARTING (instance booted, bootstrap still running); status has no CHECK constraint.
ALTER TABLE strategy.session DROP COLUMN IF EXISTS task_arn;
ALTER TABLE strategy.session DROP COLUMN IF EXISTS task_definition_arn;

ALTER TABLE strategy.session ADD COLUMN instance_id TEXT;
ALTER TABLE strategy.session ADD COLUMN instance_type VARCHAR(30);
ALTER TABLE strategy.session ADD COLUMN launch_region TEXT;
ALTER TABLE strategy.session ADD COLUMN availability_zone VARCHAR(20);
ALTER TABLE strategy.session ADD COLUMN orchestrator_version VARCHAR(30);
ALTER TABLE strategy.session ADD COLUMN gnomepy_version VARCHAR(30);

CREATE INDEX idx_session_instance ON strategy.session(instance_id) WHERE instance_id IS NOT NULL;
