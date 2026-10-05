import { resolveTransition } from '../lambda/sync/strategy-session-monitor';

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
