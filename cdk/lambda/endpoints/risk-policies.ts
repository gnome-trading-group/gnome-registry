import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';
import { NOW, set, Sql, sql, where } from './sql';

// A policy applies to exactly the ids it carries: none is global, a strategy covers every session of it, a listing
// covers every strategy on it, an exchange covers every listing on it, and a session narrows a strategy to one
// running instance. A listing already implies its exchange, so a row names one or the other.
interface ICreateRiskPolicy {
  policyType: string;
  sessionId?: string;
  strategyId?: number;
  exchangeId?: number;
  listingId?: number;
  parameters: Record<string, unknown>;
  enabled?: boolean;
  reason?: string;
}

interface IUpdateRiskPolicy {
  parameters?: Record<string, unknown>;
  enabled?: boolean;
  reason?: string;
}

// The OMS turns a row it can't build into a kill of that row's target, so a bad row must never be stored. Every
// limit is a scaled integer: money in price units, sizes in size units, counts as is.
const POLICY_PARAMETERS: Record<string, string[]> = {
  KILL_SWITCH: [],
  MAX_ORDER_NOTIONAL: ['maxOrderNotional'],
  MAX_COMMITTED_CAPITAL: ['maxCapital'],
  MAX_CONSECUTIVE_REJECTS: ['maxRejects'],
  MAX_ORDER_SIZE: ['maxOrderSize'],
  MAX_POSITION: ['maxPosition'],
  MAX_OPEN_ORDERS: ['maxOpenOrders'],
  PRICE_COLLAR: ['maxDeviation'],
  MAX_TOTAL_PNL_LOSS: ['maxLoss'],
  MARKET_ORDER_SLIPPAGE: ['maxSlippage'],
};
// 0 slippage is a real setting: take at the touch, tighter than any looser row that also applies.
const ZERO_ALLOWED = new Set(['maxSlippage']);

const MAX_ID = 2147483647;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// Postgres rejects a row whose session doesn't exist or runs another strategy (foreign key), whose ids aren't
// positive (check), or that duplicates another policy's type and target (unique).
const CONSTRAINT_VIOLATIONS = new Set(['23503', '23514', '23505']);

export function validateParameters(policyType: string, parameters: unknown): void {
  const keys = POLICY_PARAMETERS[policyType];
  if (!keys) {
    throw new ValidationError(`Unknown policyType ${policyType}`);
  }
  if (parameters == null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new ValidationError('parameters must be an object');
  }
  const given = Object.keys(parameters).sort();
  if (given.join(',') !== [...keys].sort().join(',')) {
    throw new ValidationError(`${policyType} takes exactly ${keys.length ? keys.join(', ') : 'no parameters'}`);
  }
  for (const key of keys) {
    const value = (parameters as Record<string, unknown>)[key];
    const floor = ZERO_ALLOWED.has(key) ? 0 : 1;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < floor) {
      throw new ValidationError(`${key} must be a ${floor === 0 ? 'non-negative' : 'positive'} integer`);
    }
  }
}

function optionalId(name: string, value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_ID) {
    throw new ValidationError(`${name} must be a positive integer`);
  }
  return value;
}

function idList(name: string, value: string): number[] {
  const ids = value.split(',').map(id => optionalId(name, Number(id)));
  if (ids.length === 0 || ids.some(id => id === null)) throw new ValidationError(`${name} must list positive integers`);
  return ids as number[];
}

function optionalSessionId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new ValidationError('sessionId must be a session id');
  }
  return value;
}

export class RiskPolicyHandler extends ResourceHandler {
  auditWrites(): boolean {
    return true;
  }

  async createOne(body: string | null) {
    return this.rejectingConstraintViolations(() => super.createOne(body));
  }

  async createMany(body: string | null) {
    return this.rejectingConstraintViolations(() => super.createMany(body));
  }

  private async rejectingConstraintViolations<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code && CONSTRAINT_VIOLATIONS.has(code)) {
        throw new ValidationError((error as Error).message);
      }
      throw error;
    }
  }

  // The OMS reads policies into a fixed-size array, so the stable order keeps refreshes deterministic.
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    return sql`SELECT * FROM risk.policy${where([
      params?.policyId && sql`policy_id = ${optionalId('policyId', Number(params.policyId))}`,
      params?.strategyId && sql`strategy_id = ${optionalId('strategyId', Number(params.strategyId))}`,
      params?.listingId && sql`listing_id = ${optionalId('listingId', Number(params.listingId))}`,
      params?.exchangeId && sql`exchange_id = ${optionalId('exchangeId', Number(params.exchangeId))}`,
      // What one running OMS needs: rows for every strategy or its own, and for no session or its own. Without
      // these an OMS would load every session's and strategy's rows and hit its policy cap fleet-wide.
      params?.forStrategy
        && sql`(strategy_id IS NULL OR strategy_id = ${optionalId('forStrategy', Number(params.forStrategy))})`,
      params?.forSession === 'none'
        ? sql`session_id IS NULL`
        : params?.forSession && sql`(session_id IS NULL OR session_id = ${optionalSessionId(params.forSession)})`,
      // Rows naming no strategy reach every session, so a session also narrows them to the listings and exchanges it
      // trades; otherwise the firm's listing and exchange rows together would overflow every OMS's policy cap.
      params?.forListings
        && sql`(listing_id IS NULL OR listing_id = ANY(${idList('forListings', params.forListings)}::int[]))`,
      params?.forExchanges
        && sql`(exchange_id IS NULL OR exchange_id = ANY(${idList('forExchanges', params.forExchanges)}::int[]))`,
      (params?.enabled === 'true' || params?.enabled === 'false') && sql`enabled = ${params.enabled === 'true'}`,
    ])} ORDER BY policy_id`;
  }

  generateInsertQuery(body: string): Sql {
    const p = JSON.parse(body) as ICreateRiskPolicy;
    validateParameters(p.policyType, p.parameters);
    const sessionId = optionalSessionId(p.sessionId);
    const strategyId = optionalId('strategyId', p.strategyId);
    const exchangeId = optionalId('exchangeId', p.exchangeId);
    const listingId = optionalId('listingId', p.listingId);
    if (exchangeId !== null && listingId !== null) {
      throw new ValidationError('a policy names an exchange or a listing, not both');
    }
    // A session row carries its session's strategy; one naming another strategy fails the foreign key.
    const strategy = sessionId == null || strategyId != null
      ? strategyId
      : sql`(SELECT strategy_id FROM strategy.session WHERE session_id = ${sessionId})`;
    return sql`
      INSERT INTO risk.policy (policy_type, session_id, strategy_id, exchange_id, listing_id, parameters, enabled)
      VALUES (${p.policyType}, ${sessionId}, ${strategy}, ${exchangeId}, ${listingId}, ${JSON.stringify(p.parameters)},
        ${p.enabled !== false})
      RETURNING *`;
  }

  generateDeleteQuery(body: string): Sql {
    const p = JSON.parse(body) as { policyId: number; reason?: string };
    return sql`DELETE FROM risk.policy WHERE policy_id = ${optionalId('policyId', p.policyId)} RETURNING *`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const p = JSON.parse(body) as IUpdateRiskPolicy;
    if (p.parameters != null) validateParameters(row['policy_type'], p.parameters);
    return sql`UPDATE risk.policy SET ${set({
      parameters: p.parameters != null ? JSON.stringify(p.parameters) : undefined,
      enabled: p.enabled != null ? p.enabled === true : undefined,
      date_modified: NOW,
    })} WHERE policy_id = ${row['policy_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new RiskPolicyHandler().handleEvent(event);
};
