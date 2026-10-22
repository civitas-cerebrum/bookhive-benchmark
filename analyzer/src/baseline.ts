import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Results } from './types.js';

export type Source = 'results.json' | 'reconstructed-from-ledger' | 'reconstructed-from-deck';

export type SeverityCounts = {
  critical: number | null;
  high: number | null;
  medium: number | null;
  low: number | null;
};

/**
 * One run, normalised. This is the shape of a line in baseline/history.jsonl
 * and of baseline/baseline.json (the active baseline is a copy of one record).
 * Unknown metrics are null, never guessed; metric_sources explains each null
 * (and any approximation).
 */
export type HistoryRecord = {
  id: string;
  date: string;
  achilles_version: string | null;
  achilles_commit: string | null;
  source: Source;
  outcomes: {
    bugs_by_severity: SeverityCounts;
    bugs_total: number | null;
    tests_total: number | null;
    tests_passing_ratio: number | null;
    scenarios: number | null;
    journeys: number | null;
    phases_completed: number | null;
  };
  process?: {
    duration_sec: number | null;
    tokens_total: number | null;
    commit_span_sec?: number | null;
  };
  metric_sources?: Record<string, string>;
  /** Set only when the analyzer flagged the run as truncated. */
  truncated?: boolean;
  notes: string;
};

export const TOTAL_PHASES = 8;

const SOURCES: Source[] = ['results.json', 'reconstructed-from-ledger', 'reconstructed-from-deck'];

const nullOrNum = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

/** Returns a list of problems; empty means the record is well formed. */
export function validateRecord(r: unknown): string[] {
  const errs: string[] = [];
  const o = r as HistoryRecord;
  if (!o || typeof o !== 'object') return ['not an object'];
  if (typeof o.id !== 'string' || !o.id) errs.push('id missing');
  if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(o.date)) errs.push('date must be YYYY-MM-DD...');
  if (!SOURCES.includes(o.source)) errs.push(`source must be one of ${SOURCES.join(' | ')}`);
  if (!(o.achilles_version === null || typeof o.achilles_version === 'string')) errs.push('achilles_version must be string|null');
  if (!(o.achilles_commit === null || typeof o.achilles_commit === 'string')) errs.push('achilles_commit must be string|null');
  if (typeof o.notes !== 'string') errs.push('notes must be a string');
  const oc = o.outcomes;
  if (!oc || typeof oc !== 'object') {
    errs.push('outcomes missing');
    return errs;
  }
  for (const k of ['bugs_total', 'tests_total', 'tests_passing_ratio', 'scenarios', 'journeys', 'phases_completed'] as const) {
    if (!nullOrNum(oc[k])) errs.push(`outcomes.${k} must be number|null`);
  }
  const sev = oc.bugs_by_severity;
  if (!sev || typeof sev !== 'object') errs.push('outcomes.bugs_by_severity missing');
  else for (const k of ['critical', 'high', 'medium', 'low'] as const) {
    if (!nullOrNum(sev[k])) errs.push(`outcomes.bugs_by_severity.${k} must be number|null`);
  }
  if (o.process !== undefined) {
    if (!nullOrNum(o.process.duration_sec)) errs.push('process.duration_sec must be number|null');
    if (!nullOrNum(o.process.tokens_total)) errs.push('process.tokens_total must be number|null');
  }
  return errs;
}

/** Why a run must not become the active baseline (empty = fine). */
export function incompleteReasons(r: HistoryRecord): string[] {
  const why: string[] = [];
  const oc = r.outcomes;
  if (oc.phases_completed === null) why.push('phases_completed unknown');
  else if (oc.phases_completed < TOTAL_PHASES) why.push(`only ${oc.phases_completed}/${TOTAL_PHASES} phases completed`);
  if (!oc.tests_total) why.push('no tests recorded');
  if (oc.tests_passing_ratio === null) why.push('tests_passing_ratio unknown');
  if (oc.bugs_total === null) why.push('bugs_total unknown');
  if (r.truncated) why.push('run was truncated');
  return why;
}

export type RecordOptions = { notes?: string };

/** Normalise an analyzer results.json into a history record. */
export function fromResults(res: Results, opts: RecordOptions = {}): HistoryRecord {
  const sev = res.outcomes.bugs_filed.by_severity;
  const unknown = (v: string) => (!v || v === 'unknown' ? null : v);
  const phasesPassed = res.phases.filter((p) => p.gate_outcome === 'pass').length;
  const sources: Record<string, string> = {
    journeys: 'results.json carries journey_map_pages, not a journey count',
  };
  if (sev.critical === undefined) sources['bugs_by_severity.critical'] = 'run-summary did not report a critical bucket';
  const rec: HistoryRecord = {
    id: res.run.id,
    date: res.run.started_at.slice(0, 10),
    achilles_version: unknown(res.run.achilles_version),
    achilles_commit: unknown(res.run.achilles_commit),
    source: 'results.json',
    outcomes: {
      bugs_by_severity: {
        critical: sev.critical ?? null,
        high: sev.high,
        medium: sev.med,
        low: sev.low,
      },
      bugs_total: res.outcomes.bugs_filed.count,
      tests_total: res.outcomes.tests_passing.total,
      tests_passing_ratio: res.outcomes.tests_passing.ratio,
      scenarios: res.outcomes.scenarios_written.count,
      journeys: null,
      phases_completed: phasesPassed,
    },
    process: {
      duration_sec: res.run.duration_sec,
      tokens_total: res.totals.tokens.total,
    },
    metric_sources: sources,
    notes: opts.notes ?? '',
  };
  if (res.run.truncated) rec.truncated = true;
  return rec;
}

export function readJsonl(text: string): HistoryRecord[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l) as HistoryRecord;
      } catch {
        throw new Error(`history line ${i + 1} is not valid JSON`);
      }
    });
}

export async function readHistory(path: string): Promise<HistoryRecord[]> {
  try {
    return readJsonl(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Append-only. Returns false (and writes nothing) when the id is already present. */
export async function appendHistory(path: string, rec: HistoryRecord): Promise<boolean> {
  const errs = validateRecord(rec);
  if (errs.length) throw new Error(`invalid record: ${errs.join('; ')}`);
  const existing = await readHistory(path);
  if (existing.some((r) => r.id === rec.id)) return false;
  await mkdir(dirname(path), { recursive: true });
  let prefix = '';
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > 0 && !raw.endsWith('\n')) prefix = '\n';
  } catch { /* new file */ }
  await appendFile(path, prefix + JSON.stringify(rec) + '\n', 'utf8');
  return true;
}

export async function readPendingNotes(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function consumePendingNotes(path: string): Promise<void> {
  try {
    await readFile(path, 'utf8');
    await writeFile(path, '', 'utf8');
  } catch { /* nothing to consume */ }
}

export function findRecord(history: HistoryRecord[], needle: string): HistoryRecord {
  const exact = history.find((r) => r.id === needle);
  if (exact) return exact;
  const hits = history.filter((r) => r.id.includes(needle));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new Error(`no history entry matches "${needle}"`);
  throw new Error(`"${needle}" is ambiguous: ${hits.map((h) => h.id).join(', ')}`);
}

export function formatTable(history: HistoryRecord[], activeId: string | null): string {
  const cell = (v: number | null | undefined) => (v === null || v === undefined ? '-' : String(v));
  const rows = history.map((r) => {
    const s = r.outcomes.bugs_by_severity;
    return [
      r.id === activeId ? '*' : ' ',
      r.id,
      r.date,
      r.achilles_version ?? '-',
      r.source.replace('reconstructed-from-', 'recon:'),
      `${cell(s.critical)}/${cell(s.high)}/${cell(s.medium)}/${cell(s.low)}`,
      cell(r.outcomes.bugs_total),
      cell(r.outcomes.tests_total),
      r.outcomes.tests_passing_ratio === null ? '-' : r.outcomes.tests_passing_ratio.toFixed(2),
      cell(r.outcomes.journeys),
      cell(r.outcomes.phases_completed),
    ];
  });
  const head = ['', 'id', 'date', 'achilles', 'source', 'bugs c/h/m/l', 'bugs', 'tests', 'pass', 'journeys', 'phases'];
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(head), ...rows.map(line), '', '* = active baseline (baseline/baseline.json)'].join('\n');
}
