import { generateKeyPairSync } from 'crypto';
import {
  CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, PutSecretValueCommand, ResourceExistsException,
  SecretsManagerClient, TagResourceCommand,
} from '@aws-sdk/client-secrets-manager';
import * as registryClient from '../lambda/sync/registry-client';
import { accountSecretName, CreateError, setMarketDataAccount } from '../lambda/endpoints/venue-account-create';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const kalshi = { apiKey: 'key-1', privateKey: pem };

describe('market-data accounts', () => {
  let sent: unknown[];
  let secretExists: boolean;
  let registryPost: jest.SpyInstance;

  beforeEach(() => {
    sent = [];
    secretExists = false;
    jest.spyOn(registryClient, 'resolveApiKey').mockResolvedValue('api-key');
    registryPost = jest.spyOn(registryClient, 'registryFetch').mockResolvedValue({ account_id: 7, label: 'md-1' });
    jest.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async (command: unknown) => {
      sent.push(command);
      if (command instanceof CreateSecretCommand && secretExists) {
        throw new ResourceExistsException({ message: 'exists', $metadata: {} });
      }
      if (command instanceof DescribeSecretCommand) return { $metadata: {}, ReplicationStatus: [] };
      return { $metadata: {} };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const kinds = () => sent.map(c => (c as object).constructor.name);

  it('keeps each account under the session key\'s name plus its label', () => {
    expect(accountSecretName('KALSHI', 'md-1')).toBe('gnome/market-data/kalshi/md-1');
    expect(accountSecretName('POLYMARKET_US', 'md-2')).toBe('gnome/market-data/polymarket-us/md-2');
  });

  it('refuses a source whose feed needs no key, and a label that can\'t name a secret, before touching anything', async () => {
    await expect(setMarketDataAccount({ sourceCode: 'POLYMARKET_INTL', label: 'md-1', credentials: {} }, 'ops'))
      .rejects.toThrow(/other feeds need no key/);
    await expect(setMarketDataAccount({ sourceCode: 'KALSHI', label: 'MD 1', credentials: kalshi }, 'ops'))
      .rejects.toThrow(CreateError);
    expect(sent).toEqual([]);
    expect(registryPost).not.toHaveBeenCalled();
  });

  it('writes the key in every region, then records the account by its secret\'s name', async () => {
    const account = await setMarketDataAccount(
      { sourceCode: 'KALSHI', label: 'md-1', credentials: kalshi, connectionBudget: 150 }, 'ops@example.com');

    expect(kinds()).toEqual(['CreateSecretCommand', 'TagResourceCommand', 'DescribeSecretCommand']);
    const create = sent[0] as CreateSecretCommand;
    expect(create.input.Name).toBe('gnome/market-data/kalshi/md-1');
    expect(create.input.AddReplicaRegions).toEqual([{ Region: 'ap-northeast-1' }, { Region: 'eu-west-1' }]);
    expect(registryPost).toHaveBeenCalledWith('/sources/accounts', 'POST', 'api-key', expect.objectContaining({
      sourceCode: 'KALSHI', label: 'md-1', secretName: 'gnome/market-data/kalshi/md-1', connectionBudget: 150,
      actor: 'ops@example.com',
    }));
    expect(JSON.stringify(registryPost.mock.calls[0][3])).not.toContain('key-1');
    expect(account).toMatchObject({ account_id: 7, key: { secretName: 'gnome/market-data/kalshi/md-1' } });
  });

  it('deletes a new account\'s key when the registry won\'t record the account', async () => {
    registryPost.mockRejectedValue(new Error('POST /sources/accounts failed: 400 {"message":"Unknown source KALSHI"}'));

    await expect(setMarketDataAccount({ sourceCode: 'KALSHI', label: 'md-1', credentials: kalshi }, 'ops'))
      .rejects.toMatchObject({ statusCode: 400, message: 'Unknown source KALSHI' });
    const deleted = sent.find(c => c instanceof DeleteSecretCommand) as DeleteSecretCommand;
    expect(deleted.input).toEqual({ SecretId: 'gnome/market-data/kalshi/md-1', ForceDeleteWithoutRecovery: true });
  });

  it('replaces an existing account\'s key in place, and never deletes it when recording fails', async () => {
    secretExists = true;
    registryPost.mockRejectedValue(new Error('POST /sources/accounts failed: 500 boom'));

    await expect(setMarketDataAccount({ sourceCode: 'KALSHI', label: 'md-1', credentials: kalshi }, 'ops'))
      .rejects.toThrow();
    expect(sent.some(c => c instanceof PutSecretValueCommand)).toBe(true);
    expect(sent.some(c => c instanceof DeleteSecretCommand)).toBe(false);
    expect(sent.some(c => c instanceof TagResourceCommand)).toBe(true);
  });
});
