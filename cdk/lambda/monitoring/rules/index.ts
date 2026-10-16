import { PoolClient } from 'pg';
import { Finding } from './types';
import { halts } from './halts';
import { sessions } from './sessions';
import { failed } from './failed';
import { positions } from './positions';
import { settlement } from './settlement';
import { treasury } from './treasury';
import { fees } from './fees';
import { lifecycle } from './lifecycle';

export * from './types';

// Everything wrong with trading right now, in both modes. The controller's overview and the alert tick both read
// this, so they never disagree about what is wrong.
export async function runRules(client: PoolClient, now: Date): Promise<Finding[]> {
  return [
    ...await halts(client),
    ...await positions(client, now),
    ...await sessions(client, now),
    ...await lifecycle(client, now),
    ...await failed(client, now),
    ...await settlement(client, now),
    ...await treasury(client, now),
    ...await fees(client, now),
  ];
}
