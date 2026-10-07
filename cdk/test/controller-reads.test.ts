import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/endpoints/controller-reads';

describe('controller reads', () => {
  it('answers a route it does not serve with 404 rather than another read', async () => {
    const response = await handler({ resource: '/cognito/pnl/latest' } as APIGatewayProxyEvent) as { statusCode: number };
    expect(response.statusCode).toBe(404);
  });
});
