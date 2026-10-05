import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';

// A policy applies to exactly the ids it carries: none is global, a strategy covers every session of it, a listing
// covers every strategy on it, and a session narrows a strategy to one running instance.
interface ICreateRiskPolicy {
  policyType: string;
  sessionId?: string;
  strategyId?: number;
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
  MAX_NOTIONAL: ['maxNotionalValue'],
  MAX_ORDER_SIZE: ['maxOrderSize'],
  MAX_POSITION: ['maxPosition'],
  MAX_OPEN_ORDERS: ['maxOpenOrders'],
  PRICE_COLLAR: ['maxDeviation'],
  MAX_TOTAL_PNL_LOSS: ['maxLoss'],
};

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
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError(`${key} must be a positive integer`);
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

function optionalSessionId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new ValidationError('sessionId must be a session id');
  }
  return value;
}

class RiskPolicyHandler extends ResourceHandler {
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

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM risk.policy WHERE 1=1';
    if (params?.policyId) query += ` AND policy_id=${optionalId('policyId', Number(params.policyId))}`;
    if (params?.strategyId) query += ` AND strategy_id=${optionalId('strategyId', Number(params.strategyId))}`;
    if (params?.listingId) query += ` AND listing_id=${optionalId('listingId', Number(params.listingId))}`;
    // What one running OMS needs: rows for every strategy or its own, and for no session or its own. Without
    // these an OMS would load every session's and strategy's rows and hit its policy cap fleet-wide.
    if (params?.forStrategy) {
      query += ` AND (strategy_id IS NULL OR strategy_id=${optionalId('forStrategy', Number(params.forStrategy))})`;
    }
    if (params?.forSession === 'none') {
      query += ' AND session_id IS NULL';
    } else if (params?.forSession) {
      query += ` AND (session_id IS NULL OR session_id='${optionalSessionId(params.forSession)}')`;
    }
    if (params?.enabled === 'true' || params?.enabled === 'false') query += ` AND enabled=${params.enabled}`;
    // The OMS reads policies into a fixed-size array, so a stable order keeps refreshes deterministic.
    query += ' ORDER BY policy_id';
    return query;
  }

  generateInsertQuery(body: string): string {
    const p = JSON.parse(body) as ICreateRiskPolicy;
    validateParameters(p.policyType, p.parameters);
    const sessionId = optionalSessionId(p.sessionId);
    const strategyId = optionalId('strategyId', p.strategyId);
    const listingId = optionalId('listingId', p.listingId) ?? 'null';
    const enabled = p.enabled !== false;
    // A session row carries its session's strategy; one naming another strategy fails the foreign key.
    const strategy = sessionId == null
      ? (strategyId ?? 'null')
      : (strategyId ?? `(SELECT strategy_id FROM strategy.session WHERE session_id='${sessionId}')`);
    const session = sessionId == null ? 'null' : `'${sessionId}'`;
    return `
      INSERT INTO risk.policy (policy_type, session_id, strategy_id, listing_id, parameters, enabled)
      VALUES ('${p.policyType}', ${session}, ${strategy}, ${listingId}, '${JSON.stringify(p.parameters)}', ${enabled})
      RETURNING *;
    `;
  }

  generateDeleteQuery(body: string): string {
    const p = JSON.parse(body) as { policyId: number; reason?: string };
    return `
      DELETE FROM risk.policy
      WHERE policy_id = ${optionalId('policyId', p.policyId)}
      RETURNING *;
    `;
  }

  generateModifyQuery(row: any, body: string): string {
    const p = JSON.parse(body) as IUpdateRiskPolicy;
    const updates: string[] = [];
    if (p.parameters != null) {
      validateParameters(row['policy_type'], p.parameters);
      updates.push(`parameters='${JSON.stringify(p.parameters)}'`);
    }
    if (p.enabled != null) updates.push(`enabled=${p.enabled === true}`);
    updates.push(`date_modified=NOW()`);
    return `
      UPDATE risk.policy SET ${updates.join(', ')}
      WHERE policy_id=${row['policy_id']}
      RETURNING *;
    `;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new RiskPolicyHandler().handleEvent(event);
};
