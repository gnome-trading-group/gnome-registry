import { APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { join, Sql, sql } from './sql';

const textList = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);

/**
 * A condition on `p`, an sm.contract_proposition, from `propositionKinds` and `propositionScopes` (comma-separated;
 * each matches any of its values): what a contract asks, such as WINNER at scope match. Null when neither is given.
 * A contract not yet read has no proposition, and a field the extractor left unknown is null, so neither matches.
 */
export function propositionMatch(params: APIGatewayProxyEventQueryStringParameters | null): Sql | null {
  const kinds = textList(params?.propositionKinds);
  const scopes = textList(params?.propositionScopes);
  const clauses = [
    kinds.length > 0 && sql`p.fields->>'kind' = ANY(${kinds}::text[])`,
    scopes.length > 0 && sql`p.fields->>'scope' = ANY(${scopes}::text[])`,
  ].filter((clause): clause is Sql => clause instanceof Sql);
  return clauses.length > 0 ? join(clauses, ' AND ') : null;
}
