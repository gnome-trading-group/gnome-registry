-- A time series of readings from the platform's processes: one row per subject (a session today; order gateways and
-- shards later), kind and moment. The registry never reads data; each kind's producer defines it and its readers
-- interpret it. Partitioned by day so expiry drops a whole partition: deleting millions of rows a day would leave the
-- table to vacuum on a small instance.
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE ops.sample (
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  -- A sample re-sent after a lost answer lands on the same key and is ignored.
  PRIMARY KEY (subject_kind, subject_id, kind, ts)
) PARTITION BY RANGE (ts);

-- Creates a partition for each UTC day from today to days_ahead days on, and drops those wholly older than keep_days.
-- Run hourly (sample-partitions); idempotent. A day must exist before its first sample: an insert with no partition
-- fails, and the heartbeat then stores its health without the samples.
CREATE FUNCTION ops.ensure_sample_partitions(days_ahead INT, keep_days INT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  today DATE := (NOW() AT TIME ZONE 'UTC')::DATE;
  day DATE;
  expired RECORD;
BEGIN
  FOR offset_days IN 0..days_ahead LOOP
    day := today + offset_days;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS ops.%I PARTITION OF ops.sample FOR VALUES FROM (%L) TO (%L)',
      'sample_' || to_char(day, 'YYYYMMDD'),
      (day::TIMESTAMP AT TIME ZONE 'UTC'),
      ((day + 1)::TIMESTAMP AT TIME ZONE 'UTC'));
  END LOOP;
  FOR expired IN
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'ops' AND p.relname = 'sample' AND c.relname ~ '^sample_\d{8}$'
      AND to_date(substring(c.relname FROM 8), 'YYYYMMDD') < today - keep_days
  LOOP
    EXECUTE format('DROP TABLE ops.%I', expired.relname);
  END LOOP;
END;
$$;

SELECT ops.ensure_sample_partitions(3, 7);
