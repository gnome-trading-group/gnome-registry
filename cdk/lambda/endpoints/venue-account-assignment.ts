import { PoolClient } from 'pg';
import { allocationOf, LaunchCheckError, requireAllocation, requireCoverage, shortfall } from './launch-checks';
import { accountTreasury } from './treasury';

// Which venue account a new live session trades each of its exchanges with, chosen inside the transaction that
// creates the session:
//   pinned  config.accounts.<EXCHANGE_CODE> names an ACTIVE account's label
//   sticky  else the ACTIVE account where the strategy already holds positions there, so its next session can
//           manage that inventory (the one holding the most, if several)
//   picked  else, with launch checks on, the ACTIVE account with the most free capital that can carry the
//           strategy's budget; with them off, the ACTIVE account activated most recently
// A DRAINING account is never chosen: what it holds is left to resolve where it is. With launch checks on, the
// session must also be covered by every required risk policy and its account must carry its budget.

export interface BindOptions {
  checks: boolean;
  now: Date;
}

// pg_advisory_xact_lock(ACCOUNT_LOCK, exchange_id): every choice of account on an exchange takes this, so two
// sessions created at once see each other's bindings, and a status change can't slip in between.
export const ACCOUNT_LOCK = 4_242_100;

export class AccountAssignmentError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

interface ExchangeRow {
  exchange_id: number;
  exchange_code: string;
}

export interface Binding {
  exchangeId: number;
  exchangeCode: string;
  accountId: number;
  label: string;
}

function pinnedLabels(config: Record<string, unknown>): Record<string, unknown> {
  const accounts = config.accounts;
  return accounts !== null && typeof accounts === 'object' && !Array.isArray(accounts)
    ? accounts as Record<string, unknown>
    : {};
}

async function pickByFreeCapital(
  client: PoolClient, strategyId: number, exchange: ExchangeRow, now: Date,
): Promise<{ account_id: number } | undefined> {
  const budget = await allocationOf(client, strategyId, exchange.exchange_id);
  if (budget === null) {
    throw new LaunchCheckError(422,
      `A live session needs a MAX_COMMITTED_CAPITAL for the strategy on ${exchange.exchange_code} (not only per listing)`);
  }
  const active = (await client.query(
    `SELECT account_id FROM account_master.venue_account WHERE exchange_id = $1 AND status = 'ACTIVE'`,
    [exchange.exchange_id])).rows.map(r => r.account_id as number);
  if (active.length === 0) return undefined;
  const accounts = (await accountTreasury(client, active, now)).sort((a, b) => (b.free > a.free ? 1 : b.free < a.free ? -1 : 0));
  const fits = accounts.find(a => shortfall(a, budget) === null);
  if (!fits) throw new LaunchCheckError(422, shortfall(accounts[0], budget) as string);
  return { account_id: fits.accountId };
}

async function chooseAccount(
  client: PoolClient, strategyId: number, exchange: ExchangeRow, pinned: unknown, options: BindOptions,
): Promise<{ account_id: number; label: string }> {
  if (pinned !== undefined) {
    if (typeof pinned !== 'string') {
      throw new AccountAssignmentError(400, `config.accounts.${exchange.exchange_code} must be an account label`);
    }
    const row = (await client.query(
      `SELECT account_id, label FROM account_master.venue_account
       WHERE exchange_id = $1 AND label = $2 AND status = 'ACTIVE' FOR SHARE`,
      [exchange.exchange_id, pinned])).rows[0];
    if (!row) {
      throw new AccountAssignmentError(422, `No ACTIVE ${exchange.exchange_code} account labelled ${String(pinned)}`);
    }
    return row;
  }
  const sticky = (await client.query(
    `SELECT a.account_id, a.label FROM account_master.venue_account a
     JOIN ledger.position p ON p.account_id = a.account_id
     WHERE a.exchange_id = $1 AND a.status = 'ACTIVE' AND p.strategy_id = $2 AND p.mode = 'live'
       AND p.net_quantity <> 0
     GROUP BY a.account_id, a.label
     ORDER BY SUM(p.total_cost) DESC, a.account_id
     LIMIT 1`,
    [exchange.exchange_id, strategyId])).rows[0];
  const chosen = sticky ?? (options.checks
    ? await pickByFreeCapital(client, strategyId, exchange, options.now)
    : (await client.query(
      `SELECT account_id, label FROM account_master.venue_account
       WHERE exchange_id = $1 AND status = 'ACTIVE'
       ORDER BY activated_at DESC NULLS LAST, account_id DESC
       LIMIT 1`,
      [exchange.exchange_id])).rows[0]);
  const locked = chosen && (await client.query(
    `SELECT account_id, label FROM account_master.venue_account WHERE account_id = $1 AND status = 'ACTIVE' FOR SHARE`,
    [chosen.account_id])).rows[0];
  if (!locked) throw new AccountAssignmentError(422, `No ACTIVE ${exchange.exchange_code} account to trade with`);
  return locked;
}

// A live order left OPEN on another account can only be seen and settled with that account's credentials, so the
// strategy may not move off it until that account's orders are cancelled.
async function refuseOrdersElsewhere(
  client: PoolClient, strategyId: number, exchange: ExchangeRow, accountId: number,
): Promise<void> {
  const elsewhere = (await client.query(
    `SELECT a.label, COUNT(*) AS orders FROM ledger.order o
     JOIN account_master.venue_account a ON a.account_id = o.account_id
     WHERE o.strategy_id = $1 AND o.mode = 'live' AND o.status = 'OPEN' AND o.exchange_id = $2
       AND o.account_id <> $3
     GROUP BY a.label LIMIT 1`,
    [strategyId, exchange.exchange_id, accountId])).rows[0];
  if (elsewhere) {
    throw new AccountAssignmentError(409,
      `The strategy has ${elsewhere.orders} open order(s) on ${exchange.exchange_code} account ${elsewhere.label};`
      + ' cancel them before it trades on another account');
  }
}

export async function bindAccounts(
  client: PoolClient, sessionId: string, strategyId: number, config: Record<string, unknown>, listings: number[],
  options: BindOptions,
): Promise<Binding[]> {
  if (options.checks) await requireCoverage(client, strategyId, listings);
  const exchanges = (await client.query<ExchangeRow>(
    `SELECT DISTINCT e.exchange_id, e.exchange_code FROM sm.listing l JOIN sm.exchange e USING (exchange_id)
     WHERE l.listing_id = ANY($1::int[]) ORDER BY e.exchange_id`,
    [listings])).rows;
  const pins = pinnedLabels(config);
  const bindings: Binding[] = [];
  for (const exchange of exchanges) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ACCOUNT_LOCK, exchange.exchange_id]);
    const account = await chooseAccount(client, strategyId, exchange, pins[exchange.exchange_code], options);
    await refuseOrdersElsewhere(client, strategyId, exchange, account.account_id);
    if (options.checks) {
      await requireAllocation(client, strategyId, exchange.exchange_id, exchange.exchange_code, account.account_id,
        options.now);
    }
    await client.query(
      `INSERT INTO account_master.session_venue_account (session_id, exchange_id, account_id) VALUES ($1, $2, $3)`,
      [sessionId, exchange.exchange_id, account.account_id]);
    bindings.push({
      exchangeId: exchange.exchange_id, exchangeCode: exchange.exchange_code, accountId: account.account_id,
      label: account.label,
    });
  }
  return bindings;
}
