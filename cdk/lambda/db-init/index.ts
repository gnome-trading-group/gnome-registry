import { connectDatabase } from "../connections";

const QUERY = `
CREATE SCHEMA IF NOT EXISTS sm;

CREATE TABLE IF NOT EXISTS sm.security (
	security_id serial primary key,
	symbol VARCHAR not NULL,
	type smallint not null,
	description VARCHAR,
	date_modified timestamp not null default now(),
	date_created timestamp not null default now()
);

CREATE TABLE IF NOT EXISTS sm.exchange (
	exchange_id serial primary key,
	exchange_name VARCHAR not NULL,
	region varchar not null,
	schema_type varchar not null,
	date_modified timestamp not null default now(),
	date_created timestamp not null default now()
);

CREATE TABLE IF NOT EXISTS sm.listing (
	listing_id serial primary key,
	security_id integer references sm.security (security_id) not null,
	exchange_id integer references sm.exchange (exchange_id) not null,
	exchange_security_id varchar,
	exchange_security_symbol varchar,
	date_modified timestamp not null default now(),
	date_created timestamp not null default now()
);


CREATE TABLE IF NOT EXISTS sm.listing_spec (
	listing_id    integer PRIMARY KEY REFERENCES sm.listing(listing_id) NOT NULL,
	tick_size     bigint  NOT NULL,
	lot_size      bigint  NOT NULL,
	min_notional  bigint,
	date_modified timestamp NOT NULL DEFAULT now(),
	date_created  timestamp NOT NULL DEFAULT now()
);

CREATE SCHEMA IF NOT EXISTS strategy;

CREATE TABLE IF NOT EXISTS strategy.strategy (
	strategy_id   integer  PRIMARY KEY,
	name          varchar  NOT NULL UNIQUE,
	description   varchar,
	status        smallint NOT NULL DEFAULT 0,
	parameters    jsonb,
	date_modified timestamp NOT NULL DEFAULT now(),
	date_created  timestamp NOT NULL DEFAULT now()
);

CREATE SCHEMA IF NOT EXISTS pnl;

CREATE TABLE IF NOT EXISTS pnl.snapshot (
	snapshot_id     bigserial        PRIMARY KEY,
	strategy_id     integer          NOT NULL,
	listing_id      integer          NOT NULL,
	net_quantity    bigint           NOT NULL,
	avg_entry_price bigint           NOT NULL,
	realized_pnl    double precision NOT NULL,
	total_fees      bigint           NOT NULL,
	leaves_buy_qty  bigint           NOT NULL DEFAULT 0,
	leaves_sell_qty bigint           NOT NULL DEFAULT 0,
	snapshot_time   timestamp        NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pnl_snapshot_strategy_listing
	ON pnl.snapshot (strategy_id, listing_id, snapshot_time DESC);

CREATE SCHEMA IF NOT EXISTS risk;

CREATE TABLE IF NOT EXISTS risk.policy (
	policy_id     serial   PRIMARY KEY,
	policy_type   varchar  NOT NULL,
	scope         smallint NOT NULL,
	strategy_id   integer,
	listing_id    integer,
	parameters    jsonb    NOT NULL,
	enabled       boolean  NOT NULL DEFAULT true,
	date_modified timestamp NOT NULL DEFAULT now(),
	date_created  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_policy_scope
	ON risk.policy (scope, strategy_id, listing_id) WHERE enabled = true;

INSERT INTO risk.policy (policy_type, scope, parameters, enabled)
	VALUES ('KILL_SWITCH', 0, '{}', true) ON CONFLICT DO NOTHING;
`;

exports.handler = async () => {
  const client = await connectDatabase();

  await client.query(QUERY);
  await client.end();
};
