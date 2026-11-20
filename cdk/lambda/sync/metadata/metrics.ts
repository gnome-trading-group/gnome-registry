// A venue sync's counts as CloudWatch metrics through the embedded metric format: a log line, so a run reports how it
// went without a call of its own, and an alarm on a missing heartbeat catches a sync that stopped running.
export const METADATA_SYNC_NAMESPACE = 'Registry/MetadataSync';

export function emitSyncMetrics(kind: string, mode: string, venue: string, counts: Record<string, number>, at = new Date()) {
  const names = Object.keys(counts);
  console.log(JSON.stringify({
    _aws: {
      Timestamp: at.getTime(),
      CloudWatchMetrics: [{
        Namespace: METADATA_SYNC_NAMESPACE,
        Dimensions: [['Kind', 'Mode', 'Venue']],
        Metrics: names.map(Name => ({ Name, Unit: 'Count' })),
      }],
    },
    Kind: kind, Mode: mode, Venue: venue,
    ...counts,
  }));
}
