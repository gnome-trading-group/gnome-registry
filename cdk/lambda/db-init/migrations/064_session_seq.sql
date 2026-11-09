-- A number per session that is never reused, which the order gateway uses as the session's slot. Polymarket US takes
-- no client order id, so the gateway names each resting order by its expiry stamp, built from the slot (session_seq
-- mod 100,000) and the session's order counter; that stamp is also the order's exchange_order_id in the ledger. Two
-- sessions sharing a slot would repeat stamps: with this they can only once 100,000 sessions apart, where a hash of the
-- session id collides by chance.
ALTER TABLE strategy.session ADD COLUMN session_seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE strategy.session ADD CONSTRAINT strategy_session_seq_key UNIQUE (session_seq);
