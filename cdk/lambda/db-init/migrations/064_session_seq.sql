-- A small number per session that is never reused, which the order gateway uses as the session's slot. Polymarket US
-- takes no client order id, so the gateway names each resting order by its expiry stamp, built from the slot and the
-- session's order counter; that stamp is also the order's exchange_order_id in the ledger. Two sessions sharing a
-- slot, at once or years apart, would repeat stamps, so a hash of the session id can't stand in for it.
ALTER TABLE strategy.session ADD COLUMN session_seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE strategy.session ADD CONSTRAINT strategy_session_seq_key UNIQUE (session_seq);
