import * as fs from 'fs';
import * as path from 'path';
import { buildRunbooks, GENERATED_PATH, readRunbooks, REQUIRED_SECTIONS, RUNBOOKS_DIR } from '../scripts/runbooks';
import { ALERT_TYPES } from '../lambda/alerts/alert-types';

// Every alert carries its runbook, so every type must have one that's complete, and the router must bundle the
// latest version of them.
const SERVICES = ['MarketData', 'Registry', 'Classifier', 'Controller', 'Launcher', 'Pipelines', 'AlertingMeta'];

describe('runbooks', () => {
  const alerts = readRunbooks('alerts');
  const cloudwatch = readRunbooks('cloudwatch');

  it('covers every alert type and alarm service', () => {
    expect(alerts.map(r => r.type).sort()).toEqual(Object.keys(ALERT_TYPES).sort());
    expect(cloudwatch.map(r => r.type).sort()).toEqual([...SERVICES].sort());
  });

  it('names each file after its type', () => {
    for (const r of [...alerts, ...cloudwatch]) expect(path.basename(r.file, '.md')).toBe(r.type);
  });

  it('has every section, each with something in it', () => {
    for (const r of [...alerts, ...cloudwatch]) {
      const sections = r.body.split(/^## /m).slice(1).map(s => [s.split('\n')[0].trim(), s.split('\n').slice(1).join('\n').trim()]);
      expect(sections.map(([heading]) => heading)).toEqual(REQUIRED_SECTIONS);
      for (const [heading, text] of sections) {
        if (!text) throw new Error(`${r.file}: "${heading}" is empty`);
      }
    }
  });

  it('links only to files that exist', () => {
    const files = [...alerts.map(r => r.file), ...cloudwatch.map(r => r.file),
      ...fs.readdirSync(path.join(RUNBOOKS_DIR, 'procedures')).map(f => `procedures/${f}`), 'README.md'];
    for (const file of files) {
      const text = fs.readFileSync(path.join(RUNBOOKS_DIR, file), 'utf8');
      for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
        if (/^https?:/.test(target)) continue;
        const resolved = path.join(RUNBOOKS_DIR, path.dirname(file), target.split('#')[0]);
        if (!fs.existsSync(resolved)) throw new Error(`${file} links to ${target}, which doesn't exist`);
      }
    }
  });

  it('the bundled copy is up to date (run `npm run runbooks`)', () => {
    expect(fs.readFileSync(GENERATED_PATH, 'utf8')).toBe(buildRunbooks());
  });
});
