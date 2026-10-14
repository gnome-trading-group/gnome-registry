-- Venue accounts: which account on an exchange a live session trades with. Polymarket Intl wallets are public, so
-- the firm keeps a pool of them and rotates through it rather than showing its whole book on one address; other
-- venues have one account each. Credentials stay in Secrets Manager: a row only names the secret holding them.
CREATE SCHEMA account_master;

-- A label is a random gamer tag (adjective-noun-NN), so a name seen in logs or the controller says nothing about
-- what trades on it. venue_ref holds the venue's public identifiers for the account: the signer and funder addresses
-- and signature type on Polymarket Intl, the subaccount number on Kalshi.
--   PROVISIONING registered, not yet trusted to trade (no balance seen yet)
--   ACTIVE       new sessions may be bound to it
--   DRAINING     no new sessions; what it holds is left to resolve, and nothing is moved to another account, since
--                an on-chain transfer would link the two wallets publicly
--   RETIRED      empty and no longer polled
CREATE TABLE account_master.venue_account (
    account_id          SERIAL      PRIMARY KEY,
    exchange_id         INTEGER     NOT NULL REFERENCES sm.exchange (exchange_id),
    label               TEXT        NOT NULL UNIQUE CHECK (label ~ '^[a-z]+-[a-z]+-[0-9]{2}$'),
    status              VARCHAR(12) NOT NULL DEFAULT 'PROVISIONING'
                        CHECK (status IN ('PROVISIONING', 'ACTIVE', 'DRAINING', 'RETIRED')),
    venue_ref           JSONB       NOT NULL DEFAULT '{}',
    trading_secret_name TEXT        NOT NULL,
    -- Null where reading balances and positions needs no credentials (Polymarket Intl reads the chain).
    read_secret_name    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at        TIMESTAMPTZ,
    draining_at         TIMESTAMPTZ,
    retired_at          TIMESTAMPTZ,
    actor               TEXT,
    note                TEXT
);

CREATE INDEX idx_venue_account_exchange_status ON account_master.venue_account (exchange_id, status);

-- Every status change, attributed the same way as risk.policy_history (gnome.actor / gnome.reason set by the writer).
CREATE TABLE account_master.venue_account_history (
    history_id  BIGSERIAL   PRIMARY KEY,
    account_id  INTEGER     NOT NULL,
    old_status  VARCHAR(12),
    new_status  VARCHAR(12) NOT NULL,
    actor       TEXT,
    reason      TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_venue_account_history_account ON account_master.venue_account_history (account_id, changed_at DESC);

CREATE OR REPLACE FUNCTION account_master.record_venue_account_history() RETURNS trigger AS $$
DECLARE
    v_actor  TEXT := NULLIF(current_setting('gnome.actor', true), '');
    v_reason TEXT := NULLIF(current_setting('gnome.reason', true), '');
BEGIN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO account_master.venue_account_history (account_id, old_status, new_status, actor, reason)
        VALUES (NEW.account_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, v_actor, v_reason);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_venue_account_history
    AFTER INSERT OR UPDATE OF status ON account_master.venue_account
    FOR EACH ROW EXECUTE FUNCTION account_master.record_venue_account_history();

-- The account each live session trades each of its exchanges with, chosen once when the session is created.
CREATE TABLE account_master.session_venue_account (
    session_id  TEXT    NOT NULL REFERENCES strategy.session (session_id),
    exchange_id INTEGER NOT NULL REFERENCES sm.exchange (exchange_id),
    account_id  INTEGER NOT NULL REFERENCES account_master.venue_account (account_id),
    PRIMARY KEY (session_id, exchange_id)
);

CREATE INDEX idx_session_venue_account_account ON account_master.session_venue_account (account_id);

-- One account per exchange that already traded live, holding that exchange's existing credentials. Its label is
-- fixed rather than random only so this migration is repeatable across environments.
INSERT INTO account_master.venue_account (exchange_id, label, status, trading_secret_name, activated_at, actor, note)
SELECT e.exchange_id,
       CASE e.exchange_code
           WHEN 'KALSHI' THEN 'steady-heron-01'
           WHEN 'POLYMARKET_INTL' THEN 'quiet-falcon-01'
           WHEN 'POLYMARKET_US' THEN 'brisk-badger-01'
       END,
       'ACTIVE',
       CASE e.exchange_code
           WHEN 'KALSHI' THEN 'gnome/exchange-credentials/kalshi'
           WHEN 'POLYMARKET_INTL' THEN 'gnome/exchange-credentials/polymarket-intl'
           WHEN 'POLYMARKET_US' THEN 'gnome/exchange-credentials/polymarket-us'
       END,
       NOW(), 'migration 036', 'the exchange''s original account'
FROM sm.exchange e
WHERE e.exchange_code IN ('KALSHI', 'POLYMARKET_INTL', 'POLYMARKET_US');

-- Positions are held by an account, so the ledger records which one. Null in paper mode, which trades no account.
ALTER TABLE ledger.fill ADD COLUMN account_id INTEGER REFERENCES account_master.venue_account (account_id);
ALTER TABLE ledger.order ADD COLUMN account_id INTEGER REFERENCES account_master.venue_account (account_id);
ALTER TABLE ledger.position ADD COLUMN account_id INTEGER REFERENCES account_master.venue_account (account_id);

UPDATE ledger.fill f SET account_id = a.account_id
FROM sm.listing l JOIN account_master.venue_account a ON a.exchange_id = l.exchange_id
WHERE f.mode = 'live' AND l.listing_id = f.listing_id;

UPDATE ledger.order o SET account_id = a.account_id
FROM account_master.venue_account a
WHERE o.mode = 'live' AND a.exchange_id = o.exchange_id;

UPDATE ledger.position p SET account_id = a.account_id
FROM sm.listing l JOIN account_master.venue_account a ON a.exchange_id = l.exchange_id
WHERE p.mode = 'live' AND l.listing_id = p.listing_id;

INSERT INTO account_master.session_venue_account (session_id, exchange_id, account_id)
SELECT DISTINCT sl.session_id, l.exchange_id, a.account_id
FROM strategy.session_listing sl
JOIN strategy.session s ON s.session_id = sl.session_id
JOIN sm.listing l ON l.listing_id = sl.listing_id
JOIN account_master.venue_account a ON a.exchange_id = l.exchange_id
WHERE s.mode = 'live';

-- A strategy now holds a listing once per account. NULLS NOT DISTINCT keeps one paper position per listing.
ALTER TABLE ledger.position DROP CONSTRAINT position_pkey;
ALTER TABLE ledger.position ADD COLUMN position_id BIGSERIAL PRIMARY KEY;
ALTER TABLE ledger.position ADD CONSTRAINT position_key
    UNIQUE NULLS NOT DISTINCT (strategy_id, listing_id, mode, account_id);

-- One settlement per position, and so per account.
DROP INDEX ledger.idx_fill_settlement;
CREATE UNIQUE INDEX idx_fill_settlement ON ledger.fill (strategy_id, listing_id, mode, COALESCE(account_id, 0))
    WHERE source = 'SETTLEMENT';

CREATE INDEX idx_fill_account ON ledger.fill (account_id, fill_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_order_account_open ON ledger.order (account_id) WHERE status = 'OPEN';
