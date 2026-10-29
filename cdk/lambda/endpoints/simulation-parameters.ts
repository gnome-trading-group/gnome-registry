import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, UNKNOWN_ACTOR, ValidationError } from './base';
import { isoTimestamp } from './fees';
import { validateParameters } from '../simulation/parameters';
import { NOW, Sql, sql, where } from './sql';

// Each exchange's simulation parameters (sm.simulation_parameters): how its simulated exchange behaves wherever a run
// doesn't override it. Rows are append-only and dated by when they were recorded, not by when they held at the venue:
// they are our best estimate of the venue, so a better estimate applies to every period it is used for. A run pins the
// time it read them (knownAsOf) and gets the same parameters when replayed.

const MAX_ID = 2147483647;

function exchangeId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > MAX_ID) throw new ValidationError('exchangeId must be a positive integer');
  return id;
}

interface ICreateSimulationParameters {
  exchangeId: number;
  definition: unknown;
  note?: string;
}

export class SimulationParametersHandler extends ResourceHandler {
  auditWrites(): boolean {
    return true;
  }

  // The parameters in force for each exchange at knownAsOf (default now); with history=true, every row, newest first.
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    const exchange = params?.exchangeId && sql`exchange_id = ${exchangeId(params.exchangeId)}`;
    if (params?.history === 'true') {
      return sql`SELECT * FROM sm.simulation_parameters${where([exchange])} ORDER BY recorded_at DESC, simulation_parameters_id DESC`;
    }
    const asOf = params?.knownAsOf ? sql`${isoTimestamp('knownAsOf', params.knownAsOf)}::timestamptz` : NOW;
    return sql`
      SELECT DISTINCT ON (exchange_id) * FROM sm.simulation_parameters${where([sql`recorded_at <= ${asOf}`, exchange])}
      ORDER BY exchange_id, recorded_at DESC, simulation_parameters_id DESC`;
  }

  generateInsertQuery(body: string): Sql {
    const s = JSON.parse(body) as ICreateSimulationParameters;
    const definition = validateParameters(s.definition);
    const actor = this.audit && this.audit.actor !== UNKNOWN_ACTOR ? this.audit.actor : null;
    const note = s.note == null || String(s.note).trim() === '' ? null : String(s.note).trim();
    return sql`
      INSERT INTO sm.simulation_parameters (exchange_id, definition, note, actor)
      VALUES (${exchangeId(s.exchangeId)}, ${JSON.stringify(definition)}::jsonb, ${note}, ${actor})
      RETURNING *`;
  }

  generateDeleteQuery(_body: string): Sql {
    throw new ValidationError('simulation parameters are append-only: record new parameters instead');
  }

  generateModifyQuery(_row: any, _body: string): Sql {
    throw new ValidationError('simulation parameters are append-only: record new parameters instead');
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new SimulationParametersHandler().handleEvent(event);
};
