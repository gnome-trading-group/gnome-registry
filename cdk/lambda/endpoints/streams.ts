import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler } from './base';
import { anyId, raw, Sql, sql, where } from './sql';

// A listing's stream stores only its listing_id, so its subject id and active flag are read from the listing here, and
// its event from the listing's contract (both sides of a binary contract are listings of one security, so both resolve
// to the event). Every stream's region is resolved once too (its own override, else the venue's exchange region, else
// the vendor's home region) so no caller repeats these rules.
const STREAM_SELECT = `
  SELECT st.stream_id, st.source_id, src.code AS source_code, src.kind AS source_kind, st.subject_kind,
         st.listing_id, COALESCE(st.native_subject_id, l.exchange_security_id) AS native_subject_id,
         st.family, st.region, COALESCE(st.region, e.region, src.home_region) AS resolved_region,
         COALESCE(st.event_id, ec.event_id) AS event_id, st.starts_at, st.ends_at, COALESCE(st.active, l.active) AS active, st.date_created
  FROM md.stream st
  JOIN md.source src ON src.source_id = st.source_id
  LEFT JOIN sm.exchange e ON e.exchange_id = src.exchange_id
  LEFT JOIN sm.listing l ON l.listing_id = st.listing_id
  LEFT JOIN LATERAL (SELECT MIN(event_id) AS event_id FROM sm.event_contract WHERE security_id = l.security_id) ec ON true`;

/** Streams of these events: vendor streams by their own event, listing streams through their contract. */
function eventFilter(ids: number[]): Sql {
  if (ids.length === 0) return raw('FALSE');
  return sql`(st.event_id = ANY(${ids}::int[])
    OR l.security_id IN (SELECT security_id FROM sm.event_contract WHERE event_id = ANY(${ids}::int[])))`;
}

export class StreamHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['stream_id', 'source_id', 'listing_id', 'family', 'date_created'];
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    return sql`${raw(STREAM_SELECT)}${where([
      params?.streamId && sql`st.stream_id = ${Number(params.streamId)}`,
      params?.streamIds !== undefined && anyId('st.stream_id', parseIdList(params.streamIds)),
      params?.listingId && sql`st.listing_id = ${Number(params.listingId)}`,
      params?.listingIds !== undefined && anyId('st.listing_id', parseIdList(params.listingIds)),
      params?.sourceId && sql`st.source_id = ${Number(params.sourceId)}`,
      params?.family && sql`st.family = ${params.family}`,
      params?.eventId && eventFilter(parseIdList(params.eventId)),
      params?.eventIds !== undefined && eventFilter(parseIdList(params.eventIds)),
      params?.active !== undefined && sql`COALESCE(st.active, l.active) = ${params.active === 'true'}`,
    ])}`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StreamHandler().handleEvent(event);
};
