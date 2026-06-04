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

function secondsBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
}

export function assemble(inputs: AssembleInputs): Results {
  const { turns, hookEvents, selfReport, retrospective, meta } = inputs;
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
    const inPhase = (i: number) => startIdx >= 0 && endIdx >= 0 && i >= startIdx && i <= endIdx;

    let tokens = ZERO_TOKENS;
    let nTurns = 0;
    const tool_calls_by_name: Record<string, number> = {};
    const subagent_dispatches: Results['phases'][number]['subagent_dispatches'] = [];

    for (const t of turns) {
      if (!inPhase(t.turn_index)) continue;
      nTurns += 1;
      tokens = addTokens(tokens, t.tokens);
      for (const c of t.tool_calls) {
        tool_calls_by_name[c.name] = (tool_calls_by_name[c.name] ?? 0) + 1;
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
      started_at: start?.t ?? started_at,
      ended_at: end?.t ?? ended_at,
      duration_sec: start && end ? secondsBetween(start.t, end.t) : 0,
      turns: nTurns,
      tokens,
      tool_calls_by_name,
      subagent_dispatches,
      gate_outcome,
      retries: sr_phase?.retries ?? 0,
    };
  });

  const totals = phasesOut.reduce(
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
        tests_passing: {
          count: selfReport.tests.passing,
          total: selfReport.tests.total,
          ratio: selfReport.tests.total === 0 ? 0 : selfReport.tests.passing / selfReport.tests.total,
        },
        playwright_exit_code: selfReport.tests.playwright_exit_code,
        journey_map_pages: selfReport.journey_map.pages,
      }
    : {
        scenarios_written: { count: 0, files: [] },
        bugs_filed: { count: 0, by_severity: { high: 0, med: 0, low: 0 }, ids: [] },
        tests_passing: { count: 0, total: 0, ratio: 0 },
        playwright_exit_code: -1,
        journey_map_pages: 0,
      };

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
