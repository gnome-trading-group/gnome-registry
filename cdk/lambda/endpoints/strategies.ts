import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { NOW, set, Sql, sql, where } from './sql';

interface ICreateStrategy {
  name: string;
  description?: string;
  archived?: boolean;
  parameters?: Record<string, unknown>;
}

interface IUpdateStrategy {
  name?: string;
  description?: string;
  archived?: boolean;
  parameters?: Record<string, unknown>;
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
      INSERT INTO strategy.strategy (name, description, archived, parameters)
      VALUES (${s.name}, ${s.description ?? null}, ${s.archived === true}, ${parameters})
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
      date_modified: NOW,
    })} WHERE strategy_id = ${row['strategy_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StrategyHandler().handleEvent(event);
};
