import * as fs from 'fs';
import * as path from 'path';

// Runbooks live as markdown in docs/runbooks, read on GitHub (reachable when AWS isn't). Each opens with front matter
// naming what it's for, a one-line summary and the first few steps, which alerts carry with them:
//   ---
//   type: SESSION_SILENT
//   summary: One line.
//   first_steps:
//     - First thing to do.
//   ---
// `npm run runbooks` writes those into lambda/alerts/runbooks.generated.json for the router to bundle.

export const RUNBOOKS_DIR = path.join(__dirname, '..', '..', 'docs', 'runbooks');
export const GENERATED_PATH = path.join(__dirname, '..', 'lambda', 'alerts', 'runbooks.generated.json');
const URL_BASE = 'https://github.com/gnome-trading-group/gnome-registry/blob/main/docs/runbooks';
export const REQUIRED_SECTIONS = ['What it means', 'Impact', 'Diagnose', 'Resolve', 'Escalate', 'Related'];
export const MAX_FIRST_STEPS = 4;

export interface FrontMatter {
  type: string;
  summary: string;
  firstSteps: string[];
}

export interface ParsedRunbook extends FrontMatter {
  file: string;
  body: string;
}

export function parseRunbook(file: string, text: string): ParsedRunbook {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new Error(`${file}: must open with front matter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${file}: front matter is never closed`);
  const fm: Partial<FrontMatter> = { firstSteps: [] };
  let inSteps = false;
  for (const line of lines.slice(1, end)) {
    const step = line.match(/^ {2}- (.+)$/);
    if (inSteps && step) {
      fm.firstSteps!.push(step[1].trim());
      continue;
    }
    inSteps = false;
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!field) throw new Error(`${file}: can't read front matter line "${line}"`);
    const [, name, value] = field;
    if (name === 'type') fm.type = value.trim();
    else if (name === 'summary') fm.summary = value.trim();
    else if (name === 'first_steps' && value.trim() === '') inSteps = true;
    else throw new Error(`${file}: unknown front matter field "${name}"`);
  }
  if (!fm.type) throw new Error(`${file}: front matter needs a type`);
  if (!fm.summary) throw new Error(`${file}: front matter needs a summary`);
  if (fm.firstSteps!.length < 1 || fm.firstSteps!.length > MAX_FIRST_STEPS) {
    throw new Error(`${file}: needs 1 to ${MAX_FIRST_STEPS} first_steps`);
  }
  return { file, type: fm.type, summary: fm.summary, firstSteps: fm.firstSteps!, body: lines.slice(end + 1).join('\n') };
}

export function readRunbooks(kind: 'alerts' | 'cloudwatch'): ParsedRunbook[] {
  const dir = path.join(RUNBOOKS_DIR, kind);
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    .map(f => parseRunbook(`${kind}/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')));
}

export function buildRunbooks(): string {
  const entries = (kind: 'alerts' | 'cloudwatch') => Object.fromEntries(readRunbooks(kind).map(r => [r.type, {
    summary: r.summary, firstSteps: r.firstSteps, url: `${URL_BASE}/${r.file}`,
  }]));
  return `${JSON.stringify({ alerts: entries('alerts'), cloudwatch: entries('cloudwatch') }, null, 2)}\n`;
}

if (require.main === module) {
  fs.writeFileSync(GENERATED_PATH, buildRunbooks());
  console.log(`Wrote ${path.relative(process.cwd(), GENERATED_PATH)}`);
}
