# CLAUDE.md

The registry is the trading system's source of truth and control plane: one Postgres database (security master,
strategies and sessions, venue accounts and treasury, the trading ledger, risk policies and kill switches, fee
schedules, simulation parameters, market-data sources/streams, alerts) behind the Registry API (API Gateway + Lambdas),
plus the scheduled jobs and the alerting pipeline around it. Callers: running sessions (OMS/orchestrator, via the Java
client in `src/`), the controller UI, gnomepy/research, the classifier, the launcher, and gnome-bot. The repo also
publishes the Java client library `group.gnometrading:gnome-registry` to GitHub Packages.

## Commands

CDK and Lambdas (TypeScript), from `cdk/`:
- `npm ci` (needs a GitHub Packages token for `@gnome-trading-group/gnome-shared-cdk`; see `cdk/.npmrc`)
- `npm run build` - `tsc` type-check
- `npm test` - all jest tests; one file: `npx jest test/ledger-math.test.ts`; one case: add `-t '<name>'`
- `npm run runbooks` - regenerate `lambda/alerts/runbooks.generated.json` after editing `docs/runbooks/`
- `npx cdk synth` - synth the pipeline and both stages; `npm run diff-substacks` - diff every stage stack
- `npx ts-node scripts/poll-once.ts --exchange KALSHI --credentials <file>` - read one venue account as the venue
  poller does, posting nothing (other flags in the script header)

Database tests (`test/*.db.test.ts`) are skipped unless `LEDGER_TEST_DB` is set:
- Use a throwaway Postgres 16 with pgvector (migration 003 creates the `vector` extension), e.g. docker
  `pgvector/pgvector:pg16`.
- Apply every file in `lambda/db-init/migrations/` in order, each with `psql --single-transaction` (034 relies on
  `ON COMMIT DROP` temp tables).
- `LEDGER_TEST_DB=postgres://... npx jest --runInBand`. Suites truncate tables and serialize on an advisory lock
  (`test/ledger-db.ts`); the monitoring-rules/alerts suites can flake under full parallelism, pass alone.

Java client, from the repo root (Maven, Java 17):
- `mvn test`; one class: `mvn test -Dtest=group.gnometrading.SecurityMasterTest` (use the full class name)
- `mvn verify -B -s settings.xml` is what CI runs. Spotless and checkstyle (`checkstyle-strict.xml`) run at
  `validate`, so formatting fails the build; `mvn spotless:apply` fixes formatting.

CI (`.github/workflows/bump-and-deploy.yml`) runs only the Maven build: jest is not run in CI or in the pipeline's
synth step, so run `npm test` yourself before handing off.

## Layout

- `cdk/bin/cdk.ts` - app entry; only creates `RegistryPipelineStack`
- `cdk/lib/pipeline-stack.ts` - CodePipeline `RegistryPipeline` and the stage (`Dev`, `Prod`) stack wiring
- `cdk/lib/config.ts` - per-stage config: accounts, Slack channels, DB instance size, incident.io, budget, venue URLs
- `cdk/lib/stacks/*.ts` - one file per stack (see Operations); `api-stack.ts` declares every route and its callers
- `cdk/lib/constructs/db-init-lambda.ts` - migration Lambda and the ad-hoc query Lambda
- `cdk/lambda/endpoints/` - one handler per API resource; `base.ts` has `ResourceHandler`, `withTransaction`, actor helpers
- `cdk/lambda/endpoints/ledger-*.ts`, `pnl-*.ts` - ledger writes/reads and PnL derived from fills and marks
- `cdk/lambda/endpoints/controller-reads.ts` + `controller-read-paths.ts` - one Lambda for the controller's GET reads
- `cdk/lambda/db-init/migrations/NNN_*.sql` - schema migrations, applied in filename order
- `cdk/lambda/alerts/` - ingest, router, store, sinks (Slack, incident.io), `alert-types.ts` (type catalog + severity)
- `cdk/lambda/monitoring/rules/` - findings shared by the controller overview and the alert tick
- `cdk/lambda/sync/` - scheduled jobs: exchange sync (`exchanges/` adapters), venue poller (`venues/`), mark poller,
  settlement sweeper, strategy-session monitor
- `cdk/lambda/fees/`, `cdk/lambda/simulation/` - fee calculator/timeline and simulation-parameter resolution
- `cdk/test/` - jest tests; `*.db.test.ts` need Postgres; `fixtures/` holds venue payloads and test cases
- `src/main/java/group/gnometrading/` - Java client: `RegistryConnection`, `SecurityMaster`, `risk/`, `account/`,
  `sm/` (incl. `sm/fee/`), `md/`
- `src/test/resources/fee-vectors.json` - fee cases shared by `fee-calculator.test.ts` and `FeeVectorsTest.java`
- `docs/runbooks/` - alert runbooks (read by the router build and by on-call)

## Conventions and invariants

- Scaling: prices and money are integers in price units, 1e9 per dollar (`PRICE_SCALE`); sizes/quantities are 1e6
  per unit (`SIZE_SCALE`) - see `cdk/lambda/endpoints/ledger-math.ts`. Use `bigint`; integer division truncates
  toward zero. Never introduce floats into ledger or PnL math.
- `ledger-math.ts` mirrors the OMS (gnome-oms `ScaledMath`, `SharedPriceBuffer.markPrice`, `CommittedCapital`) so
  registry PnL matches risk limits exactly. Change both sides together.
- Fee logic exists in TypeScript and Java; both must pass `src/test/resources/fee-vectors.json`. Fee schedules are
  append-only (no DELETE/PATCH): a fix is a new row.
- PnL is never stored; it is derived from the ledger's fills and marks on every read.
- Auth: every route goes through the shared `GnomeApiAuthorizer` (gnome-shared-cdk). Each route in `api-stack.ts`
  names the caller kinds it admits: `SERVICE` (API key), `PERSON` (Cognito ID token), `BOT` (gnome-api-scoped access
  token). Bots only ever get GET (enforced by `api-stack.test.ts`). Writes that must be attributed to a person
  (risk policy writes, ledger adjustments, venue-account create/status, treasury transfers) are `PERSON` only.
  `risk/halts` is `SERVICE` only and can only enable a kill.
- One route tree (no `/cognito` copy); CORS preflights carry no authorizer. Keep the authorizer set per method.
- The API stack must stay under 450 CloudFormation resources (test-enforced; the hard limit is 500). Integrations
  use `scopePermissionToMethod: false` for this reason. Don't merge unrelated routes into one Lambda just to save
  resources; give a new resource its own Lambda.
- SQL: never interpolate a value into query text. `ResourceHandler`'s `generate*Query` methods return `Sql`
  (pg's `{ text, values }`), built with the helpers in `cdk/lambda/endpoints/sql.ts`: the ``sql`...` `` tag turns
  values into `$n` placeholders and composes fragments; `where()`, `set()` and `anyId()` cover optional filters,
  partial updates and id lists, and `raw()` is only for identifiers or keywords from code. Other code (ledger,
  treasury) passes `client.query(text, values)` directly. Postgres input errors (22P02, 22003, 22007, 22008) become
  400s in `ResourceHandler`. ILIKE searches bind the whole pattern; `%`, `_` and `\` in a search are still wildcards.
- Migrations: add a new `NNN_name.sql` with the next number; never edit an applied one. Each file runs in one
  transaction (5-minute Lambda timeout). They are not applied on deploy: the `DatabaseInitLambda` must be invoked by
  hand after a release, dev first, then prod. If a migration drops something old clients still read, sequence it
  after those clients are released.
- No backward-compat shims: nothing is in production trading yet, so change the schema and migrate every caller.
- Alert types: adding one to `ALERT_TYPES` requires `docs/runbooks/alerts/<TYPE>.md` (all template sections) and a
  regenerated `runbooks.generated.json`; `runbooks.test.ts` fails otherwise.
- CloudWatch alarm names end in `-Critical`, `-Error` or `-Warning`; the router takes severity from that suffix
  (unknown suffix = WARNING) and the runbook from the text before the first `-`
  (`docs/runbooks/cloudwatch/<Service>.md`).
- `tsc` leaves gitignored `.js`/`.d.ts` next to sources; jest resolves `.ts` first. Edit the `.ts`, never the `.js`.

## Operations

- Deploys: push to `main` runs the Maven release (bump + publish jar + tag); the tag push force-updates the `release`
  branch, which `RegistryPipeline` (in the InfraPipelines account) builds: synth, `Dev` stage, manual `ApproveProd`,
  `Prod` stage. Dev and prod are separate AWS accounts. Stacks per stage: `Dev-`/`Prod-` + `DatabaseStack`,
  `ApiStack`, `ExchangeSyncStack`, `StrategySessionMonitorStack`, `SettlementSweeperStack`, `VenuePollerStack`,
  `MarkPollerStack`, `MonitoringStack`, `AlertingStack`. After a release with new migrations, invoke the
  `DatabaseInitLambda` in each account.
- What runs:
  - ApiStack: the Registry API (stage `api`), one Lambda per resource in the VPC; the strategy-session launcher
    (launch/stop/logs, outside the VPC, starts EC2 orchestrators) and the venue-account creator (Secrets Manager,
    outside the VPC) call back through the API. The creator also sets market-data keys: the sessions' per-exchange
    key (`/market-data-keys`, `gnome/market-data/<exchange>`) and collection's accounts (`/market-data-accounts`,
    `gnome/market-data/<source>/<label>`, recorded in `md.source_account` through `/sources/accounts`).
  - DatabaseStack: RDS Postgres 16 (`gnome` db) in isolated subnets, plus the migration Lambda and a query Lambda
    (`{"query": "..."}`, returns rows) for read-only inspection.
  - ExchangeSyncStack: hourly security-master sync (Hyperliquid, Lighter adapters); in prod it reports to `#gnome-security-master`.
  - VenuePollerStack: every 5 min, reads each venue account's balances/positions and posts treasury snapshots for
    reconciliation.
  - MarkPollerStack: every minute, marks listings still held after their sessions stopped.
  - SettlementSweeperStack: every 5 min, books SETTLEMENT entries for settled positions no session holds.
  - StrategySessionMonitorStack: updates session status from EC2 instance state-change events.
  - AlertingStack: event bus `gnome-alerts`; ingest API (`POST /alerts`, registry API key, URL in SSM
    `/gnome/alerting/api-url`); router (1-minute tick runs the monitoring rules via the store, also takes bus events,
    CloudWatch alarm changes and AWS Budgets/Cost Anomaly SNS); store (records alert state in Postgres); DLQ.
    The router posts every alert to Slack (`#gnome-alerts-prod` / `#gnome-alerts-dev`); in prod, CRITICAL alerts not
    labelled `route: slack-only` also go to incident.io. Paper sessions and dev are capped at ERROR. After posting a
    firing alert to Slack it emits `AlertDelivered` (source `gnome.alerts.delivered`) on the bus for gnome-bot.
- Logs: Lambda default log groups, `/aws/lambda/<function>`. Function names are CloudFormation-generated, e.g.
  `Prod-ApiStack-<logicalId>-<suffix>`; find them by stack prefix and handler name (e.g. `strategysessions`,
  `alertrouter`). Orchestrator logs, which this API's own `strategy-sessions/logs` route reads, are under `/gnome/orchestrator/*`.
- Alarms and alerts it raises:
  - `Registry-*` (MonitoringStack): API 5xx (Error), Lambda faults for ExchangeSync, SettlementSweeper, VenuePoller,
    MarkPoller, StrategySessionMonitor (Error), RDS free storage < 5 GiB and CPU > 80% (Warning). No actions; they
    reach the router as `CLOUDWATCH_ALARM`. Runbook: `docs/runbooks/cloudwatch/Registry.md`.
  - `AlertingMeta-<RouterErrors|StoreErrors|IngestErrors|Dlq|TickNotRunning|Undelivered>-Critical`: alerting's own
    health; bypass the router (SNS to incident.io in prod, and email). Runbook: `docs/runbooks/cloudwatch/AlertingMeta.md`.
  - Alert types from the monitoring rules and reported events are cataloged in `cdk/lambda/alerts/alert-types.ts`,
    each with a runbook.
- Runbooks: start at `docs/runbooks/README.md` (severity, routing, on-call). Per alert type:
  `docs/runbooks/alerts/<TYPE>.md`; per CloudWatch alarm service: `docs/runbooks/cloudwatch/<Service>.md` (Service =
  alarm name before the first `-`). Procedures: `docs/runbooks/procedures/` (`registry-down.md`, `stop-or-kill.md`,
  `inspect-session.md`, `check-venue-orders.md`, `accounts.md`). Runbook URLs in alerts point at `main` on GitHub.
