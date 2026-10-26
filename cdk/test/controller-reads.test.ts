import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/endpoints/controller-reads';
import { createResponse, MAX_RESPONSE_BYTES } from '../lambda/endpoints/ledger-common';

describe('controller reads', () => {
  it('answers a route it does not serve with 404 rather than another read', async () => {
    const response = await handler({ resource: '/pnl/latest' } as APIGatewayProxyEvent) as { statusCode: number };
    expect(response.statusCode).toBe(404);
  });

  it('refuses a body over the response limit with 413 rather than letting Lambda drop it', () => {
    const response = createResponse(200, { rows: 'x'.repeat(MAX_RESPONSE_BYTES) });
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body).message).toMatch(/too large/);
    expect(createResponse(200, { rows: [] })).toMatchObject({ statusCode: 200, body: '{"rows":[]}' });
  });
});
