ALTER TABLE strategy.strategy
  ALTER COLUMN strategy_id ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(pg_get_serial_sequence('strategy.strategy', 'strategy_id'),
              COALESCE((SELECT MAX(strategy_id) FROM strategy.strategy), 0));
