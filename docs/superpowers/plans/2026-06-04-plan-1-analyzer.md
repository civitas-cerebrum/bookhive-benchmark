# Plan 1 — Foundation + Schemas + Analyzer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-TS analyzer library and its JSON schemas, with golden-file unit tests. After this plan, you can hand the analyzer three input files (transcript jsonl, hook log jsonl, achilles self-report json) plus an optional baseline, and get back a schema-valid `results.json`.

**Architecture:** Single Node 20+ TypeScript package at the repo root, no workspaces, no framework. `vitest` for tests, `ajv` for JSON Schema validation, `tsx` for running the CLI without a build step. All analyzer code is pure functions over file paths → data. The CLI is a 30-line wrapper.

**Tech Stack:** TypeScript 5, Node 20+, vitest, ajv 8 with ajv-formats, tsx. POSIX shell only where unavoidable.

---

## File structure created by this plan

```
bookhive-benchmark/
├── README.md                     # placeholder; full version in Plan 3
├── PROCESS.md                    # placeholder; full version in Plan 3
├── .gitignore
├── .nvmrc
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── schema/
│   ├── results.schema.json       # the canonical results shape
│   └── run-summary.schema.json   # shared with achilles
├── analyzer/
│   ├── src/
│   │   ├── types.ts              # TS types derived from schemas
│   │   ├── parseTranscript.ts
│   │   ├── parseHookLog.ts
│   │   ├── readSelfReport.ts
│   │   ├── readRetrospective.ts
│   │   ├── assemble.ts
│   │   ├── compare.ts
│   │   ├── validate.ts           # ajv-backed schema validators
│   │   └── cli.ts                # `bookhive-benchmark analyze`
│   └── tests/
│       ├── fixtures/
│       │   ├── happy/
│       │   │   ├── transcript.jsonl
│       │   │   ├── hook.log
│       │   │   ├── run-summary.json
│       │   │   ├── retrospective.json
│       │   │   └── expected-results.json
│       │   ├── truncated/        # one fixture per edge case
│       │   ├── missing-self-report/
│       │   ├── scenario-count-mismatch/
│       │   └── gate-failure/
│       ├── parseTranscript.test.ts
│       ├── parseHookLog.test.ts
│       ├── readSelfReport.test.ts
│       ├── readRetrospective.test.ts
│       ├── assemble.test.ts
│       ├── compare.test.ts
│       └── validate.test.ts
└── baseline/
    └── baseline.json             # seed example baseline
```

## Type contract used across all tasks

These types are defined in `analyzer/src/types.ts` in Task 4 and used by every subsequent task. Use them verbatim — naming differences between tasks are a bug.

```ts
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
  timestamp: string;          // ISO 8601
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
    by_severity: { high: number; med: number; low: number };
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
  selfReport: SelfReport | null;     // null = missing, recorded as discrepancy
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
    bugs_filed: { count: number; by_severity: { high: number; med: number; low: number }; ids: string[] };
    tests_passing: { count: number; total: number; ratio: number };
    playwright_exit_code: number;
    journey_map_pages: number;
  };
  retrospective: Retrospective;
  discrepancies: Array<{ kind: string; detail: string; self_report?: unknown; on_disk?: unknown }>;
  baseline_comparison: {
    baseline_id: string | null;
    deltas: Record<string, { baseline: number; current: number; delta_pct?: number; delta_abs?: number }>;
    regression_verdict: RegressionVerdict;
    regression_thresholds: { tokens_total_pct: number; duration_pct: number; tests_ratio_drop: number };
  };
};
```

---

### Task 1: Project bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `README.md` (placeholder)
- Create: `PROCESS.md` (placeholder)

- [ ] **Step 1: Write `.nvmrc`**

```
20
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "bookhive-benchmark",
  "version": "0.1.0",
  "private": true,
  "description": "Public benchmark harness for @civitas-cerebrum/achilles, run against the BookHive docker target.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": {
    "bookhive-benchmark": "./analyzer/src/cli.ts"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "analyze": "tsx analyzer/src/cli.ts"
  },
  "dependencies": {
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["analyzer/src/**/*.ts", "analyzer/tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['analyzer/tests/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
  },
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
.benchmark/
.achilles/
tests/                  # achilles-generated playwright scaffolding (NOT analyzer/tests)
playwright-report/
test-results/
results/*.json
!results/.gitkeep
.env
.DS_Store
```

- [ ] **Step 6: Write `README.md` placeholder**

```markdown
# bookhive-benchmark

Public benchmark for [`@civitas-cerebrum/achilles`](https://www.npmjs.com/package/@civitas-cerebrum/achilles).

> 🚧 Under construction. Full documentation arrives in Plan 3. For the design, see `docs/superpowers/specs/2026-06-04-bookhive-benchmark-design.md`.

## Quick links
- Spec: [`docs/superpowers/specs/2026-06-04-bookhive-benchmark-design.md`](docs/superpowers/specs/2026-06-04-bookhive-benchmark-design.md)
- Plans: [`docs/superpowers/plans/`](docs/superpowers/plans/)

## License
MIT
```

- [ ] **Step 7: Write `PROCESS.md` placeholder**

```markdown
# Benchmark process

🚧 Authored in Plan 3 once the harness is end-to-end. For now, see the spec at `docs/superpowers/specs/2026-06-04-bookhive-benchmark-design.md` § 4 (Telemetry pipeline) and § 5 (results.json schema).
```

- [ ] **Step 8: Install dependencies**

Run: `cd /Users/Ay/Github/bookhive-benchmark && npm install`
Expected: install completes, `node_modules/` populated, no errors.

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: passes (no source files yet, but config is valid). If it errors with "No inputs were found", that's OK — Task 2 adds the first input.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore(bookhive-benchmark): bootstrap TS package, vitest, tsconfig"
```

---

### Task 2: Write `results.schema.json`

**Files:**
- Create: `schema/results.schema.json`

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/Umutayb/bookhive-benchmark/schema/results.schema.json",
  "title": "bookhive-benchmark results.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "run", "totals", "phases", "outcomes", "retrospective", "discrepancies", "baseline_comparison"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "run": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "started_at", "ended_at", "duration_sec", "mode", "truncated", "achilles_version", "achilles_commit", "claude_code_version", "host"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "started_at": { "type": "string", "format": "date-time" },
        "ended_at": { "type": "string", "format": "date-time" },
        "duration_sec": { "type": "integer", "minimum": 0 },
        "mode": { "enum": ["local", "ci"] },
        "truncated": { "type": "boolean" },
        "achilles_version": { "type": "string" },
        "achilles_commit": { "type": "string" },
        "claude_code_version": { "type": "string" },
        "host": {
          "type": "object",
          "additionalProperties": false,
          "required": ["runner_os", "cpu_count", "mem_gb"],
          "properties": {
            "runner_os": { "type": "string" },
            "cpu_count": { "type": "integer", "minimum": 1 },
            "mem_gb": { "type": "number", "minimum": 0 }
          }
        }
      }
    },
    "totals": {
      "type": "object",
      "additionalProperties": false,
      "required": ["tokens", "turns", "tool_calls", "subagent_dispatches", "gate_failures", "retries"],
      "properties": {
        "tokens": { "$ref": "#/$defs/tokens" },
        "turns": { "type": "integer", "minimum": 0 },
        "tool_calls": { "type": "integer", "minimum": 0 },
        "subagent_dispatches": { "type": "integer", "minimum": 0 },
        "gate_failures": { "type": "integer", "minimum": 0 },
        "retries": { "type": "integer", "minimum": 0 }
      }
    },
    "phases": {
      "type": "array",
      "items": { "$ref": "#/$defs/phase" }
    },
    "outcomes": {
      "type": "object",
      "additionalProperties": false,
      "required": ["scenarios_written", "bugs_filed", "tests_passing", "playwright_exit_code", "journey_map_pages"],
      "properties": {
        "scenarios_written": {
          "type": "object",
          "additionalProperties": false,
          "required": ["count", "files"],
          "properties": {
            "count": { "type": "integer", "minimum": 0 },
            "files": { "type": "array", "items": { "type": "string" } }
          }
        },
        "bugs_filed": {
          "type": "object",
          "additionalProperties": false,
          "required": ["count", "by_severity", "ids"],
          "properties": {
            "count": { "type": "integer", "minimum": 0 },
            "by_severity": {
              "type": "object",
              "additionalProperties": false,
              "required": ["high", "med", "low"],
              "properties": {
                "high": { "type": "integer", "minimum": 0 },
                "med": { "type": "integer", "minimum": 0 },
                "low": { "type": "integer", "minimum": 0 }
              }
            },
            "ids": { "type": "array", "items": { "type": "string" } }
          }
        },
        "tests_passing": {
          "type": "object",
          "additionalProperties": false,
          "required": ["count", "total", "ratio"],
          "properties": {
            "count": { "type": "integer", "minimum": 0 },
            "total": { "type": "integer", "minimum": 0 },
            "ratio": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "playwright_exit_code": { "type": "integer" },
        "journey_map_pages": { "type": "integer", "minimum": 0 }
      }
    },
    "retrospective": { "$ref": "#/$defs/retrospective" },
    "discrepancies": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "detail"],
        "properties": {
          "kind": { "type": "string" },
          "detail": { "type": "string" },
          "self_report": {},
          "on_disk": {}
        }
      }
    },
    "baseline_comparison": {
      "type": "object",
      "additionalProperties": false,
      "required": ["baseline_id", "deltas", "regression_verdict", "regression_thresholds"],
      "properties": {
        "baseline_id": { "type": ["string", "null"] },
        "deltas": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "additionalProperties": false,
            "required": ["baseline", "current"],
            "properties": {
              "baseline": { "type": "number" },
              "current": { "type": "number" },
              "delta_pct": { "type": "number" },
              "delta_abs": { "type": "number" }
            }
          }
        },
        "regression_verdict": { "enum": ["pass", "warn", "fail"] },
        "regression_thresholds": {
          "type": "object",
          "additionalProperties": false,
          "required": ["tokens_total_pct", "duration_pct", "tests_ratio_drop"],
          "properties": {
            "tokens_total_pct": { "type": "number" },
            "duration_pct": { "type": "number" },
            "tests_ratio_drop": { "type": "number" }
          }
        }
      }
    }
  },
  "$defs": {
    "tokens": {
      "type": "object",
      "additionalProperties": false,
      "required": ["input", "output", "cache_read", "cache_creation", "total"],
      "properties": {
        "input": { "type": "integer", "minimum": 0 },
        "output": { "type": "integer", "minimum": 0 },
        "cache_read": { "type": "integer", "minimum": 0 },
        "cache_creation": { "type": "integer", "minimum": 0 },
        "total": { "type": "integer", "minimum": 0 }
      }
    },
    "phaseName": {
      "enum": ["scaffold", "groundwork", "happy-path", "journey-mapping", "coverage-expansion", "bug-discovery", "secrets-sweep", "report"]
    },
    "phase": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "started_at", "ended_at", "duration_sec", "turns", "tokens", "tool_calls_by_name", "subagent_dispatches", "gate_outcome", "retries"],
      "properties": {
        "name": { "$ref": "#/$defs/phaseName" },
        "started_at": { "type": "string", "format": "date-time" },
        "ended_at": { "type": "string", "format": "date-time" },
        "duration_sec": { "type": "integer", "minimum": 0 },
        "turns": { "type": "integer", "minimum": 0 },
        "tokens": { "$ref": "#/$defs/tokens" },
        "tool_calls_by_name": {
          "type": "object",
          "additionalProperties": { "type": "integer", "minimum": 0 }
        },
        "subagent_dispatches": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["subagent_type", "duration_sec", "tokens", "returned_ok"],
            "properties": {
              "subagent_type": { "type": "string" },
              "duration_sec": { "type": "integer", "minimum": 0 },
              "tokens": { "$ref": "#/$defs/tokens" },
              "returned_ok": { "type": "boolean" }
            }
          }
        },
        "gate_outcome": { "enum": ["pass", "fail"] },
        "retries": { "type": "integer", "minimum": 0 }
      }
    },
    "retrospective": {
      "type": "object",
      "additionalProperties": false,
      "required": ["novel_observations", "difficulties", "would_do_differently", "per_phase_impact"],
      "properties": {
        "novel_observations": { "type": "string" },
        "difficulties": { "type": "string" },
        "would_do_differently": { "type": "string" },
        "per_phase_impact": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["phase", "impact"],
            "properties": {
              "phase": { "$ref": "#/$defs/phaseName" },
              "impact": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add schema/results.schema.json
git commit -m "feat(schema): add results.json schema (v1.0.0)"
```

---

### Task 3: Write `run-summary.schema.json`

**Files:**
- Create: `schema/run-summary.schema.json`

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/Umutayb/bookhive-benchmark/schema/run-summary.schema.json",
  "title": "achilles run-summary.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["phases", "scenarios", "bugs", "tests", "journey_map"],
  "properties": {
    "phases": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "gate_outcome", "retries"],
        "properties": {
          "name": {
            "enum": ["scaffold", "groundwork", "happy-path", "journey-mapping", "coverage-expansion", "bug-discovery", "secrets-sweep", "report"]
          },
          "gate_outcome": { "enum": ["pass", "fail"] },
          "retries": { "type": "integer", "minimum": 0 }
        }
      }
    },
    "scenarios": {
      "type": "object",
      "additionalProperties": false,
      "required": ["files"],
      "properties": {
        "files": { "type": "array", "items": { "type": "string" } }
      }
    },
    "bugs": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ids", "by_severity"],
      "properties": {
        "ids": { "type": "array", "items": { "type": "string" } },
        "by_severity": {
          "type": "object",
          "additionalProperties": false,
          "required": ["high", "med", "low"],
          "properties": {
            "high": { "type": "integer", "minimum": 0 },
            "med": { "type": "integer", "minimum": 0 },
            "low": { "type": "integer", "minimum": 0 }
          }
        }
      }
    },
    "tests": {
      "type": "object",
      "additionalProperties": false,
      "required": ["passing", "total", "playwright_exit_code"],
      "properties": {
        "passing": { "type": "integer", "minimum": 0 },
        "total": { "type": "integer", "minimum": 0 },
        "playwright_exit_code": { "type": "integer" }
      }
    },
    "journey_map": {
      "type": "object",
      "additionalProperties": false,
      "required": ["pages"],
      "properties": {
        "pages": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add schema/run-summary.schema.json
git commit -m "feat(schema): add run-summary.json schema (shared with achilles)"
```

---

### Task 4: Define `analyzer/src/types.ts`

**Files:**
- Create: `analyzer/src/types.ts`

- [ ] **Step 1: Write the types file**

Copy the type contract from the "Type contract used across all tasks" section at the top of this plan into `analyzer/src/types.ts`. Use exactly those names and shapes.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add analyzer/src/types.ts
git commit -m "feat(analyzer): add shared TS types"
```

---

### Task 5: `parseTranscript` — read Claude Code session jsonl

**Files:**
- Create: `analyzer/src/parseTranscript.ts`
- Create: `analyzer/tests/parseTranscript.test.ts`
- Create: `analyzer/tests/fixtures/happy/transcript.jsonl`

- [ ] **Step 1: Write a small fixture transcript**

Write `analyzer/tests/fixtures/happy/transcript.jsonl` with 3 turns (one user, one assistant with a tool use, one assistant with a Task subagent dispatch):

```jsonl
{"type":"user","turn_index":0,"timestamp":"2026-06-04T10:00:00Z","message":{"role":"user","content":"complete e2e test automation"}}
{"type":"assistant","turn_index":1,"timestamp":"2026-06-04T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Bash","id":"t1"}],"usage":{"input_tokens":120,"output_tokens":40,"cache_read_input_tokens":0,"cache_creation_input_tokens":50}}}
{"type":"assistant","turn_index":2,"timestamp":"2026-06-04T10:00:20Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Task","id":"t2"}],"usage":{"input_tokens":200,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 2: Write the failing test**

```ts
// analyzer/tests/parseTranscript.test.ts
import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../src/parseTranscript.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('parseTranscript', () => {
  it('extracts turn events with usage and tool calls from a happy transcript', async () => {
    const path = join(here, 'fixtures/happy/transcript.jsonl');
    const turns = await parseTranscript(path);

    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ turn_index: 0, role: 'user', tool_calls: [] });
    expect(turns[1]).toMatchObject({
      turn_index: 1,
      role: 'assistant',
      tokens: { input: 120, output: 40, cache_read: 0, cache_creation: 50, total: 210 },
      tool_calls: [{ name: 'Bash' }],
    });
    expect(turns[2]?.tool_calls[0]?.name).toBe('Task');
  });

  it('throws clear error when file is missing', async () => {
    await expect(parseTranscript('/nope/no.jsonl')).rejects.toThrow(/transcript file not found/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- parseTranscript`
Expected: FAIL with `Cannot find module '../src/parseTranscript.js'` or similar.

- [ ] **Step 4: Implement `parseTranscript`**

```ts
// analyzer/src/parseTranscript.ts
import { readFile, access } from 'node:fs/promises';
import type { TurnEvent, Tokens } from './types.js';

export async function parseTranscript(path: string): Promise<TurnEvent[]> {
  try {
    await access(path);
  } catch {
    throw new Error(`transcript file not found: ${path}`);
  }
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const events: TurnEvent[] = [];
  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const turn_index = typeof obj.turn_index === 'number' ? obj.turn_index : events.length;
    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    const role = obj.type === 'user' ? 'user' : 'assistant';

    const tool_calls: { name: string }[] = [];
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'tool_use' && typeof part.name === 'string') {
          tool_calls.push({ name: part.name });
        }
      }
    }

    let tokens: Tokens | undefined;
    const u = obj.message?.usage;
    if (u) {
      const input = u.input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      const cache_read = u.cache_read_input_tokens ?? 0;
      const cache_creation = u.cache_creation_input_tokens ?? 0;
      tokens = { input, output, cache_read, cache_creation, total: input + output + cache_read + cache_creation };
    }

    const event: TurnEvent = { turn_index, timestamp, role, tool_calls };
    if (tokens) event.tokens = tokens;
    events.push(event);
  }
  return events;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- parseTranscript`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add analyzer/src/parseTranscript.ts analyzer/tests/parseTranscript.test.ts analyzer/tests/fixtures/happy/transcript.jsonl
git commit -m "feat(analyzer): parse Claude Code transcript jsonl into turn events"
```

---

### Task 6: `parseHookLog` — read benchmark hook events

**Files:**
- Create: `analyzer/src/parseHookLog.ts`
- Create: `analyzer/tests/parseHookLog.test.ts`
- Create: `analyzer/tests/fixtures/happy/hook.log`

- [ ] **Step 1: Write a fixture hook log**

Write `analyzer/tests/fixtures/happy/hook.log`:

```jsonl
{"t":"2026-06-04T10:00:01Z","kind":"phase.start","phase":"scaffold","turn_index":0}
{"t":"2026-06-04T10:00:30Z","kind":"phase.end","phase":"scaffold","turn_index":1,"gate_result":"pass"}
{"t":"2026-06-04T10:00:31Z","kind":"phase.start","phase":"groundwork","turn_index":2}
{"t":"2026-06-04T10:00:35Z","kind":"subagent.dispatch","parent_phase":"groundwork","subagent_type":"general-purpose","prompt_chars":1842}
```

- [ ] **Step 2: Write the failing test**

```ts
// analyzer/tests/parseHookLog.test.ts
import { describe, it, expect } from 'vitest';
import { parseHookLog } from '../src/parseHookLog.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('parseHookLog', () => {
  it('parses each line into a typed HookEvent', async () => {
    const events = await parseHookLog(join(here, 'fixtures/happy/hook.log'));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: 'phase.start', phase: 'scaffold', turn_index: 0 });
    expect(events[1]).toMatchObject({ kind: 'phase.end', gate_result: 'pass' });
    expect(events[3]).toMatchObject({ kind: 'subagent.dispatch', subagent_type: 'general-purpose' });
  });

  it('returns empty array when file is missing', async () => {
    expect(await parseHookLog('/nope/no.log')).toEqual([]);
  });

  it('skips malformed lines', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'hooklog-'));
    const f = join(dir, 'hook.log');
    await writeFile(f, '{"good":1}\nnot json\n{"t":"x","kind":"phase.start","phase":"scaffold","turn_index":0}\n');
    const out = await parseHookLog(f);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('phase.start');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- parseHookLog`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `parseHookLog`**

```ts
// analyzer/src/parseHookLog.ts
import { readFile } from 'node:fs/promises';
import type { HookEvent } from './types.js';

const KINDS = new Set(['phase.start', 'phase.end', 'subagent.dispatch']);

export async function parseHookLog(path: string): Promise<HookEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: HookEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj?.kind !== 'string' || !KINDS.has(obj.kind)) continue;
      out.push(obj as HookEvent);
    } catch {
      /* skip */
    }
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- parseHookLog`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add analyzer/src/parseHookLog.ts analyzer/tests/parseHookLog.test.ts analyzer/tests/fixtures/happy/hook.log
git commit -m "feat(analyzer): parse benchmark hook log jsonl"
```

---

### Task 7: `readSelfReport` & `readRetrospective`

**Files:**
- Create: `analyzer/src/readSelfReport.ts`
- Create: `analyzer/src/readRetrospective.ts`
- Create: `analyzer/tests/readSelfReport.test.ts`
- Create: `analyzer/tests/readRetrospective.test.ts`
- Create: `analyzer/tests/fixtures/happy/run-summary.json`
- Create: `analyzer/tests/fixtures/happy/retrospective.json`

- [ ] **Step 1: Write the fixture self-report**

```json
{
  "phases": [
    { "name": "scaffold", "gate_outcome": "pass", "retries": 0 },
    { "name": "groundwork", "gate_outcome": "pass", "retries": 0 },
    { "name": "happy-path", "gate_outcome": "pass", "retries": 1 },
    { "name": "journey-mapping", "gate_outcome": "pass", "retries": 0 },
    { "name": "coverage-expansion", "gate_outcome": "pass", "retries": 0 },
    { "name": "bug-discovery", "gate_outcome": "pass", "retries": 0 },
    { "name": "secrets-sweep", "gate_outcome": "pass", "retries": 0 },
    { "name": "report", "gate_outcome": "pass", "retries": 0 }
  ],
  "scenarios": { "files": ["tests/auth.spec.ts", "tests/checkout.spec.ts"] },
  "bugs": { "ids": ["BUG-001"], "by_severity": { "high": 0, "med": 1, "low": 0 } },
  "tests": { "passing": 12, "total": 12, "playwright_exit_code": 0 },
  "journey_map": { "pages": 9 }
}
```

Save at `analyzer/tests/fixtures/happy/run-summary.json`.

- [ ] **Step 2: Write the fixture retrospective**

```json
{
  "novel_observations": "Onboarding completed without retries except on happy-path.",
  "difficulties": "Modal cookie banner intercepted clicks during scaffold.",
  "would_do_differently": "Pre-dismiss cookie banner in groundwork.",
  "per_phase_impact": [
    { "phase": "scaffold", "impact": "Smooth — no surprises." },
    { "phase": "happy-path", "impact": "One retry for cookie banner." }
  ]
}
```

Save at `analyzer/tests/fixtures/happy/retrospective.json`.

- [ ] **Step 3: Write failing tests**

```ts
// analyzer/tests/readSelfReport.test.ts
import { describe, it, expect } from 'vitest';
import { readSelfReport } from '../src/readSelfReport.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

describe('readSelfReport', () => {
  it('reads and returns a parsed SelfReport', async () => {
    const sr = await readSelfReport(join(here, 'fixtures/happy/run-summary.json'));
    expect(sr?.phases).toHaveLength(8);
    expect(sr?.scenarios.files).toContain('tests/auth.spec.ts');
    expect(sr?.bugs.by_severity.med).toBe(1);
  });
  it('returns null when file is missing', async () => {
    expect(await readSelfReport('/nope.json')).toBeNull();
  });
});
```

```ts
// analyzer/tests/readRetrospective.test.ts
import { describe, it, expect } from 'vitest';
import { readRetrospective } from '../src/readRetrospective.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

describe('readRetrospective', () => {
  it('reads a retrospective json', async () => {
    const r = await readRetrospective(join(here, 'fixtures/happy/retrospective.json'));
    expect(r?.novel_observations).toMatch(/onboarding/i);
    expect(r?.per_phase_impact).toHaveLength(2);
  });
  it('returns null when file is missing', async () => {
    expect(await readRetrospective('/nope.json')).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -- readSelfReport readRetrospective`
Expected: FAIL (modules not found).

- [ ] **Step 5: Implement the readers**

```ts
// analyzer/src/readSelfReport.ts
import { readFile } from 'node:fs/promises';
import type { SelfReport } from './types.js';

export async function readSelfReport(path: string): Promise<SelfReport | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SelfReport;
  } catch {
    return null;
  }
}
```

```ts
// analyzer/src/readRetrospective.ts
import { readFile } from 'node:fs/promises';
import type { Retrospective } from './types.js';

export async function readRetrospective(path: string): Promise<Retrospective | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Retrospective;
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- readSelfReport readRetrospective`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add analyzer/src/readSelfReport.ts analyzer/src/readRetrospective.ts analyzer/tests/readSelfReport.test.ts analyzer/tests/readRetrospective.test.ts analyzer/tests/fixtures/happy/run-summary.json analyzer/tests/fixtures/happy/retrospective.json
git commit -m "feat(analyzer): add SelfReport and Retrospective readers"
```

---

### Task 8: `assemble` — join sources into `Results`

**Files:**
- Create: `analyzer/src/assemble.ts`
- Create: `analyzer/tests/assemble.test.ts`
- Create: `analyzer/tests/fixtures/happy/expected-results.json`

- [ ] **Step 1: Write `assemble.ts`**

```ts
// analyzer/src/assemble.ts
import type { AssembleInputs, Results, Tokens, PhaseName, HookEvent, TurnEvent } from './types.js';

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
  return { start, end };
}

function secondsBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
}

export function assemble(inputs: AssembleInputs): Results {
  const { turns, hookEvents, selfReport, retrospective, meta } = inputs;
  const discrepancies: Results['discrepancies'] = [];

  // run timing
  const started_at = turns[0]?.timestamp ?? new Date(0).toISOString();
  const ended_at = turns[turns.length - 1]?.timestamp ?? started_at;
  const duration_sec = secondsBetween(started_at, ended_at);

  // build phase ranges keyed by phase
  const phaseRanges = PHASE_ORDER.map((name) => {
    const { start, end } = phaseRange(hookEvents, name);
    return { name, start, end };
  });

  // bucket turns into phases by turn_index between start and end
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
    return {
      name,
      started_at: start?.t ?? started_at,
      ended_at: end?.t ?? ended_at,
      duration_sec: start && end ? secondsBetween(start.t, end.t) : 0,
      turns: nTurns,
      tokens,
      tool_calls_by_name,
      subagent_dispatches,
      gate_outcome: (end && end.kind === 'phase.end' ? end.gate_result : sr_phase?.gate_outcome) ?? 'pass',
      retries: sr_phase?.retries ?? 0,
    };
  });

  // totals
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

  // outcomes from self-report (or zeroed if missing — recorded as discrepancy)
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
```

- [ ] **Step 2: Write the expected golden output**

This is the expected `Results` for the happy fixture, given the small 3-turn transcript + hook log + self-report + retrospective written so far. Save at `analyzer/tests/fixtures/happy/expected-results.json`.

```json
{
  "schema_version": "1.0.0",
  "run": {
    "id": "2026-06-04T10:00:00Z-abc1234",
    "started_at": "2026-06-04T10:00:00Z",
    "ended_at": "2026-06-04T10:00:20Z",
    "duration_sec": 20,
    "mode": "local",
    "truncated": false,
    "achilles_version": "0.1.0",
    "achilles_commit": "abc1234567",
    "claude_code_version": "1.0.0",
    "host": { "runner_os": "darwin", "cpu_count": 8, "mem_gb": 16 }
  },
  "totals": {
    "tokens": { "input": 120, "output": 40, "cache_read": 0, "cache_creation": 50, "total": 210 },
    "turns": 2,
    "tool_calls": 1,
    "subagent_dispatches": 0,
    "gate_failures": 0,
    "retries": 1
  },
  "phases": [
    {
      "name": "scaffold",
      "started_at": "2026-06-04T10:00:01Z",
      "ended_at": "2026-06-04T10:00:30Z",
      "duration_sec": 29,
      "turns": 2,
      "tokens": { "input": 120, "output": 40, "cache_read": 0, "cache_creation": 50, "total": 210 },
      "tool_calls_by_name": { "Bash": 1 },
      "subagent_dispatches": [],
      "gate_outcome": "pass",
      "retries": 0
    },
    { "name": "groundwork", "started_at": "2026-06-04T10:00:31Z", "ended_at": "2026-06-04T10:00:20Z", "duration_sec": 0, "turns": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "tool_calls_by_name": {}, "subagent_dispatches": [{ "subagent_type": "general-purpose", "duration_sec": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "returned_ok": true }], "gate_outcome": "pass", "retries": 0 },
    { "name": "happy-path", "started_at": "2026-06-04T10:00:00Z", "ended_at": "2026-06-04T10:00:20Z", "duration_sec": 0, "turns": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "tool_calls_by_name": {}, "subagent_dispatches": [], "gate_outcome": "pass", "retries": 1 },
    { "name": "journey-mapping", "started_at": "2026-06-04T10:00:00Z", "ended_at": "2026-06-04T10:00:20Z", "duration_sec": 0, "turns": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "tool_calls_by_name": {}, "subagent_dispatches": [], "gate_outcome": "pass", "retries": 0 },
    { "name": "coverage-expansion", "started_at": "2026-06-04T10:00:00Z", "ended_at": "2026-06-04T10:00:20Z", "duration_sec": 0, "turns": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "tool_calls_by_name": {}, "subagent_dispatches": [], "gate_outcome": "pass", "retries": 0 },
    { "name": "bug-discovery", "started_at": "2026-06-04T10:00:00Z", "ended_at": "2026-06-04T10:00:20Z", "duration_sec": 0, "turns": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "tool_calls_by_name": {}, "subagent_dispatches": [], "gate_outcome": "pass", "retries": 0 },
    { "name": "secrets-sweep", "started_at": "2026-06-04T10:00:00Z", "ended_at": "2026-06-04T10:00:20Z", "duration_sec": 0, "turns": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "tool_calls_by_name": {}, "subagent_dispatches": [], "gate_outcome": "pass", "retries": 0 },
    { "name": "report", "started_at": "2026-06-04T10:00:00Z", "ended_at": "2026-06-04T10:00:20Z", "duration_sec": 0, "turns": 0, "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0 }, "tool_calls_by_name": {}, "subagent_dispatches": [], "gate_outcome": "pass", "retries": 0 }
  ],
  "outcomes": {
    "scenarios_written": { "count": 2, "files": ["tests/auth.spec.ts", "tests/checkout.spec.ts"] },
    "bugs_filed": { "count": 1, "by_severity": { "high": 0, "med": 1, "low": 0 }, "ids": ["BUG-001"] },
    "tests_passing": { "count": 12, "total": 12, "ratio": 1.0 },
    "playwright_exit_code": 0,
    "journey_map_pages": 9
  },
  "retrospective": {
    "novel_observations": "Onboarding completed without retries except on happy-path.",
    "difficulties": "Modal cookie banner intercepted clicks during scaffold.",
    "would_do_differently": "Pre-dismiss cookie banner in groundwork.",
    "per_phase_impact": [
      { "phase": "scaffold", "impact": "Smooth — no surprises." },
      { "phase": "happy-path", "impact": "One retry for cookie banner." }
    ]
  },
  "discrepancies": [],
  "baseline_comparison": {
    "baseline_id": null,
    "deltas": {},
    "regression_verdict": "pass",
    "regression_thresholds": { "tokens_total_pct": 25, "duration_pct": 50, "tests_ratio_drop": 0.1 }
  }
}
```

- [ ] **Step 3: Write the failing test**

```ts
// analyzer/tests/assemble.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTranscript } from '../src/parseTranscript.js';
import { parseHookLog } from '../src/parseHookLog.js';
import { readSelfReport } from '../src/readSelfReport.js';
import { readRetrospective } from '../src/readRetrospective.js';
import { assemble } from '../src/assemble.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures/happy', name);

describe('assemble', () => {
  it('produces the expected results for the happy fixture', async () => {
    const turns = await parseTranscript(fixture('transcript.jsonl'));
    const hookEvents = await parseHookLog(fixture('hook.log'));
    const selfReport = await readSelfReport(fixture('run-summary.json'));
    const retrospective = await readRetrospective(fixture('retrospective.json'));

    const result = assemble({
      turns,
      hookEvents,
      selfReport,
      retrospective,
      meta: {
        achilles_version: '0.1.0',
        achilles_commit: 'abc1234567',
        claude_code_version: '1.0.0',
        mode: 'local',
        host: { runner_os: 'darwin', cpu_count: 8, mem_gb: 16 },
      },
    });
    const expected = JSON.parse(await readFile(fixture('expected-results.json'), 'utf8'));
    expect(result).toEqual(expected);
  });

  it('records a discrepancy when self-report is missing', async () => {
    const turns = await parseTranscript(fixture('transcript.jsonl'));
    const hookEvents = await parseHookLog(fixture('hook.log'));
    const result = assemble({
      turns,
      hookEvents,
      selfReport: null,
      retrospective: null,
      meta: {
        achilles_version: '0.1.0',
        achilles_commit: 'abc1234567',
        claude_code_version: '1.0.0',
        mode: 'local',
        host: { runner_os: 'darwin', cpu_count: 8, mem_gb: 16 },
      },
    });
    expect(result.discrepancies.some((d) => d.kind === 'self_report_missing')).toBe(true);
    expect(result.discrepancies.some((d) => d.kind === 'retrospective_missing')).toBe(true);
  });
});
```

- [ ] **Step 4: Run test**

Run: `npm test -- assemble`
Expected: PASS (2 tests). If the golden file does not match the assembler's actual output, run the test once to see the diff, update the golden file to match the assembler's correct output (do not paper over real bugs — only adjust expected when the assembler is correct), and rerun.

- [ ] **Step 5: Commit**

```bash
git add analyzer/src/assemble.ts analyzer/tests/assemble.test.ts analyzer/tests/fixtures/happy/expected-results.json
git commit -m "feat(analyzer): assemble turns + hooks + self-report into Results"
```

---

### Task 9: `validate` — ajv schema validators

**Files:**
- Create: `analyzer/src/validate.ts`
- Create: `analyzer/tests/validate.test.ts`

- [ ] **Step 1: Write `validate.ts`**

```ts
// analyzer/src/validate.ts
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(here, '../../schema');

let ajv: Ajv2020 | null = null;

async function getAjv(): Promise<Ajv2020> {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const results = JSON.parse(await readFile(join(SCHEMA_DIR, 'results.schema.json'), 'utf8'));
  const runSummary = JSON.parse(await readFile(join(SCHEMA_DIR, 'run-summary.schema.json'), 'utf8'));
  ajv.addSchema(results, 'results');
  ajv.addSchema(runSummary, 'run-summary');
  return ajv;
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export async function validateResults(data: unknown): Promise<ValidationResult> {
  const a = await getAjv();
  const validate = a.getSchema('results');
  if (!validate) return { ok: false, errors: ['results schema not loaded'] };
  return validate(data)
    ? { ok: true }
    : { ok: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`) };
}

export async function validateRunSummary(data: unknown): Promise<ValidationResult> {
  const a = await getAjv();
  const validate = a.getSchema('run-summary');
  if (!validate) return { ok: false, errors: ['run-summary schema not loaded'] };
  return validate(data)
    ? { ok: true }
    : { ok: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`) };
}
```

- [ ] **Step 2: Write tests**

```ts
// analyzer/tests/validate.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateResults, validateRunSummary } from '../src/validate.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('validateResults', () => {
  it('accepts the happy expected output', async () => {
    const data = JSON.parse(await readFile(join(here, 'fixtures/happy/expected-results.json'), 'utf8'));
    expect(await validateResults(data)).toEqual({ ok: true });
  });
  it('rejects when schema_version is wrong', async () => {
    const r = await validateResults({ schema_version: '0.0.0' });
    expect(r.ok).toBe(false);
  });
});

describe('validateRunSummary', () => {
  it('accepts the happy fixture self-report', async () => {
    const data = JSON.parse(await readFile(join(here, 'fixtures/happy/run-summary.json'), 'utf8'));
    expect(await validateRunSummary(data)).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- validate`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add analyzer/src/validate.ts analyzer/tests/validate.test.ts
git commit -m "feat(analyzer): add ajv-backed results and run-summary validators"
```

---

### Task 10: `compare` — baseline diff + regression verdict

**Files:**
- Create: `analyzer/src/compare.ts`
- Create: `analyzer/tests/compare.test.ts`
- Create: `baseline/baseline.json`
- Create: `results/.gitkeep`

- [ ] **Step 1: Write `compare.ts`**

```ts
// analyzer/src/compare.ts
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
  return Math.round(((current - baseline) / baseline) * 10000) / 100; // 2dp
}

export function compare(current: Results, baseline: Baseline | null): Results {
  if (!baseline) {
    return {
      ...current,
      baseline_comparison: { ...current.baseline_comparison, baseline_id: null },
    };
  }

  const t = current.regression_thresholds_override ?? current.baseline_comparison.regression_thresholds;
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

declare module './types.js' {
  interface Results {
    regression_thresholds_override?: Results['baseline_comparison']['regression_thresholds'];
  }
}
```

(The augmentation at the bottom adds an optional override field; we never set it in normal code, but keeping it typed makes future per-PR overrides explicit. If you'd prefer to keep this strictly off until needed, delete the `declare module` block and the corresponding line in `compare`.)

- [ ] **Step 2: Write a tiny baseline fixture**

`baseline/baseline.json`:

```json
{
  "id": "2026-05-30T00:00:00Z-main",
  "totals": { "tokens": { "total": 200 } },
  "run": { "duration_sec": 20 },
  "outcomes": { "tests_passing": { "ratio": 1.0 } }
}
```

`results/.gitkeep`: empty file (so the directory exists in git).

- [ ] **Step 3: Write tests**

```ts
// analyzer/tests/compare.test.ts
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
    current.outcomes.tests_passing.ratio = 0.5;   // -0.5 from baseline 1.0
    const baseline = await readBaseline(join(here, '../../baseline/baseline.json'));
    const out = compare(current, baseline);
    expect(out.baseline_comparison.regression_verdict).toBe('fail');
  });

  it('verdict = warn when token delta exceeds threshold', async () => {
    const current = await happyResult();
    current.totals.tokens.total = 500;            // +150% vs baseline 200 → > 25
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
```

- [ ] **Step 4: Run tests**

Run: `npm test -- compare`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add analyzer/src/compare.ts analyzer/tests/compare.test.ts baseline/baseline.json results/.gitkeep
git commit -m "feat(analyzer): add baseline comparator and regression verdict"
```

---

### Task 11: CLI — `bookhive-benchmark analyze`

**Files:**
- Create: `analyzer/src/cli.ts`
- Create: `analyzer/tests/cli.test.ts`

- [ ] **Step 1: Write `cli.ts`**

```ts
#!/usr/bin/env -S npx tsx
// analyzer/src/cli.ts
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseTranscript } from './parseTranscript.js';
import { parseHookLog } from './parseHookLog.js';
import { readSelfReport } from './readSelfReport.js';
import { readRetrospective } from './readRetrospective.js';
import { assemble } from './assemble.js';
import { compare, readBaseline } from './compare.js';
import { validateResults } from './validate.js';
import type { AssembleInputs } from './types.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

async function readMetaJson(path: string | undefined): Promise<AssembleInputs['meta']> {
  if (path) {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as AssembleInputs['meta'];
  }
  return {
    achilles_version: envOr('ACHILLES_VERSION', 'unknown'),
    achilles_commit: envOr('ACHILLES_COMMIT', 'unknown'),
    claude_code_version: envOr('CLAUDE_CODE_VERSION', 'unknown'),
    mode: (envOr('BENCHMARK_MODE', 'local') as 'local' | 'ci'),
    host: {
      runner_os: process.platform,
      cpu_count: (await import('node:os')).cpus().length,
      mem_gb: Math.round((await import('node:os')).totalmem() / (1024 ** 3)),
    },
  };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== 'analyze') {
    console.error('usage: bookhive-benchmark analyze --transcript <path> --hooks <path> --self-report <path> --retro <path> [--baseline <path>] [--out <path>] [--meta <path>]');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(3));
  const transcript = args.transcript;
  if (!transcript) { console.error('--transcript is required'); process.exit(2); }
  const hookLog = args.hooks ?? '/dev/null';
  const selfReportPath = args['self-report'] ?? '/dev/null';
  const retroPath = args.retro ?? '/dev/null';
  const baselinePath = args.baseline;
  const outPath = resolve(args.out ?? `results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const metaPath = args.meta;

  const [turns, hookEvents, selfReport, retrospective, baseline, meta] = await Promise.all([
    parseTranscript(transcript),
    parseHookLog(hookLog),
    readSelfReport(selfReportPath),
    readRetrospective(retroPath),
    baselinePath ? readBaseline(baselinePath) : Promise.resolve(null),
    readMetaJson(metaPath),
  ]);

  const assembled = assemble({ turns, hookEvents, selfReport, retrospective, meta });
  const final = compare(assembled, baseline);

  const v = await validateResults(final);
  if (!v.ok) {
    console.error('results failed schema validation:');
    for (const e of v.errors) console.error('  -', e);
    process.exit(3);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(final, null, 2) + '\n', 'utf8');
  console.log(outPath);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
```

- [ ] **Step 2: Make CLI executable**

Run: `chmod +x analyzer/src/cli.ts`
Expected: no output.

- [ ] **Step 3: Write a smoke test that runs the CLI**

```ts
// analyzer/tests/cli.test.ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

describe('cli analyze', () => {
  it('produces a schema-valid results.json for the happy fixture', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bhb-'));
    const out = join(outDir, 'results.json');
    await exec('npx', [
      'tsx', 'analyzer/src/cli.ts', 'analyze',
      '--transcript', 'analyzer/tests/fixtures/happy/transcript.jsonl',
      '--hooks', 'analyzer/tests/fixtures/happy/hook.log',
      '--self-report', 'analyzer/tests/fixtures/happy/run-summary.json',
      '--retro', 'analyzer/tests/fixtures/happy/retrospective.json',
      '--baseline', 'baseline/baseline.json',
      '--out', out,
    ], { cwd: repoRoot });

    const data = JSON.parse(await readFile(out, 'utf8'));
    expect(data.schema_version).toBe('1.0.0');
    expect(data.baseline_comparison.regression_verdict).toBe('pass');
  }, 30_000);
});
```

- [ ] **Step 4: Run the CLI test**

Run: `npm test -- cli`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add analyzer/src/cli.ts analyzer/tests/cli.test.ts
git commit -m "feat(analyzer): add bookhive-benchmark analyze CLI"
```

---

### Task 12: Cross-check discrepancy — on-disk vs self-report

**Files:**
- Modify: `analyzer/src/assemble.ts:1` (top-level — add a new exported function)
- Modify: `analyzer/src/cli.ts:1` (top-level — call it before validate)
- Create: `analyzer/tests/fixtures/scenario-count-mismatch/` (full fixture set)
- Modify: `analyzer/tests/assemble.test.ts:1` (add a case)

- [ ] **Step 1: Add `crossCheckOnDisk` to `assemble.ts`**

Append to `analyzer/src/assemble.ts`:

```ts
import { access, readdir } from 'node:fs/promises';

export async function crossCheckOnDisk(result: Results, projectDir: string): Promise<Results> {
  const discrepancies = [...result.discrepancies];

  // Count actual scenario files on disk under projectDir/tests/
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
    /* tests/ may not exist; that's already captured elsewhere */
  }

  return { ...result, discrepancies };
}
```

- [ ] **Step 2: Write a scenario-mismatch fixture set**

Reuse the happy fixtures for transcript/hook log/retrospective; only the self-report changes (claim 3 scenarios). At `analyzer/tests/fixtures/scenario-count-mismatch/`:

`run-summary.json`:

```json
{
  "phases": [
    { "name": "scaffold", "gate_outcome": "pass", "retries": 0 },
    { "name": "groundwork", "gate_outcome": "pass", "retries": 0 },
    { "name": "happy-path", "gate_outcome": "pass", "retries": 0 },
    { "name": "journey-mapping", "gate_outcome": "pass", "retries": 0 },
    { "name": "coverage-expansion", "gate_outcome": "pass", "retries": 0 },
    { "name": "bug-discovery", "gate_outcome": "pass", "retries": 0 },
    { "name": "secrets-sweep", "gate_outcome": "pass", "retries": 0 },
    { "name": "report", "gate_outcome": "pass", "retries": 0 }
  ],
  "scenarios": { "files": ["tests/a.spec.ts", "tests/b.spec.ts", "tests/c.spec.ts"] },
  "bugs": { "ids": [], "by_severity": { "high": 0, "med": 0, "low": 0 } },
  "tests": { "passing": 0, "total": 0, "playwright_exit_code": 0 },
  "journey_map": { "pages": 0 }
}
```

`tests/a.spec.ts`: an empty file.
`tests/b.spec.ts`: an empty file.

(Two files on disk, but self-report claims three → mismatch.)

- [ ] **Step 3: Add cross-check test**

Append to `analyzer/tests/assemble.test.ts`:

```ts
describe('crossCheckOnDisk', () => {
  it('records scenario_count_mismatch when on-disk files differ from self-report count', async () => {
    const { crossCheckOnDisk, assemble } = await import('../src/assemble.js');
    const turns = await parseTranscript(fixture('transcript.jsonl'));
    const hookEvents = await parseHookLog(fixture('hook.log'));
    const selfReport = await readSelfReport(join(here, 'fixtures/scenario-count-mismatch/run-summary.json'));
    const result = assemble({
      turns, hookEvents, selfReport, retrospective: null,
      meta: {
        achilles_version: '0.1.0', achilles_commit: 'abc1234567',
        claude_code_version: '1.0.0', mode: 'local',
        host: { runner_os: 'darwin', cpu_count: 8, mem_gb: 16 },
      },
    });
    const checked = await crossCheckOnDisk(result, join(here, 'fixtures/scenario-count-mismatch'));
    expect(checked.discrepancies.some((d) => d.kind === 'scenario_count_mismatch')).toBe(true);
  });
});
```

- [ ] **Step 4: Wire cross-check into the CLI**

In `analyzer/src/cli.ts`, replace the assemble/compare block with one that also cross-checks. Add a `--project-dir` argument:

Find:
```ts
  const assembled = assemble({ turns, hookEvents, selfReport, retrospective, meta });
  const final = compare(assembled, baseline);
```

Replace with:
```ts
  const assembled = assemble({ turns, hookEvents, selfReport, retrospective, meta });
  const projectDir = args['project-dir'];
  const { crossCheckOnDisk } = await import('./assemble.js');
  const checked = projectDir ? await crossCheckOnDisk(assembled, projectDir) : assembled;
  const final = compare(checked, baseline);
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all green (existing tests still pass; the new cross-check test passes).

- [ ] **Step 6: Commit**

```bash
git add analyzer/src/assemble.ts analyzer/src/cli.ts analyzer/tests/assemble.test.ts analyzer/tests/fixtures/scenario-count-mismatch/
git commit -m "feat(analyzer): add on-disk cross-check for scenario count"
```

---

### Task 13: Final pass — typecheck + full test run + tag

**Files:** none

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 3: Tag the milestone**

```bash
git tag -a plan-1-complete -m "Plan 1 — Foundation + Schemas + Analyzer complete"
```

(No push — staying local until repo goes public.)

---

## Self-review

**Spec coverage check** — Plan 1 covers:
- ✅ Spec §3 (architecture/file structure for `analyzer/`, `schema/`, `baseline/`, top-level configs)
- ✅ Spec §4 (telemetry: transcript, hook log, self-report — all three parsers + assembler)
- ✅ Spec §5 (`results.json` canonical schema)
- ✅ Spec §10 (testing strategy: analyzer unit tests with golden fixtures)
- ✅ Cross-check / discrepancy detection (§4 final paragraph)
- ⛔ Deferred to Plan 2: `restart.sh`, hooks, docker-compose, cleanup script (§3 `driver/`, `hooks/`, `scripts/`)
- ⛔ Deferred to Plan 3: CI workflow, achilles-side PR, public README/PROCESS

**Type consistency check** — `TurnEvent`, `HookEvent`, `Tokens`, `Results`, `AssembleInputs` are used consistently across Tasks 5–12. `PhaseName` enum is single source of truth in `types.ts` and identical in both schemas. `parseTranscript`/`parseHookLog`/`readSelfReport`/`readRetrospective` return types match `AssembleInputs` field types exactly.

**Placeholder scan** — clean. No TBD/TODO/"similar to". Every code step shows the actual code.
