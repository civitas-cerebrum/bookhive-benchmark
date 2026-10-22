import { readFile } from 'node:fs/promises';
import type { Results, RegressionVerdict } from './types.js';
import type { HistoryRecord } from './baseline.js';

/** The active baseline is a normalised history record (see baseline.ts). */
export type Baseline = HistoryRecord;

type Delta = Results['baseline_comparison']['deltas'][string];

/**
 * Reads baseline.json. Also accepts the legacy placeholder shape
 * ({ totals.tokens.total, run.duration_sec, outcomes.tests_passing.ratio })
 * and maps it to a record whose other metrics are null (so they are skipped).
 */
export async function readBaseline(path: string): Promise<Baseline | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
    if (raw.outcomes && 'bugs_by_severity' in raw.outcomes) return raw as unknown as Baseline;
    if (raw.id && raw.outcomes?.tests_passing) {
      return {
        id: raw.id,
        date: '',
        achilles_version: null,
        achilles_commit: null,
        source: 'results.json',
        outcomes: {
          bugs_by_severity: { critical: null, high: null, medium: null, low: null },
          bugs_total: null,
          tests_total: null,
          tests_passing_ratio: raw.outcomes.tests_passing.ratio ?? null,
          scenarios: null,
          journeys: null,
          phases_completed: null,
        },
        process: {
          duration_sec: raw.run?.duration_sec ?? null,
          tokens_total: raw.totals?.tokens?.total ?? null,
        },
        notes: 'legacy baseline shape',
      };
    }
    return null;
  } catch {
    return null;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function pct(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : 100;
  return round2(((current - baseline) / baseline) * 100);
}

type Polarity = 'lower-better' | 'higher-better';

/** Builds a delta, or returns null when either side is unknown (null metrics are skipped). */
function delta(
  b: number | null | undefined,
  c: number | null | undefined,
  polarity: Polarity,
  kind: 'pct' | 'abs' | 'both',
  note?: string,
): Delta | null {
  if (b === null || b === undefined || c === null || c === undefined) return null;
  const d: Delta = { baseline: b, current: c };
  if (kind === 'pct' || kind === 'both') d.delta_pct = pct(b, c);
  if (kind === 'abs' || kind === 'both') d.delta_abs = round4(c - b);
  if (c === b) d.direction = 'same';
  else if (polarity === 'higher-better') d.direction = c > b ? 'better' : 'worse';
  else d.direction = c < b ? 'better' : 'worse';
  if (note) d.note = note;
  return d;
}

const DETECTION = 'bug detection on a frozen target: more found is better';

export function compare(current: Results, baseline: Baseline | null): Results {
  if (!baseline) {
    return {
      ...current,
      baseline_comparison: { ...current.baseline_comparison, baseline_id: null },
    };
  }

  const t = current.baseline_comparison.regression_thresholds;
  const bo = baseline.outcomes;
  const co = current.outcomes;
  const cs = co.bugs_filed.by_severity;
  const phasesPassed = current.phases.filter((p) => p.gate_outcome === 'pass').length;

  const candidates: Array<[string, Delta | null]> = [
    ['tokens.total', delta(baseline.process?.tokens_total, current.totals.tokens.total, 'lower-better', 'pct')],
    ['duration_sec', delta(baseline.process?.duration_sec, current.run.duration_sec, 'lower-better', 'pct')],
    ['outcomes.tests_passing.ratio', delta(bo.tests_passing_ratio, co.tests_passing.ratio, 'higher-better', 'abs')],
    ['outcomes.tests_total', delta(bo.tests_total, co.tests_passing.total, 'higher-better', 'both')],
    ['outcomes.bugs_filed.count', delta(bo.bugs_total, co.bugs_filed.count, 'higher-better', 'both', DETECTION)],
    ['outcomes.bugs_filed.critical', delta(bo.bugs_by_severity.critical, cs.critical, 'higher-better', 'both', DETECTION)],
    ['outcomes.bugs_filed.high', delta(bo.bugs_by_severity.high, cs.high, 'higher-better', 'both', DETECTION)],
    ['outcomes.bugs_filed.medium', delta(bo.bugs_by_severity.medium, cs.med, 'higher-better', 'both', DETECTION)],
    ['outcomes.bugs_filed.low', delta(bo.bugs_by_severity.low, cs.low, 'higher-better', 'both', DETECTION)],
    ['phases_completed', delta(bo.phases_completed, phasesPassed, 'higher-better', 'abs')],
  ];
  const deltas: Results['baseline_comparison']['deltas'] = {};
  for (const [k, d] of candidates) if (d) deltas[k] = d;

  let verdict: RegressionVerdict = 'pass';
  if (current.run.truncated) verdict = 'fail';

  const d = deltas;
  const ratioDrop = -(d['outcomes.tests_passing.ratio']?.delta_abs ?? 0);
  if (ratioDrop >= t.tests_ratio_drop) verdict = 'fail';

  if (verdict === 'pass') {
    const tokenDelta = d['tokens.total']?.delta_pct ?? 0;
    const durDelta = d['duration_sec']?.delta_pct ?? 0;
    const testsDrop = -(d['outcomes.tests_total']?.delta_pct ?? 0);
    // Finding fewer critical bugs than the baseline on the same frozen app
    // means detection got worse: warn (never fail) so a human looks.
    const criticalLost = (d['outcomes.bugs_filed.critical']?.delta_abs ?? 0) < 0;
    if (
      tokenDelta >= t.tokens_total_pct ||
      durDelta >= t.duration_pct ||
      testsDrop >= (t.tests_total_drop_pct ?? 25) ||
      criticalLost
    ) {
      verdict = 'warn';
    }
  }

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
