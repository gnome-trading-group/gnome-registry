import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const GITHUB_API = 'https://api.github.com';
const GITHUB_OWNER = 'gnome-trading-group';
// The token sessions clone their commit with (start-session.sh), so the launcher reads what the session will run.
const GITHUB_TOKEN_SECRET = 'gnomepy/gh-token';
const GITHUB_TOKEN_REGION = 'us-east-1';
// Two calls of this each, inside API Gateway's 29s with the launch's other calls.
const GITHUB_TIMEOUT_MS = 5000;
// The session downloads these from GitHub Packages and PyPI, where only releases are published.
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

export const DEFAULT_REF = 'main';

/** The releases a strategy commit runs on, as the commit itself pins them. */
export interface Platform {
  orchestrator: string;
  // Python strategies only: a java session runs the orchestrator jar alone, JVM options included.
  gnomepy?: string;
}

export interface StrategySource {
  // The full SHA the ref named at launch, so the session row says exactly what ran even when a branch was given.
  commit: string;
  platform: Platform;
}

/** A launch whose commit or platform pin can't be used: the caller's to fix, not the launcher's. */
export class StrategySourceError extends Error {}

interface Source {
  repo: string;
  path: string;
  pins: (keyof Platform)[];
  parse(text: string): Partial<Platform>;
}

const SOURCES: Record<'java' | 'python', Source> = {
  java: { repo: 'gnome-strategies', path: 'strategies/pom.xml', pins: ['orchestrator'], parse: parsePomPlatform },
  python: {
    repo: 'gnomepy-research', path: 'platform.properties', pins: ['orchestrator', 'gnomepy'],
    parse: parsePlatformProperties,
  },
};

// strategies/ builds against the orchestrator it pins, so the pom is the one place both its build and its sessions
// read the platform from.
export function parsePomPlatform(pom: string): Partial<Platform> {
  const orchestrator = pom.match(/<platform\.orchestrator>\s*([^<\s]+)\s*<\/platform\.orchestrator>/)?.[1];
  return { orchestrator };
}

export function parsePlatformProperties(text: string): Partial<Platform> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return { orchestrator: values.orchestrator, gnomepy: values.gnomepy };
}

let cachedToken: string | undefined;

async function githubToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const secret = await new SecretsManagerClient({ region: GITHUB_TOKEN_REGION })
    .send(new GetSecretValueCommand({ SecretId: GITHUB_TOKEN_SECRET }));
  const raw = secret.SecretString ?? '';
  let token = raw;
  try {
    token = (JSON.parse(raw) as { token?: string }).token ?? raw;
  } catch {
    // Stored as the bare token.
  }
  if (!token) throw new Error(`${GITHUB_TOKEN_SECRET} is empty`);
  cachedToken = token;
  return cachedToken;
}

async function github(path: string, accept: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_OWNER}/${path}`, {
    headers: {
      Authorization: `Bearer ${await githubToken()}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gnome-registry-launcher',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
}

/** The commit a strategy session runs, and the platform that commit pins. */
export async function resolveStrategySource(strategyType: 'java' | 'python', ref: string): Promise<StrategySource> {
  const source = SOURCES[strategyType];
  const commitRes = await github(`${source.repo}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github.sha');
  if (commitRes.status === 404 || commitRes.status === 422) {
    throw new StrategySourceError(`${source.repo} has no commit ${ref}`);
  }
  if (commitRes.status !== 200) {
    throw new Error(`GitHub lookup of ${source.repo}@${ref} failed (${commitRes.status}): ${commitRes.text}`);
  }
  const commit = commitRes.text.trim();

  const fileRes = await github(`${source.repo}/contents/${source.path}?ref=${commit}`, 'application/vnd.github.raw');
  if (fileRes.status === 404) {
    throw new StrategySourceError(`${source.repo} ${commit.slice(0, 10)} has no ${source.path}, so it pins no platform`);
  }
  if (fileRes.status !== 200) {
    throw new Error(`GitHub read of ${source.repo}/${source.path}@${commit} failed (${fileRes.status}): ${fileRes.text}`);
  }
  const parsed = source.parse(fileRes.text);
  for (const key of source.pins) {
    const version = parsed[key];
    if (!version) {
      throw new StrategySourceError(`${source.repo} ${commit.slice(0, 10)}'s ${source.path} pins no ${key} version`);
    }
    if (!RELEASE_VERSION.test(version)) {
      throw new StrategySourceError(
        `${source.repo} ${commit.slice(0, 10)}'s ${source.path} pins ${key} ${version}, which is not a release`);
    }
  }
  return {
    commit,
    platform: Object.fromEntries(source.pins.map((key) => [key, parsed[key]])) as unknown as Platform,
  };
}
