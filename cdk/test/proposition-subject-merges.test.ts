import { APIGatewayProxyEvent } from 'aws-lambda';
import { requestActor } from '../lambda/endpoints/propositions-common';

function event(kind: string, actor: string): APIGatewayProxyEvent {
  return { requestContext: { authorizer: { kind, actor } } } as unknown as APIGatewayProxyEvent;
}

describe('who a change to subjects is attributed to', () => {
  it('takes a person from their token, never the body', () => {
    expect(requestActor(event('person', 'me@example.com'), 'someone-else', 'merging subjects')).toBe('me@example.com');
  });

  it('takes a service from the actor it names, and refuses one that names none', () => {
    expect(requestActor(event('service', 'api-key'), ' classifier:subject-merger ', 'merging subjects')).toBe('classifier:subject-merger');
    expect(() => requestActor(event('service', 'api-key'), '', 'merging subjects')).toThrow('must name itself');
  });
});
