import { readFile } from 'node:fs/promises';
import type { PhaseName, SelfReport, SeverityCountsOut } from './types.js';

const PHASES: PhaseName[] = ['scaffold', 'groundwork', 'happy-path', 'journey-mapping', 'coverage-expansion', 'bug-discovery', 'secrets-sweep', 'report'];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * Severity keys: the 1.x self-report uses high/med/low (+critical); Achilles
 * 0.2.0 uses critical/high/medium/low (+info). Both `medium` and `med` are
 * accepted and mapped to `med`. Missing buckets are 0 (high/med/low are
 * required by the results schema); critical and info are kept only if reported.
 */
export function normalizeSeverity(raw: Record<string, unknown> | undefined | null): SeverityCountsOut {
  const r = raw ?? {};
  const n = (v: unknown) => num(v) ?? 0;
  const out: SeverityCountsOut = {
    high: n(r.high),
    med: n(r.medium ?? r.med),
    low: n(r.low),
  };
  if (r.critical !== undefined) out.critical = n(r.critical);
  if (r.info !== undefined) out.info = n(r.info);
  return out;
}

function phaseName(raw: unknown): PhaseName | null {
  const n = String(raw ?? '').toLowerCase().replace(/[\s_]+/g, '-');
  return (PHASES as string[]).includes(n) ? (n as PhaseName) : null;
}

function normalizePhases(raw: unknown): SelfReport['phases'] {
  if (!Array.isArray(raw)) return [];
  const out: SelfReport['phases'] = [];
  for (const p of raw as Array<Record<string, any>>) {
    const name = phaseName(p?.name);
    if (!name) continue;
    // 1.x: { gate_outcome, retries }. 0.2.0 ledger: { status: 'completed', reviewerVerdict, reviewerCycles, startedAt, finishedAt }.
    const gate: 'pass' | 'fail' =
      p.gate_outcome === 'pass' || p.gate_outcome === 'fail'
        ? p.gate_outcome
        : p.status === 'completed' || p.reviewerVerdict === 'approved' ? 'pass' : 'fail';
    const retries = int(p.retries) ?? Math.max(0, (int(p.reviewerCycles) ?? 1) - 1);
    const ph: SelfReport['phases'][number] = { name, gate_outcome: gate, retries };
    if (typeof p.startedAt === 'string') ph.started_at = p.startedAt;
    if (typeof p.finishedAt === 'string') ph.ended_at = p.finishedAt;
    out.push(ph);
  }
  return out;
}

export function normalizeSelfReport(raw: any): SelfReport {
  const t = raw?.tests ?? {};
  const jm = raw?.journey_map ?? {};
  return {
    phases: normalizePhases(raw?.phases),
    scenarios: { files: Array.isArray(raw?.scenarios?.files) ? raw.scenarios.files : [] },
    bugs: {
      ids: Array.isArray(raw?.bugs?.ids) ? raw.bugs.ids : [],
      by_severity: normalizeSeverity(raw?.bugs?.by_severity),
    },
    tests: {
      passing: int(t.passing),
      total: int(t.total),
      playwright_exit_code: int(t.playwright_exit_code),
    },
    journey_map: { pages: int(jm.pages), journeys: int(jm.journeys) },
  };
}

export async function readSelfReport(path: string): Promise<SelfReport | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return normalizeSelfReport(JSON.parse(raw));
  } catch {
    return null;
  }
}
