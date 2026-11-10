// The queue gateways/ensure wakes gnome-orchestrator's gateway reconciler on (its OrderGatewayReconcilerStack, in this
// account's us-east-1), by name, and its one message group.
export const RECONCILER_QUEUE = 'gateway-reconciler.fifo';
export const RECONCILER_GROUP = 'reconcile';
