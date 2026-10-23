import { access, readdir } from 'node:fs/promises';
import type { AssembleInputs, Results, Tokens, PhaseName, HookEvent } from './types.js';

const ZERO_TOKENS: Tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
const PHASE_ORDER: PhaseName[] = ['scaffold', 'groundwork', 'happy-path', 'journey-mapping', 'coverage-expansion', 'bug-discovery', 'secrets-sweep', 'report'];

function addTokens(a: Tokens, b: Tokens | undefined): Tokens {
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_creation: a.cache_creation + b.cache_creation,
    total: a.total + b.total,
  };
}

function phaseRange(hookEvents: HookEvent[], phase: PhaseName): { start?: HookEvent; end?: HookEvent } {
  const start = hookEvents.find((e) => e.kind === 'phase.start' && e.phase === phase);
  const end = hookEvents.find((e) => e.kind === 'phase.end' && e.phase === phase);
  const out: { start?: HookEvent; end?: HookEvent } = {};
  if (start) out.start = start;
  if (end) out.end = end;
  return out;
}

function inWindow(ts: string, start: number, end: number): boolean {
  const t = Date.parse(ts);
  return !Number.isNaN(t) && !Number.isNaN(start) && !Number.isNaN(end) && t >= start && t <= end;
}

function ratioOf(count: number | null, total: number | null): number | null {
  if (count === null || total === null) return null;
  return total === 0 ? 0 : count / total;
}

function secondsBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
}

function hooklessTotals(turns: AssembleInputs['turns'], phasesOut: Results['phases']): Results['totals'] {
  let tokens = ZERO_TOKENS;
  let tool_calls = 0;
  let dispatches = 0;
  for (const t of turns) {
    tokens = addTokens(tokens, t.tokens);
    tool_calls += t.tool_calls.length;
    dispatches += t.tool_calls.filter((c) => c.name === 'Agent' || c.name === 'Task').length;
  }
  return {
    tokens,
    turns: turns.length,
    tool_calls,
    subagent_dispatches: dispatches,
    gate_failures: phasesOut.filter((p) => p.gate_outcome === 'fail').length,
    retries: phasesOut.reduce((s, p) => s + p.retries, 0),
  };
}

export function assemble(inputs: AssembleInputs): Results {
  const { turns, hookEvents, selfReport, retrospective, meta } = inputs;
  const evidence = inputs.evidence ?? {};
  // Without phase hooks (no hook log) phases are windowed by the self-report ledger timestamps.
  const hookless = !hookEvents.some((e) => e.kind === 'phase.start');
  const discrepancies: Results['discrepancies'] = [];

  const started_at = turns[0]?.timestamp ?? new Date(0).toISOString();
  const ended_at = turns[turns.length - 1]?.timestamp ?? started_at;
  const duration_sec = secondsBetween(started_at, ended_at);

  const phaseRanges = PHASE_ORDER.map((name) => {
    const { start, end } = phaseRange(hookEvents, name);
    return { name, start, end };
  });

  const phasesOut: Results['phases'] = phaseRanges.map(({ name, start, end }) => {
    const startIdx = start && start.kind === 'phase.start' ? start.turn_index : -1;
    const endIdx = end && end.kind === 'phase.end' ? end.turn_index : -1;
    const srp = selfReport?.phases.find((p) => p.name === name);
    const winStart = hookless && srp?.started_at ? Date.parse(srp.started_at) : NaN;
    const winEnd = hookless && srp?.ended_at ? Date.parse(srp.ended_at) : NaN;
    const inPhase = (i: number) => startIdx >= 0 && endIdx >= 0 && i >= startIdx && i <= endIdx;

    let tokens = ZERO_TOKENS;
    let nTurns = 0;
    const tool_calls_by_name: Record<string, number> = {};
    const subagent_dispatches: Results['phases'][number]['subagent_dispatches'] = [];

    for (const t of turns) {
      if (hookless ? !inWindow(t.timestamp, winStart, winEnd) : !inPhase(t.turn_index)) continue;
      nTurns += 1;
      tokens = addTokens(tokens, t.tokens);
      for (const c of t.tool_calls) {
        tool_calls_by_name[c.name] = (tool_calls_by_name[c.name] ?? 0) + 1;
      }
    }
    if (hookless) {
      for (const t of turns) {
        if (!inWindow(t.timestamp, winStart, winEnd)) continue;
        for (const c of t.tool_calls) {
          if (c.name === 'Agent' || c.name === 'Task') {
            subagent_dispatches.push({ subagent_type: c.subagent_type ?? 'unknown', duration_sec: 0, tokens: ZERO_TOKENS, returned_ok: true });
          }
        }
      }
    }
    for (const e of hookEvents) {
      if (e.kind === 'subagent.dispatch' && e.parent_phase === name) {
        subagent_dispatches.push({
          subagent_type: e.subagent_type,
          duration_sec: 0,
          tokens: ZERO_TOKENS,
          returned_ok: true,
        });
      }
    }

    const sr_phase = selfReport?.phases.find((p) => p.name === name);
    const gate_outcome: 'pass' | 'fail' =
      end && end.kind === 'phase.end'
        ? end.gate_result
        : sr_phase?.gate_outcome ?? 'pass';

    return {
      name,
      started_at: start?.t ?? (hookless ? srp?.started_at : undefined) ?? started_at,
      ended_at: end?.t ?? (hookless ? srp?.ended_at : undefined) ?? ended_at,
      duration_sec: start && end ? secondsBetween(start.t, end.t) : hookless && srp?.started_at && srp?.ended_at ? secondsBetween(srp.started_at, srp.ended_at) : 0,
      turns: nTurns,
      tokens,
      tool_calls_by_name,
      subagent_dispatches,
      gate_outcome,
      retries: sr_phase?.retries ?? 0,
    };
  });

  const totals = hookless ? hooklessTotals(turns, phasesOut) : phasesOut.reduce(
    (acc, p) => ({
      tokens: addTokens(acc.tokens, p.tokens),
      turns: acc.turns + p.turns,
      tool_calls: acc.tool_calls + Object.values(p.tool_calls_by_name).reduce((s, n) => s + n, 0),
      subagent_dispatches: acc.subagent_dispatches + p.subagent_dispatches.length,
      gate_failures: acc.gate_failures + (p.gate_outcome === 'fail' ? 1 : 0),
      retries: acc.retries + p.retries,
    }),
    {
      tokens: ZERO_TOKENS,
      turns: 0,
      tool_calls: 0,
      subagent_dispatches: 0,
      gate_failures: 0,
      retries: 0,
    } as Results['totals'],
  );

  if (!selfReport) {
    discrepancies.push({ kind: 'self_report_missing', detail: 'achilles run-summary.json not found' });
  }
  if (!retrospective) {
    discrepancies.push({ kind: 'retrospective_missing', detail: 'retrospective.json not found' });
  }

  const outcomes: Results['outcomes'] = selfReport
    ? {
        scenarios_written: { count: selfReport.scenarios.files.length, files: selfReport.scenarios.files },
        bugs_filed: {
          count: selfReport.bugs.ids.length,
          by_severity: selfReport.bugs.by_severity,
          ids: selfReport.bugs.ids,
        },
        tests_passing: { count: selfReport.tests.passing, total: selfReport.tests.total, ratio: ratioOf(selfReport.tests.passing, selfReport.tests.total) },
        playwright_exit_code: selfReport.tests.playwright_exit_code,
        journey_map_pages: selfReport.journey_map.pages,
        ...(selfReport.journey_map.journeys != null ? { journeys: selfReport.journey_map.journeys } : {}),
      }
    : {
        scenarios_written: { count: 0, files: [] },
        bugs_filed: { count: 0, by_severity: { high: 0, med: 0, low: 0 }, ids: [] },
        tests_passing: { count: null, total: null, ratio: null },
        playwright_exit_code: null,
        journey_map_pages: null,
      };

  // Fill what the self-report lacks from on-disk evidence, noting the source. Never invent: stays null if no record.
  const sources: Record<string, string> = {};
  const gap = (metric: string, detail: string, derived: unknown) =>
    discrepancies.push({ kind: 'self_report_gap', detail: `${metric}: ${detail}`, self_report: null, on_disk: derived });
  const suite = evidence.suite;
  const tp = outcomes.tests_passing;
  if (tp.total === null || tp.count === null) {
    if (suite) {
      tp.total = suite.total;
      tp.count = suite.passed;
      tp.ratio = ratioOf(suite.passed, suite.total);
      const src = `last full-suite run in the session transcript (${suite.at}): \`${suite.command}\``;
      sources['tests_passing'] = src;
      gap('tests_passing', `self-report has no totals; used ${src}`, { passed: suite.passed, total: suite.total });
    } else {
      sources['tests_passing'] = 'unavailable: no self-report totals and no full-suite run in the transcript';
    }
  }
  if (tp.count !== null && tp.total !== null) {
    // Known-defect failures come from the same suite run; only meaningful when that run matches the totals used.
    if (suite && suite.total === tp.total && suite.passed === tp.count) {
      tp.known_defect_failures = suite.known_defect_failures;
      const denom = tp.total - suite.known_defect_failures;
      tp.ratio_excluding_known_defects = denom > 0 ? tp.count / denom : null;
      sources['tests_passing.ratio_excluding_known_defects'] = 'failing tests tagged @known-defect in the same suite run are removed from the denominator';
    }
  }
  if (outcomes.playwright_exit_code === null) {
    if (suite) {
      outcomes.playwright_exit_code = suite.exit_code;
      sources['playwright_exit_code'] = `exit code of the same full-suite run (${suite.at})`;
      gap('playwright_exit_code', 'self-report has none; taken from the last full-suite run', suite.exit_code);
    } else {
      sources['playwright_exit_code'] = 'unavailable: no full-suite run in the transcript';
    }
  }
  if (outcomes.journey_map_pages === null) {
    if (evidence.journeyMapPages) {
      outcomes.journey_map_pages = evidence.journeyMapPages.pages;
      sources['journey_map_pages'] = evidence.journeyMapPages.source;
      gap('journey_map_pages', 'self-report has none (it reports journeys, not pages); counted on disk', evidence.journeyMapPages.pages);
    } else {
      sources['journey_map_pages'] = 'unavailable: tests/e2e/docs/journey-map.md not found';
    }
  }
  if (Object.keys(sources).length) outcomes.metric_sources = sources;

  const retro: Results['retrospective'] = retrospective ?? {
    novel_observations: '',
    difficulties: '',
    would_do_differently: '',
    per_phase_impact: [],
  };

  return {
    schema_version: '1.0.0',
    run: {
      id: `${started_at}-${meta.achilles_commit.slice(0, 7)}`,
      started_at,
      ended_at,
      duration_sec,
      mode: meta.mode,
      truncated: false,
      achilles_version: meta.achilles_version,
      achilles_commit: meta.achilles_commit,
      claude_code_version: meta.claude_code_version,
      host: meta.host,
    },
    totals,
    phases: phasesOut,
    outcomes,
    retrospective: retro,
    discrepancies,
    baseline_comparison: {
      baseline_id: null,
      deltas: {},
      regression_verdict: 'pass',
      regression_thresholds: { tokens_total_pct: 25, duration_pct: 50, tests_ratio_drop: 0.1 },
    },
  };
}

export async function crossCheckOnDisk(result: Results, projectDir: string): Promise<Results> {
  const discrepancies = [...result.discrepancies];
  try {
    const testsDir = `${projectDir}/tests`;
    await access(testsDir);
    const files: string[] = [];
    async function walk(d: string) {
      const entries = await readdir(d, { withFileTypes: true });
      for (const ent of entries) {
        const p = `${d}/${ent.name}`;
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile() && /\.spec\.(ts|js|mjs)$/.test(ent.name)) files.push(p);
      }
    }
    await walk(testsDir);
    if (files.length !== result.outcomes.scenarios_written.count) {
      discrepancies.push({
        kind: 'scenario_count_mismatch',
        detail: `self-report says ${result.outcomes.scenarios_written.count}, on-disk has ${files.length}`,
        self_report: result.outcomes.scenarios_written.count,
        on_disk: files.length,
      });
    }
  } catch {
    /* tests/ may not exist; captured elsewhere */
  }
  return { ...result, discrepancies };
}
