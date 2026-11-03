import { APIGatewayProxyEvent } from 'aws-lambda';
import { mergeActor } from '../lambda/endpoints/proposition-subject-merges';

function event(kind: string, actor: string): APIGatewayProxyEvent {
  return { requestContext: { authorizer: { kind, actor } } } as unknown as APIGatewayProxyEvent;
}

describe('who a merge is attributed to', () => {
  it('takes a person from their token, never the body', () => {
    expect(mergeActor(event('person', 'me@example.com'), 'someone-else')).toBe('me@example.com');
  });

  it('takes a service from the actor it names, and refuses one that names none', () => {
    expect(mergeActor(event('service', 'api-key'), ' classifier:subject-merger ')).toBe('classifier:subject-merger');
    expect(() => mergeActor(event('service', 'api-key'), '')).toThrow('must name itself');
  });
});
