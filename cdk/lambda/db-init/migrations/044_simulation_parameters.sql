-- How each exchange behaves in simulation: network and order latency, when market data arrives (backtests), queue
-- position and self-trade prevention. Paper sessions and backtests take these for every listing on the exchange unless
-- the run overrides a block, so they are typed once here instead of into every config. Fees are not here: they come
-- from sm.fee_schedule.
--
-- Unlike fee schedules these are dated only by when they were recorded. They are our estimate of the venue, not a fact
-- that changed at a moment, so a better estimate should apply to every period it is used for. A run reads the latest
-- row recorded at or before the time it pins (simulation.asof) and gets the same parameters when replayed. Rows are
-- append-only; a change is a new row.
CREATE TABLE sm.simulation_parameters (
  simulation_parameters_id BIGSERIAL PRIMARY KEY,
  exchange_id INTEGER NOT NULL REFERENCES sm.exchange (exchange_id),
  definition JSONB NOT NULL,
  note VARCHAR,
  actor VARCHAR,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX simulation_parameters_exchange_recorded_idx
  ON sm.simulation_parameters (exchange_id, recorded_at DESC, simulation_parameters_id DESC);

-- Prediction markets: log-normal network latency fitted to recorded Polymarket and Kalshi market data (with the
-- venues' publish batching taken out), and the order latency research has used: 5ms to process, 250ms more to take.
-- Hyperliquid and Lighter keep the values research has used for them. Recorded from the epoch so runs pinned to any
-- earlier time still resolve.
INSERT INTO sm.simulation_parameters (exchange_id, definition, note, actor, recorded_at)
SELECT e.exchange_id, s.definition::jsonb, s.note, 'migration 044', '1970-01-01T00:00:00Z'
FROM sm.exchange e
JOIN (VALUES
  ('KALSHI',
   '{"network_latency":{"type":"lognormal","floor_nanos":5000000,"median_nanos":12000000,"p99_nanos":200000000},"order_processing_latency":{"type":"maker_taker","base_nanos":5000000,"taker_delay_nanos":250000000,"maker_delay_nanos":0},"market_data_latency":{"type":"recorded","fallback":{"type":"static","latency_nanos":50000000}},"queue_model":{"type":"risk_averse"},"self_trade_prevention":"CANCEL_INCOMING"}',
   'Network latency fitted to recorded market data; order latency from research'),
  ('POLYMARKET_INTL',
   '{"network_latency":{"type":"lognormal","floor_nanos":5000000,"median_nanos":12000000,"p99_nanos":200000000},"order_processing_latency":{"type":"maker_taker","base_nanos":5000000,"taker_delay_nanos":250000000,"maker_delay_nanos":0},"market_data_latency":{"type":"recorded","fallback":{"type":"static","latency_nanos":50000000}},"queue_model":{"type":"risk_averse"},"self_trade_prevention":"CANCEL_INCOMING"}',
   'Network latency fitted to recorded market data; order latency from research'),
  ('POLYMARKET_US',
   '{"network_latency":{"type":"lognormal","floor_nanos":5000000,"median_nanos":12000000,"p99_nanos":200000000},"order_processing_latency":{"type":"maker_taker","base_nanos":5000000,"taker_delay_nanos":250000000,"maker_delay_nanos":0},"market_data_latency":{"type":"recorded","fallback":{"type":"static","latency_nanos":50000000}},"queue_model":{"type":"risk_averse"},"self_trade_prevention":"CANCEL_INCOMING"}',
   'Network latency fitted to recorded market data; order latency from research'),
  ('HYPERLIQUID',
   '{"network_latency":{"type":"static","latency_nanos":20000000},"order_processing_latency":{"type":"static","latency_nanos":5000000},"market_data_latency":{"type":"recorded","fallback":{"type":"static","latency_nanos":50000000}},"queue_model":{"type":"risk_averse"},"self_trade_prevention":"CANCEL_INCOMING"}',
   'Research profile (gnomepy-research profiles/hyperliquid.yaml)'),
  ('LIGHTER',
   '{"network_latency":{"type":"static","latency_nanos":200000000},"order_processing_latency":{"type":"static","latency_nanos":500000},"market_data_latency":{"type":"recorded","fallback":{"type":"static","latency_nanos":50000000}},"queue_model":{"type":"risk_averse"},"self_trade_prevention":"CANCEL_INCOMING"}',
   'Research profile (gnomepy-research profiles/lighter.yaml)')
) AS s (exchange_code, definition, note) ON s.exchange_code = e.exchange_code;
