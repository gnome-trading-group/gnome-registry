import { generateKillReleaseQuery, resolveTransitions } from '../lambda/sync/strategy-session-monitor';

describe('EC2 state to session status', () => {
  it('moves a submitted session to STARTING when its instance boots', () => {
    expect(resolveTransitions('running')).toEqual([{ status: 'STARTING', from: ['SUBMITTED'] }]);
  });

  it.each(['shutting-down', 'terminated'])('fails any running session when its instance goes %s', (state) => {
    expect(resolveTransitions(state)).toContainEqual({ status: 'FAILED', from: ['SUBMITTED', 'STARTING', 'RUNNING'] });
  });

  it.each(['shutting-down', 'terminated'])('finishes a stop in progress as STOPPED when its instance goes %s', (state) => {
    expect(resolveTransitions(state)).toContainEqual({ status: 'STOPPED', from: ['STOPPING'] });
  });

  it('never fails a session that is stopping', () => {
    const failing = resolveTransitions('terminated').find((t) => t.status === 'FAILED')!;
    expect(failing.from).not.toContain('STOPPING');
  });

  it.each(['pending', 'stopping', 'stopped'])('ignores %s', (state) => {
    expect(resolveTransitions(state)).toEqual([]);
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
