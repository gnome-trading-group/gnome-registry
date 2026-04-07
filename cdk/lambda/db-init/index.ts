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
`;

exports.handler = async () => {
  const client = await connectDatabase();

  await client.query(QUERY);
  await client.end();
};
