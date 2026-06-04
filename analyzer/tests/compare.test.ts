import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compare, readBaseline } from '../src/compare.js';
import type { Results } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

async function happyResult(): Promise<Results> {
  return JSON.parse(await readFile(join(here, 'fixtures/happy/expected-results.json'), 'utf8')) as Results;
}

describe('compare', () => {
  it('verdict = pass when deltas are within thresholds', async () => {
    const current = await happyResult();
    const baseline = await readBaseline(join(here, '../../baseline/baseline.json'));
    const out = compare(current, baseline);
    expect(out.baseline_comparison.regression_verdict).toBe('pass');
    expect(out.baseline_comparison.baseline_id).toMatch(/main/);
  });

  it('verdict = fail when truncated', async () => {
    const current = await happyResult();
    current.run.truncated = true;
    const baseline = await readBaseline(join(here, '../../baseline/baseline.json'));
    const out = compare(current, baseline);
    expect(out.baseline_comparison.regression_verdict).toBe('fail');
  });

  it('verdict = fail when test-pass ratio drops more than threshold', async () => {
    const current = await happyResult();
    current.outcomes.tests_passing.ratio = 0.5;
    const baseline = await readBaseline(join(here, '../../baseline/baseline.json'));
    const out = compare(current, baseline);
    expect(out.baseline_comparison.regression_verdict).toBe('fail');
  });

  it('verdict = warn when token delta exceeds threshold', async () => {
    const current = await happyResult();
    current.totals.tokens.total = 500;
    const baseline = await readBaseline(join(here, '../../baseline/baseline.json'));
    const out = compare(current, baseline);
    expect(out.baseline_comparison.regression_verdict).toBe('warn');
  });

  it('leaves baseline_id null and verdict pass when no baseline', async () => {
    const current = await happyResult();
    const out = compare(current, null);
    expect(out.baseline_comparison.baseline_id).toBeNull();
    expect(out.baseline_comparison.regression_verdict).toBe('pass');
  });
});
