import {
  PYTHON_MEDIUM_MAX_RECORDS_PER_SECOND,
  PYTHON_T3_MAX_RECORDS_PER_SECOND,
  RECORDS_PER_SECOND_PER_STREAM,
  SLOW_T3_MAX_RECORDS_PER_SECOND,
  STANDARD_MEDIUM_MAX_RECORDS_PER_SECOND,
  STANDARD_MEDIUM_MAX_STREAMS,
  defaultInstanceType,
  isTier,
  predictLoad,
  profileForTier,
  tierForProfile,
} from '../lambda/endpoints/session-sizing';

// The streams a session can read at most and stay under a records/s limit.
const streamsWithin = (recordsPerSecond: number) => Math.floor(recordsPerSecond / RECORDS_PER_SECOND_PER_STREAM);

describe('session sizing', () => {
  it('maps tiers onto the two profiles and back', () => {
    expect(profileForTier('slow')).toBe('standard');
    expect(profileForTier('standard')).toBe('standard');
    expect(profileForTier('low_latency')).toBe('low_latency');
    expect(tierForProfile('standard')).toBe('standard');
    expect(tierForProfile('low_latency')).toBe('low_latency');
    expect(isTier('slow')).toBe(true);
    expect(isTier('fast')).toBe(false);
  });

  it('predicts every stream at one busy listing\'s rate', () => {
    expect(predictLoad(3)).toEqual({ recordsPerSecond: 3 * RECORDS_PER_SECOND_PER_STREAM, streams: 3 });
  });

  it('sizes a small slow session on t3.small, and a bigger one on c7a.medium', () => {
    const small = streamsWithin(SLOW_T3_MAX_RECORDS_PER_SECOND);
    expect(defaultInstanceType('slow', predictLoad(small), false)).toBe('t3.small');
    expect(defaultInstanceType('slow', predictLoad(small + 1), false)).toBe('c7a.medium');
  });

  it('never sizes a standard session on a burstable host', () => {
    expect(defaultInstanceType('standard', predictLoad(1), false)).toBe('c7a.medium');
  });

  it('moves a standard session to c7a.large past c7a.medium\'s streams or records', () => {
    const most = Math.min(STANDARD_MEDIUM_MAX_STREAMS, streamsWithin(STANDARD_MEDIUM_MAX_RECORDS_PER_SECOND));
    expect(defaultInstanceType('standard', predictLoad(most), false)).toBe('c7a.medium');
    expect(defaultInstanceType('standard', predictLoad(most + 1), false)).toBe('c7a.large');
    expect(defaultInstanceType('slow', predictLoad(most + 1), false)).toBe('c7a.large');
  });

  it('sizes a Python session by its strategy thread\'s budget', () => {
    const t3 = streamsWithin(PYTHON_T3_MAX_RECORDS_PER_SECOND);
    const medium = streamsWithin(PYTHON_MEDIUM_MAX_RECORDS_PER_SECOND);
    expect(defaultInstanceType('slow', predictLoad(t3), true)).toBe('t3.small');
    expect(defaultInstanceType('slow', predictLoad(t3 + 1), true)).toBe('c7a.medium');
    expect(defaultInstanceType('standard', predictLoad(1), true)).toBe('c7a.medium');
    expect(defaultInstanceType('standard', predictLoad(medium), true)).toBe('c7a.medium');
    expect(defaultInstanceType('standard', predictLoad(medium + 1), true)).toBe('c7a.large');
  });

  it('sizes every low-latency session on c7i.2xlarge', () => {
    expect(defaultInstanceType('low_latency', predictLoad(400), false)).toBe('c7i.2xlarge');
    expect(defaultInstanceType('low_latency', predictLoad(1), true)).toBe('c7i.2xlarge');
  });
});
