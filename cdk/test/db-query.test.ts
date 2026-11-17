import { handler } from '../lambda/db-query';
import { connectDatabase } from '../lambda/connections';

jest.mock('../lambda/connections', () => ({ connectDatabase: jest.fn() }));

describe('the ad-hoc query Lambda', () => {
  const release = jest.fn();
  const query = jest.fn();

  beforeEach(() => {
    release.mockReset();
    query.mockReset();
    (connectDatabase as jest.Mock).mockResolvedValue({ connect: async () => ({ query, release }) });
  });

  it('answers the rows and gives its connection back to the pool', async () => {
    query.mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 });
    expect(await handler({ query: 'SELECT 1 AS ok' })).toEqual({
      statusCode: 200, body: JSON.stringify({ rows: [{ ok: 1 }], rowCount: 1 }),
    });
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('closes the connection of a query that fails, so bad queries never use up the pool', async () => {
    const error = new Error('column cp.reader does not exist');
    query.mockRejectedValue(error);
    for (let i = 0; i < 11; i++) await expect(handler({ query: 'SELECT cp.reader' })).rejects.toBe(error);
    expect(release).toHaveBeenCalledTimes(11);
    for (const call of release.mock.calls) expect(call).toEqual([error]);
  });
});
