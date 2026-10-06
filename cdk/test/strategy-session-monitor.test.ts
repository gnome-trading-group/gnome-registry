import { generateKillReleaseQuery, resolveTransition } from '../lambda/sync/strategy-session-monitor';

describe('EC2 state to session status', () => {
  it('moves a submitted session to STARTING when its instance boots', () => {
    expect(resolveTransition('running')).toEqual({ status: 'STARTING', from: ['SUBMITTED'] });
  });

  it.each(['shutting-down', 'terminated'])('fails any active session when its instance goes %s', (state) => {
    expect(resolveTransition(state)).toEqual({ status: 'FAILED', from: ['SUBMITTED', 'STARTING', 'RUNNING'] });
  });

  it.each(['pending', 'stopping', 'stopped'])('ignores %s', (state) => {
    expect(resolveTransition(state)).toBeNull();
  });
});

describe('kill release on termination', () => {
  const query = generateKillReleaseQuery('i-123');

  it('disables only enabled kill switches', () => {
    expect(query).toContain("SET enabled=false");
    expect(query).toContain("policy_type='KILL_SWITCH' AND enabled");
  });

  it('only touches sessions on that instance that have already ended', () => {
    expect(query).toContain("instance_id='i-123'");
    expect(query).toContain("status IN ('STOPPED', 'FAILED')");
  });
});
