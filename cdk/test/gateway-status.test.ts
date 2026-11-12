import { AttributeValue } from '@aws-sdk/client-dynamodb';
import { endpointId, GatewayRow, minutesId, readStatuses } from '../lambda/endpoints/gateway-status';

const NOW = Date.parse('2026-11-12T19:00:00Z');

function row(key: string, mode = 'live'): GatewayRow {
  return {
    gateway_key: key, mode, exchange_id: 5, exchange_code: 'KALSHI', region: 'us-east-1',
    profile: mode === 'paper' ? 'paper' : 'standard', orchestrator_version: null, wanted_at: '2026-11-12T18:59:00Z',
    accounts: mode === 'paper' ? 0 : 1,
  };
}

function endpoint(writtenMsAgo: number): Record<string, AttributeValue> {
  return {
    service_id: { S: 'x' }, state: { S: 'READY' }, instance: { S: 'task-1' }, private_ip: { S: '10.0.0.1' },
    port: { N: '40010' }, version: { S: '1.37.4' }, written_at_ns: { N: `${BigInt(NOW - writtenMsAgo) * 1_000_000n}` },
    linked_sessions: { N: '3' }, working_orders: { N: '12' },
  };
}

function minutes(document: unknown, expiresInSeconds: number): Record<string, AttributeValue> {
  return { minutes_json: { S: JSON.stringify(document) }, expires_at: { N: `${NOW / 1000 + expiresInSeconds}` } };
}

async function statuses(rows: GatewayRow[], items: Record<string, Record<string, AttributeValue>>) {
  const asked: string[][] = [];
  const result = await readStatuses({
    rows: async () => rows,
    items: async (ids) => {
      asked.push(ids);
      return new Map(ids.filter((id) => items[id]).map((id) => [id, items[id]]));
    },
    nowMs: () => NOW,
  });
  return { result, asked };
}

describe("the gateways' status", () => {
  it('joins each row with its endpoint and its minutes', async () => {
    const document = { accounts: [{ accountId: 7, minutes: [{ orders: 4 }] }] };
    const { result, asked } = await statuses([row('live:kalshi:main')], {
      [endpointId('live:kalshi:main')]: endpoint(5_000),
      [minutesId('live:kalshi:main')]: minutes(document, 300),
    });

    expect(asked).toEqual([['order-gateway#live:kalshi:main', 'order-gateway#live:kalshi:main#minutes']]);
    expect(result[0]).toMatchObject({
      gatewayKey: 'live:kalshi:main', mode: 'live', exchangeCode: 'KALSHI', accounts: 1,
      endpoint: {
        state: 'READY', version: '1.37.4', linkedSessions: 3, workingOrders: 12,
        writtenAt: new Date(NOW - 5_000).toISOString(),
      },
      minutes: document,
    });
  });

  it("calls a gateway whose endpoint wasn't written in the last minute not running", async () => {
    const { result } = await statuses([row('live:kalshi:main')], {
      [endpointId('live:kalshi:main')]: endpoint(61_000),
    });

    expect(result[0].endpoint).toBeNull();
  });

  it('drops minutes DynamoDB has yet to remove after they expired, and ones it cannot read', async () => {
    const { result } = await statuses([row('live:kalshi:main'), row('paper:kalshi:main', 'paper')], {
      [minutesId('live:kalshi:main')]: minutes({ accounts: [] }, -1),
      [minutesId('paper:kalshi:main')]: { minutes_json: { S: '{not json' }, expires_at: { N: `${NOW / 1000 + 60}` } },
    });

    expect(result.map((s) => s.minutes)).toEqual([null, null]);
    expect(result.map((s) => s.endpoint)).toEqual([null, null]);
  });

  it('asks DynamoDB nothing when there are no gateways', async () => {
    const { result, asked } = await statuses([], {});

    expect(result).toEqual([]);
    expect(asked).toEqual([]);
  });
});
