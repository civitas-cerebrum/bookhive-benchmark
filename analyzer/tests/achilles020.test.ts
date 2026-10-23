import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSelfReport, normalizeSeverity } from '../src/readSelfReport.js';
import { findLastSuiteRun, countJourneyMapPages, isFullSuiteCommand, parseSuiteOutput } from '../src/deriveEvidence.js';
import { assemble } from '../src/assemble.js';
import { fromResults } from '../src/baseline.js';
import { compare } from '../src/compare.js';
import { validateResults } from '../src/validate.js';
import type { AssembleInputs, TurnEvent } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => join(here, 'fixtures/achilles-0.2.0', n);

const meta: AssembleInputs['meta'] = {
  achilles_version: '0.2.0', achilles_commit: '84d32d4', claude_code_version: '2.1.296', mode: 'local',
  host: { runner_os: 'Darwin', cpu_count: 8, mem_gb: 16 },
};
const turns: TurnEvent[] = [
  { turn_index: 0, timestamp: '2026-10-15T19:06:00Z', role: 'assistant', tool_calls: [{ name: 'Agent', subagent_type: 'scaffolder' }], tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4, total: 10 } },
  { turn_index: 1, timestamp: '2026-10-15T19:20:00Z', role: 'assistant', tool_calls: [{ name: 'Bash' }], tokens: { input: 1, output: 1, cache_read: 1, cache_creation: 1, total: 4 } },
];

describe('Achilles 0.2.0 run-summary mapping', () => {
  it('maps medium->med, keeps critical and info, defaults missing buckets to 0', () => {
    expect(normalizeSeverity({ critical: 1, high: 2, medium: 3, low: 4, info: 5 })).toEqual({ critical: 1, high: 2, med: 3, low: 4, info: 5 });
    expect(normalizeSeverity({ high: 2, med: 3, low: 4 })).toEqual({ high: 2, med: 3, low: 4 });
    expect(normalizeSeverity({ high: 1 })).toEqual({ high: 1, med: 0, low: 0 });
  });

  it('normalises phases and null tests', async () => {
    const sr = await readSelfReport(fx('run-summary.json'));
    expect(sr?.phases.map((p) => [p.name, p.gate_outcome, p.retries])).toEqual([
      ['scaffold', 'pass', 0], ['groundwork', 'pass', 1], ['journey-mapping', 'fail', 0],
    ]);
    expect(sr?.phases[0]?.started_at).toBe('2026-10-15T19:05:31Z');
    expect(sr?.tests).toEqual({ passing: null, total: null, playwright_exit_code: null });
    expect(sr?.journey_map).toEqual({ pages: null, journeys: 2 });
    expect(sr?.bugs.by_severity).toEqual({ critical: 1, high: 1, med: 2, low: 1, info: 1 });
  });
});

describe('on-disk evidence', () => {
  it('detects full-suite commands only', () => {
    expect(isFullSuiteCommand('npx playwright test --quiet --reporter=dot')).toBe(true);
    expect(isFullSuiteCommand('npx playwright test tests/e2e/a.spec.ts')).toBe(false);
    expect(isFullSuiteCommand('npx playwright test --grep @x')).toBe(false);
    expect(isFullSuiteCommand('ls')).toBe(false);
  });

  it('parses suite output with known-defect failures', () => {
    const r = parseSuiteOutput('Running 12 tests using 4 workers\n  [chromium] › a › b @known-defect › c\n  [chromium] › a › b @known-defect › c\n  1 failed\n  11 passed (3s)');
    expect(r).toMatchObject({ total: 12, passed: 11, failed: 1, known_defect_failures: 1 });
    expect(parseSuiteOutput('no run here')).toBeNull();
  });

  it('takes the last full-suite run, with its exit code', async () => {
    const r = await findLastSuiteRun(fx('suite-transcript.jsonl'));
    expect(r).toMatchObject({ total: 12, passed: 10, failed: 2, known_defect_failures: 1, exit_code: 1 });
  });

  it('counts journey-map pages from the Site Map table, not the header', async () => {
    const r = await countJourneyMapPages(fx('project'));
    expect(r?.pages).toBe(3);
    expect(r?.source).toContain('journey-map.md');
    expect(await countJourneyMapPages('/nonexistent')).toBeNull();
  });
});

describe('assemble with a 0.2.0 self-report', () => {
  it('derives tests, exit code and pages from evidence, notes sources, and validates', async () => {
    const selfReport = await readSelfReport(fx('run-summary.json'));
    const suite = await findLastSuiteRun(fx('suite-transcript.jsonl'));
    const journeyMapPages = await countJourneyMapPages(fx('project'));
    const res = assemble({ turns, hookEvents: [], selfReport, retrospective: null, meta, evidence: { suite, journeyMapPages } });
    const o = res.outcomes;
    expect(o.bugs_filed.by_severity).toEqual({ critical: 1, high: 1, med: 2, low: 1, info: 1 });
    expect(o.tests_passing).toMatchObject({ count: 10, total: 12, known_defect_failures: 1 });
    expect(o.tests_passing.ratio).toBeCloseTo(10 / 12);
    expect(o.tests_passing.ratio_excluding_known_defects).toBeCloseTo(10 / 11);
    expect(o.playwright_exit_code).toBe(1);
    expect(o.journey_map_pages).toBe(3);
    expect(o.journeys).toBe(2);
    expect(Object.keys(o.metric_sources ?? {})).toEqual(expect.arrayContaining(['tests_passing', 'playwright_exit_code', 'journey_map_pages']));
    // no hook log: totals come from the whole transcript, dispatches from Agent tool calls
    expect(res.totals).toMatchObject({ turns: 2, subagent_dispatches: 1 });
    expect(res.totals.tokens.total).toBe(14);
    expect(res.phases[0]).toMatchObject({ name: 'scaffold', turns: 1, gate_outcome: 'pass' });
    expect(res.phases[0]?.subagent_dispatches).toHaveLength(1);
    expect(res.phases[1]).toMatchObject({ name: 'groundwork', turns: 1 });
    expect(await validateResults(res)).toEqual({ ok: true });
  });

  it('emits null (schema-valid) when a metric has no record', async () => {
    const selfReport = await readSelfReport(fx('run-summary.json'));
    const res = assemble({ turns, hookEvents: [], selfReport, retrospective: null, meta, evidence: {} });
    expect(res.outcomes.tests_passing).toMatchObject({ count: null, total: null, ratio: null });
    expect(res.outcomes.playwright_exit_code).toBeNull();
    expect(res.outcomes.journey_map_pages).toBeNull();
    expect(res.outcomes.metric_sources?.tests_passing).toContain('unavailable');
    expect(await validateResults(res)).toEqual({ ok: true });
  });

  it('records info as a separate bucket that is not a bug in history or comparison', async () => {
    const selfReport = await readSelfReport(fx('run-summary.json'));
    const suite = await findLastSuiteRun(fx('suite-transcript.jsonl'));
    const res = assemble({ turns, hookEvents: [], selfReport, retrospective: null, meta, evidence: { suite } });
    const rec = fromResults(res);
    expect(rec.outcomes.bugs_total).toBe(5);
    expect(rec.outcomes.bugs_info).toBe(1);
    expect(rec.outcomes.bugs_by_severity).toEqual({ critical: 1, high: 1, medium: 2, low: 1 });
    expect(rec.outcomes.journeys).toBe(2);
    expect(rec.outcomes.tests_passing_ratio_excl_known_defects).toBeCloseTo(10 / 11);
    const cmp = compare(res, { ...rec, id: 'b', outcomes: { ...rec.outcomes, bugs_total: 4 } });
    expect(cmp.baseline_comparison.deltas['outcomes.bugs_filed.count']).toMatchObject({ baseline: 4, current: 5, direction: 'better' });
  });
});
