export type PhaseName =
  | 'scaffold' | 'groundwork' | 'happy-path' | 'journey-mapping'
  | 'coverage-expansion' | 'bug-discovery' | 'secrets-sweep' | 'report';

export type Tokens = {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
};

export type RegressionVerdict = 'pass' | 'warn' | 'fail';

export type TurnEvent = {
  turn_index: number;
  timestamp: string;
  role: 'user' | 'assistant';
  tokens?: Tokens;
  tool_calls: { name: string }[];
};

export type HookEvent =
  | { t: string; kind: 'phase.start'; phase: PhaseName; turn_index: number }
  | { t: string; kind: 'phase.end'; phase: PhaseName; turn_index: number; gate_result: 'pass' | 'fail' }
  | { t: string; kind: 'subagent.dispatch'; parent_phase: PhaseName; subagent_type: string; prompt_chars: number };

export type SelfReport = {
  phases: Array<{ name: PhaseName; gate_outcome: 'pass' | 'fail'; retries: number }>;
  scenarios: { files: string[] };
  bugs: {
    ids: string[];
    by_severity: { critical?: number; high: number; med: number; low: number };
  };
  tests: { passing: number; total: number; playwright_exit_code: number };
  journey_map: { pages: number };
};

export type Retrospective = {
  novel_observations: string;
  difficulties: string;
  would_do_differently: string;
  per_phase_impact: Array<{ phase: PhaseName; impact: string }>;
};

export type AssembleInputs = {
  turns: TurnEvent[];
  hookEvents: HookEvent[];
  selfReport: SelfReport | null;
  retrospective: Retrospective | null;
  meta: {
    achilles_version: string;
    achilles_commit: string;
    claude_code_version: string;
    mode: 'local' | 'ci';
    host: { runner_os: string; cpu_count: number; mem_gb: number };
  };
};

export type Results = {
  schema_version: '1.0.0';
  run: {
    id: string;
    started_at: string;
    ended_at: string;
    duration_sec: number;
    mode: 'local' | 'ci';
    truncated: boolean;
    achilles_version: string;
    achilles_commit: string;
    claude_code_version: string;
    host: { runner_os: string; cpu_count: number; mem_gb: number };
  };
  totals: {
    tokens: Tokens;
    turns: number;
    tool_calls: number;
    subagent_dispatches: number;
    gate_failures: number;
    retries: number;
  };
  phases: Array<{
    name: PhaseName;
    started_at: string;
    ended_at: string;
    duration_sec: number;
    turns: number;
    tokens: Tokens;
    tool_calls_by_name: Record<string, number>;
    subagent_dispatches: Array<{
      subagent_type: string;
      duration_sec: number;
      tokens: Tokens;
      returned_ok: boolean;
    }>;
    gate_outcome: 'pass' | 'fail';
    retries: number;
  }>;
  outcomes: {
    scenarios_written: { count: number; files: string[] };
    bugs_filed: { count: number; by_severity: { critical?: number; high: number; med: number; low: number }; ids: string[] };
    tests_passing: { count: number; total: number; ratio: number };
    playwright_exit_code: number;
    journey_map_pages: number;
  };
  retrospective: Retrospective;
  discrepancies: Array<{ kind: string; detail: string; self_report?: unknown; on_disk?: unknown }>;
  baseline_comparison: {
    baseline_id: string | null;
    deltas: Record<string, { baseline: number; current: number; delta_pct?: number; delta_abs?: number; direction?: 'better' | 'worse' | 'same'; note?: string }>;
    regression_verdict: RegressionVerdict;
    regression_thresholds: { tokens_total_pct: number; duration_pct: number; tests_ratio_drop: number; tests_total_drop_pct?: number };
  };
};
