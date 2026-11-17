-- What each order was for in its strategy, so fills can be attributed through their order: a resting quote, a hedge
-- completing a fill, an arbitrage leg, or a trade closing inventory (null when the strategy didn't say). episode_id is
-- the strategy's own id for orders that belong together, a quote fill and the hedges it set off; time_in_force and
-- intent_sequence (the intent's place on the session sequence, for joining the journal) are what the OMS sent. All
-- null on orders from before they were recorded.
ALTER TABLE ledger.order
    ADD COLUMN role            VARCHAR(8) CHECK (role IN ('QUOTE', 'HEDGE', 'ARB_LEG', 'EXIT')),
    ADD COLUMN episode_id      BIGINT,
    ADD COLUMN time_in_force   VARCHAR(24)
        CHECK (time_in_force IN ('GOOD_TILL_CANCELED', 'IMMEDIATE_OR_CANCELED', 'FILL_OR_KILL')),
    ADD COLUMN intent_sequence BIGINT;
