import { readFile } from 'node:fs/promises';
import type { Results, RegressionVerdict } from './types.js';

export type Baseline = {
  id: string;
  totals: { tokens: { total: number } };
  run: { duration_sec: number };
  outcomes: { tests_passing: { ratio: number } };
};

export async function readBaseline(path: string): Promise<Baseline | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Baseline;
  } catch {
    return null;
  }
}

function pct(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - baseline) / baseline) * 10000) / 100;
}

export function compare(current: Results, baseline: Baseline | null): Results {
  if (!baseline) {
    return {
      ...current,
      baseline_comparison: { ...current.baseline_comparison, baseline_id: null },
    };
  }

  const t = current.baseline_comparison.regression_thresholds;
  const deltas: Results['baseline_comparison']['deltas'] = {
    'tokens.total': {
      baseline: baseline.totals.tokens.total,
      current: current.totals.tokens.total,
      delta_pct: pct(baseline.totals.tokens.total, current.totals.tokens.total),
    },
    'duration_sec': {
      baseline: baseline.run.duration_sec,
      current: current.run.duration_sec,
      delta_pct: pct(baseline.run.duration_sec, current.run.duration_sec),
    },
    'outcomes.tests_passing.ratio': {
      baseline: baseline.outcomes.tests_passing.ratio,
      current: current.outcomes.tests_passing.ratio,
      delta_abs: Math.round((current.outcomes.tests_passing.ratio - baseline.outcomes.tests_passing.ratio) * 10000) / 10000,
    },
  };

  let verdict: RegressionVerdict = 'pass';
  if (current.run.truncated) verdict = 'fail';
  const tokenDelta = deltas['tokens.total']?.delta_pct ?? 0;
  const durDelta = deltas['duration_sec']?.delta_pct ?? 0;
  const ratioDrop = -(deltas['outcomes.tests_passing.ratio']?.delta_abs ?? 0);
  if (ratioDrop >= t.tests_ratio_drop) verdict = 'fail';
  if (verdict === 'pass' && (tokenDelta >= t.tokens_total_pct || durDelta >= t.duration_pct)) verdict = 'warn';

  return {
    ...current,
    baseline_comparison: {
      baseline_id: baseline.id,
      deltas,
      regression_verdict: verdict,
      regression_thresholds: t,
    },
  };
}
