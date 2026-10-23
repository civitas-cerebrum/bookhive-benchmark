import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBaseline } from '../src/baselineCli.js';
import { fromResults, readJsonl, validateRecord, incompleteReasons, type HistoryRecord } from '../src/baseline.js';
import type { Results } from '../src/types.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

async function happy(): Promise<Results> {
  return JSON.parse(await readFile(join(here, 'fixtures/happy/expected-results.json'), 'utf8')) as Results;
}

let dir: string;
let resultsFile: string;
const lines: string[] = [];
const out = (s: string) => lines.push(s);

async function writeResults(name: string, r: Results): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(r));
  return p;
}
const history = async () => readJsonl(await readFile(join(dir, 'baseline/history.jsonl'), 'utf8'));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bhb-baseline-'));
  await mkdir(join(dir, 'baseline'));
  process.env.BASELINE_DIR = join(dir, 'baseline');
  lines.length = 0;
  resultsFile = await writeResults('r1.json', await happy());
});

describe('committed history', () => {
  it('every line is a valid record, ids are unique, and baseline.json is one of them', async () => {
    const recs = readJsonl(await readFile(join(repoRoot, 'baseline/history.jsonl'), 'utf8'));
    expect(recs.length).toBeGreaterThanOrEqual(4);
    for (const r of recs) expect(validateRecord(r), r.id).toEqual([]);
    expect(new Set(recs.map((r) => r.id)).size).toBe(recs.length);
    const active = JSON.parse(await readFile(join(repoRoot, 'baseline/baseline.json'), 'utf8')) as HistoryRecord;
    expect(validateRecord(active)).toEqual([]);
    expect(recs.find((r) => r.id === active.id)).toEqual(active);
  });

  it('every null metric has a source note', async () => {
    const recs = readJsonl(await readFile(join(repoRoot, 'baseline/history.jsonl'), 'utf8'));
    for (const r of recs) {
      const o = r.outcomes;
      const nulls: string[] = [];
      for (const [k, v] of Object.entries(o)) if (v === null) nulls.push(k);
      for (const [k, v] of Object.entries(o.bugs_by_severity)) if (v === null) nulls.push(`bugs_by_severity.${k}`);
      for (const [k, v] of Object.entries(r.process ?? {})) if (v === null) nulls.push(`process.${k}`);
      if (r.achilles_version === null) nulls.push('achilles_version');
      if (r.achilles_commit === null) nulls.push('achilles_commit');
      for (const n of nulls) {
        const hit = Object.keys(r.metric_sources ?? {}).some((k) => k === n || n.startsWith(`${k}.`) || k.startsWith(n));
        expect(hit, `${r.id}: null ${n} has no metric_sources entry`).toBe(true);
      }
    }
  });
});

describe('fromResults', () => {
  it('normalises med -> medium and keeps unreported critical as null', async () => {
    const rec = fromResults(await happy());
    expect(rec.outcomes.bugs_by_severity).toEqual({ critical: null, high: 0, medium: 1, low: 0 });
    expect(rec.outcomes.tests_total).toBe(12);
    expect(rec.outcomes.phases_completed).toBe(8);
    expect(rec.source).toBe('results.json');
    expect(validateRecord(rec)).toEqual([]);
  });
});

describe('record', () => {
  it('appends one line and is idempotent', async () => {
    expect(await runBaseline(['record', resultsFile], out)).toBe(0);
    expect(await runBaseline(['record', resultsFile], out)).toBe(0);
    expect(await history()).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/already recorded/);
  });

  it('never touches baseline.json (does not promote)', async () => {
    await runBaseline(['record', resultsFile], out);
    await expect(readFile(join(dir, 'baseline/baseline.json'), 'utf8')).rejects.toThrow();
  });

  it('is append-only: earlier lines are byte-identical afterwards', async () => {
    await runBaseline(['record', resultsFile], out);
    const before = await readFile(join(dir, 'baseline/history.jsonl'), 'utf8');
    const second = await happy();
    second.run.id = 'another-run';
    await runBaseline(['record', await writeResults('r2.json', second)], out);
    const after = await readFile(join(dir, 'baseline/history.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split('\n')).toHaveLength(2);
  });

  it('carries pending-notes.txt into notes once, then clears it', async () => {
    await writeFile(join(dir, 'baseline/pending-notes.txt'), 'mixed build\n');
    await runBaseline(['record', resultsFile, '--notes', 'extra'], out);
    expect((await history())[0]!.notes).toBe('mixed build | extra');
    expect(await readFile(join(dir, 'baseline/pending-notes.txt'), 'utf8')).toBe('');
  });
});

describe('promote', () => {
  it('writes baseline.json, records the run, and keeps the previous baseline in history', async () => {
    const prev = fromResults(await happy());
    prev.id = 'prev-baseline';
    await writeFile(join(dir, 'baseline/baseline.json'), JSON.stringify(prev));
    expect(await runBaseline(['promote', resultsFile], out)).toBe(0);
    const active = JSON.parse(await readFile(join(dir, 'baseline/baseline.json'), 'utf8')) as HistoryRecord;
    expect(active.id).toBe((await happy()).run.id);
    expect((await history()).map((r) => r.id)).toEqual(['prev-baseline', active.id]);
  });

  it('can promote an existing history entry by id substring', async () => {
    await runBaseline(['record', resultsFile], out);
    const id = (await history())[0]!.id;
    expect(await runBaseline(['promote', id.slice(0, 12)], out)).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'baseline/baseline.json'), 'utf8')).id).toBe(id);
    expect(await history()).toHaveLength(1);
  });

  it('refuses a truncated run unless --force', async () => {
    const r = await happy();
    r.run.truncated = true;
    const f = await writeResults('trunc.json', r);
    expect(await runBaseline(['promote', f], out)).toBe(1);
    await expect(readFile(join(dir, 'baseline/baseline.json'), 'utf8')).rejects.toThrow();
    expect(await runBaseline(['promote', f, '--force'], out)).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'baseline/baseline.json'), 'utf8')).truncated).toBe(true);
  });

  it('refuses an incomplete run (a phase gate failed, or no tests) unless --force', async () => {
    const r = await happy();
    r.phases[7]!.gate_outcome = 'fail';
    expect(incompleteReasons(fromResults(r))[0]).toMatch(/7\/8 phases/);
    expect(await runBaseline(['promote', await writeResults('inc.json', r)], out)).toBe(1);

    const empty = await happy();
    empty.run.id = 'empty';
    empty.outcomes.tests_passing = { count: 0, total: 0, ratio: 0 };
    expect(await runBaseline(['promote', await writeResults('empty.json', empty)], out)).toBe(1);
  });

  it('refuses an unknown id', async () => {
    await expect(runBaseline(['promote', 'nope'], out)).rejects.toThrow(/no history entry/);
  });
});

describe('scripts/baseline.sh', () => {
  it('show prints the history table and marks the active baseline', async () => {
    const { stdout } = await exec('sh', ['scripts/baseline.sh', 'show'], { cwd: repoRoot, env: { ...process.env, BASELINE_DIR: join(repoRoot, 'baseline') } });
    // The active baseline is whatever baseline/baseline.json holds; never hardcode it.
    const active = JSON.parse(await readFile(join(repoRoot, 'baseline/baseline.json'), 'utf8')).id as string;
    const esc = active.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(stdout).toContain('2026-06-22T20:01:58Z-dda8611');
    expect(stdout).toMatch(new RegExp(`\\*\\s+${esc}`));
    expect(stdout.match(/^\*\s+\d{4}-/gm)?.length).toBe(1);
  }, 30_000);

  it('rejects an unknown subcommand', async () => {
    await expect(exec('sh', ['scripts/baseline.sh', 'bogus'], { cwd: repoRoot })).rejects.toMatchObject({ code: 2 });
  });
});
