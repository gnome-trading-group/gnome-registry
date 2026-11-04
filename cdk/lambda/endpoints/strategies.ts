import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';
import { NOW, set, Sql, sql, where } from './sql';

interface ICreateStrategy {
  name: string;
  description?: string;
  archived?: boolean;
  parameters?: Record<string, unknown>;
  rateWeight?: number;
}

interface IUpdateStrategy {
  name?: string;
  description?: string;
  archived?: boolean;
  parameters?: Record<string, unknown>;
  rateWeight?: number;
}

function rateWeight(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new ValidationError('rateWeight must be a positive integer');
  return value as number;
}

export class StrategyHandler extends ResourceHandler {
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    // Lower-cased because Python clients send booleans as "True"/"False".
    const archived = params?.archived?.toLowerCase();
    return sql`SELECT * FROM strategy.strategy${where([
      params?.strategyId && sql`strategy_id = ${params.strategyId}`,
      params?.name && sql`name = ${params.name}`,
      (archived === 'true' || archived === 'false') && sql`archived = ${archived === 'true'}`,
    ])}`;
  }

  generateInsertQuery(body: string): Sql {
    const s = JSON.parse(body) as ICreateStrategy;
    const parameters = s.parameters != null ? JSON.stringify(s.parameters) : null;
    return sql`
      INSERT INTO strategy.strategy (name, description, archived, parameters, rate_weight)
      VALUES (${s.name}, ${s.description ?? null}, ${s.archived === true}, ${parameters}, ${rateWeight(s.rateWeight) ?? 1})
      RETURNING *`;
  }

  generateDeleteQuery(body: string): Sql {
    const s = JSON.parse(body) as { strategyId: number };
    return sql`DELETE FROM strategy.strategy WHERE strategy_id = ${s.strategyId} RETURNING *`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const s = JSON.parse(body) as IUpdateStrategy;
    return sql`UPDATE strategy.strategy SET ${set({
      name: s.name ?? undefined,
      description: s.description ?? undefined,
      archived: typeof s.archived === 'boolean' ? s.archived : undefined,
      parameters: s.parameters != null ? JSON.stringify(s.parameters) : undefined,
      rate_weight: rateWeight(s.rateWeight),
      date_modified: NOW,
    })} WHERE strategy_id = ${row['strategy_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StrategyHandler().handleEvent(event);
};
