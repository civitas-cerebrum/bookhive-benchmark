import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compare, readBaseline } from '../src/compare.js';
import type { Results } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureBaseline = join(here, 'fixtures/baseline/baseline.json');
const sparseBaseline = join(here, 'fixtures/baseline/baseline-sparse.json');

async function happyResult(): Promise<Results> {
  return JSON.parse(await readFile(join(here, 'fixtures/happy/expected-results.json'), 'utf8')) as Results;
}

describe('compare', () => {
  it('verdict = pass when deltas are within thresholds', async () => {
    const out = compare(await happyResult(), await readBaseline(fixtureBaseline));
    expect(out.baseline_comparison.regression_verdict).toBe('pass');
    expect(out.baseline_comparison.baseline_id).toBe('fixture-baseline');
  });

  it('matches the golden comparison', async () => {
    const out = compare(await happyResult(), await readBaseline(fixtureBaseline));
    const golden = JSON.parse(await readFile(join(here, 'fixtures/baseline/expected-comparison.json'), 'utf8'));
    expect(out.baseline_comparison).toEqual(golden);
  });

  it('verdict = fail when truncated', async () => {
    const current = await happyResult();
    current.run.truncated = true;
    const out = compare(current, await readBaseline(fixtureBaseline));
    expect(out.baseline_comparison.regression_verdict).toBe('fail');
  });

  it('verdict = fail when test-pass ratio drops more than threshold', async () => {
    const current = await happyResult();
    current.outcomes.tests_passing.ratio = 0.5;
    const out = compare(current, await readBaseline(fixtureBaseline));
    expect(out.baseline_comparison.regression_verdict).toBe('fail');
  });

  it('verdict = warn when token delta exceeds threshold', async () => {
    const current = await happyResult();
    current.totals.tokens.total = 500;
    const out = compare(current, await readBaseline(fixtureBaseline));
    expect(out.baseline_comparison.regression_verdict).toBe('warn');
    expect(out.baseline_comparison.deltas['tokens.total']?.direction).toBe('worse');
  });

  it('verdict = warn when the total test count drops past the threshold', async () => {
    const current = await happyResult();
    current.outcomes.tests_passing = { count: 5, total: 5, ratio: 1 };
    const out = compare(current, await readBaseline(fixtureBaseline));
    expect(out.baseline_comparison.deltas['outcomes.tests_total']).toMatchObject({ baseline: 10, current: 5, delta_abs: -5, direction: 'worse' });
    expect(out.baseline_comparison.regression_verdict).toBe('warn');
  });

  it('leaves baseline_id null and verdict pass when no baseline', async () => {
    const out = compare(await happyResult(), null);
    expect(out.baseline_comparison.baseline_id).toBeNull();
    expect(out.baseline_comparison.regression_verdict).toBe('pass');
  });
});

describe('compare: bug outcomes', () => {
  it('more bugs found on the same target is better, not a regression', async () => {
    const current = await happyResult();
    current.outcomes.bugs_filed = { count: 5, ids: ['a', 'b', 'c', 'd', 'e'], by_severity: { critical: 3, high: 1, med: 1, low: 0 } };
    const out = compare(current, await readBaseline(fixtureBaseline));
    const d = out.baseline_comparison.deltas;
    expect(d['outcomes.bugs_filed.critical']).toMatchObject({ baseline: 1, current: 3, delta_abs: 2, direction: 'better' });
    expect(d['outcomes.bugs_filed.count']).toMatchObject({ baseline: 1, current: 5, direction: 'better' });
    expect(out.baseline_comparison.regression_verdict).toBe('pass');
  });

  it('finding fewer critical bugs than the baseline warns (detection got worse)', async () => {
    const current = await happyResult();
    current.outcomes.bugs_filed.by_severity = { critical: 0, high: 0, med: 1, low: 0 };
    const out = compare(current, await readBaseline(fixtureBaseline));
    expect(out.baseline_comparison.deltas['outcomes.bugs_filed.critical']).toMatchObject({ delta_abs: -1, direction: 'worse' });
    expect(out.baseline_comparison.regression_verdict).toBe('warn');
  });

  it('skips a severity bucket the current run does not report', async () => {
    const out = compare(await happyResult(), await readBaseline(fixtureBaseline));
    expect(out.baseline_comparison.deltas).not.toHaveProperty('outcomes.bugs_filed.critical');
  });
});

describe('compare: null baseline metrics are skipped, not failed', () => {
  it('compares only what the baseline knows', async () => {
    const out = compare(await happyResult(), await readBaseline(sparseBaseline));
    expect(Object.keys(out.baseline_comparison.deltas).sort()).toEqual([
      'outcomes.tests_passing.ratio',
      'outcomes.tests_total',
    ]);
    expect(out.baseline_comparison.regression_verdict).toBe('pass');
  });
});

describe('the committed baseline', () => {
  it('is readable and carries comparable metrics', async () => {
    const b = await readBaseline(join(here, '../../baseline/baseline.json'));
    expect(b).not.toBeNull();
    expect(b!.outcomes.tests_total).toBeGreaterThan(0);
    expect(b!.outcomes.bugs_by_severity.critical).not.toBeUndefined();
  });

  it('maps the legacy placeholder shape without throwing', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'bhb-legacy-'));
    const p = join(dir, 'baseline.json');
    await writeFile(p, JSON.stringify({ id: 'old', totals: { tokens: { total: 200 } }, run: { duration_sec: 20 }, outcomes: { tests_passing: { ratio: 1 } } }));
    const b = await readBaseline(p);
    expect(b?.process?.tokens_total).toBe(200);
    expect(b?.outcomes.tests_total).toBeNull();
    const out = compare(await happyResult(), b);
    expect(out.baseline_comparison.regression_verdict).toBe('pass');
  });
});
