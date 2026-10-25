import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler } from './base';

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

// A listing's stream stores only its listing_id, so its subject id and active flag are read from the listing here, and
// every stream's region is resolved once (its own override, else the venue's exchange region, else the vendor's home
// region) so no caller repeats that rule.
const STREAM_SELECT = `
  SELECT st.stream_id, st.source_id, src.code AS source_code, src.kind AS source_kind, st.subject_kind,
         st.listing_id, COALESCE(st.native_subject_id, l.exchange_security_id) AS native_subject_id,
         st.family, st.region, COALESCE(st.region, e.region, src.home_region) AS resolved_region,
         st.event_id, st.starts_at, st.ends_at, COALESCE(st.active, l.active) AS active, st.date_created
  FROM md.stream st
  JOIN md.source src ON src.source_id = st.source_id
  LEFT JOIN sm.exchange e ON e.exchange_id = src.exchange_id
  LEFT JOIN sm.listing l ON l.listing_id = st.listing_id
  WHERE 1=1`;

export class StreamHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['stream_id', 'source_id', 'listing_id', 'family', 'date_created'];
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = STREAM_SELECT;
    if (params?.streamId) {
      query += ` AND st.stream_id=${Number(params.streamId)}`;
    }
    if (params?.streamIds !== undefined) {
      const ids = parseIdList(params.streamIds);
      query += ids.length > 0 ? ` AND st.stream_id IN (${ids.join(',')})` : ' AND FALSE';
    }
    if (params?.listingId) {
      query += ` AND st.listing_id=${Number(params.listingId)}`;
    }
    if (params?.listingIds !== undefined) {
      const ids = parseIdList(params.listingIds);
      query += ids.length > 0 ? ` AND st.listing_id IN (${ids.join(',')})` : ' AND FALSE';
    }
    if (params?.sourceId) {
      query += ` AND st.source_id=${Number(params.sourceId)}`;
    }
    if (params?.family) {
      query += ` AND st.family=${sqlText(params.family)}`;
    }
    if (params?.eventId) {
      query += ` AND st.event_id=${Number(params.eventId)}`;
    }
    if (params?.active !== undefined) {
      query += ` AND COALESCE(st.active, l.active)=${params.active === 'true'}`;
    }
    return query;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StreamHandler().handleEvent(event);
};
