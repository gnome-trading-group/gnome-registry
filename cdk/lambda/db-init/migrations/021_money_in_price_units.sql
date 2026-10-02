-- Money was stored at price scale × size scale (1e15 per dollar), which overflows a bigint (and the Java
-- long that produces it) at about $9,223. Every money value moves to price units (1e9 per dollar), the
-- unit fees already use.
--
-- The runner applies this file once, but the divides must never run twice even if this SQL is re-run by
-- hand. realized_pnl changing from double precision to bigint happens inside the same guarded block, so
-- its type records whether the rescale has already happened: a second run finds bigint and does nothing.
DO $$
BEGIN
    IF (SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'pnl' AND table_name = 'snapshot' AND column_name = 'realized_pnl') = 'double precision' THEN

        UPDATE sm.listing_spec
        SET min_notional = round(min_notional::numeric / 1000000)::bigint;

        ALTER TABLE pnl.snapshot
            ALTER COLUMN realized_pnl TYPE bigint USING round(realized_pnl::numeric / 1000000)::bigint;
        UPDATE pnl.snapshot
        SET unrealized_pnl = round(unrealized_pnl::numeric / 1000000)::bigint,
            total_pnl = round(total_pnl::numeric / 1000000)::bigint;

        UPDATE risk.policy
        SET parameters = jsonb_set(parameters, '{maxNotionalValue}',
                to_jsonb(round((parameters->>'maxNotionalValue')::numeric / 1000000)::bigint))
        WHERE parameters ? 'maxNotionalValue';
        UPDATE risk.policy
        SET parameters = jsonb_set(parameters, '{maxLoss}',
                to_jsonb(round((parameters->>'maxLoss')::numeric / 1000000)::bigint))
        WHERE parameters ? 'maxLoss';
    END IF;
END $$;
