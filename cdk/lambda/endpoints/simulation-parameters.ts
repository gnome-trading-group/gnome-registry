import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, UNKNOWN_ACTOR, ValidationError } from './base';
import { isoTimestamp } from './fees';
import { validateParameters } from '../simulation/parameters';

// Each exchange's simulation parameters (sm.simulation_parameters): how its simulated exchange behaves wherever a run
// doesn't override it. Rows are append-only and dated by when they were recorded, not by when they held at the venue:
// they are our best estimate of the venue, so a better estimate applies to every period it is used for. A run pins the
// time it read them (knownAsOf) and gets the same parameters when replayed.

const MAX_ID = 2147483647;
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

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
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    const exchange = params?.exchangeId ? ` AND exchange_id=${exchangeId(params.exchangeId)}` : '';
    if (params?.history === 'true') {
      return `SELECT * FROM sm.simulation_parameters WHERE 1=1${exchange} ORDER BY recorded_at DESC, simulation_parameters_id DESC`;
    }
    const asOf = params?.knownAsOf ? `'${isoTimestamp('knownAsOf', params.knownAsOf)}'` : 'NOW()';
    return `
      SELECT DISTINCT ON (exchange_id) * FROM sm.simulation_parameters
      WHERE recorded_at <= ${asOf}${exchange}
      ORDER BY exchange_id, recorded_at DESC, simulation_parameters_id DESC`;
  }

  generateInsertQuery(body: string): string {
    const s = JSON.parse(body) as ICreateSimulationParameters;
    const definition = validateParameters(s.definition);
    const actor = this.audit && this.audit.actor !== UNKNOWN_ACTOR ? quote(this.audit.actor) : 'NULL';
    return `
      INSERT INTO sm.simulation_parameters (exchange_id, definition, note, actor)
      VALUES (${exchangeId(s.exchangeId)}, ${quote(JSON.stringify(definition))}::jsonb,
        ${s.note == null || String(s.note).trim() === '' ? 'NULL' : quote(String(s.note).trim())}, ${actor})
      RETURNING *;
    `;
  }

  generateDeleteQuery(_body: string): string {
    throw new ValidationError('simulation parameters are append-only: record new parameters instead');
  }

  generateModifyQuery(_row: any, _body: string): string {
    throw new ValidationError('simulation parameters are append-only: record new parameters instead');
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new SimulationParametersHandler().handleEvent(event);
};
