import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  appendHistory, consumePendingNotes, findRecord, formatTable, fromResults, incompleteReasons,
  readHistory, readPendingNotes, validateRecord, type HistoryRecord,
} from './baseline.js';
import { readBaseline } from './compare.js';
import { validateResults } from './validate.js';
import type { Results } from './types.js';

const USAGE = `usage:
  baseline record <results.json> [--notes <text>]   append the run to history.jsonl (never promotes)
  baseline promote <results.json|id> [--force]      make a run the active baseline
  baseline show                                     table of the history
env: BASELINE_DIR (default ./baseline)`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (a === '--force') flags.force = 'true';
      else if (next !== undefined) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = 'true';
    } else pos.push(a);
  }
  return { pos, flags };
}

async function loadResults(path: string): Promise<Results> {
  const data = JSON.parse(await readFile(path, 'utf8'));
  const v = await validateResults(data);
  if (!v.ok) throw new Error(`${path} is not a valid results.json:\n  - ${v.errors.join('\n  - ')}`);
  return data as Results;
}

async function writeBaseline(file: string, rec: HistoryRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(rec, null, 2) + '\n', 'utf8');
}

export async function runBaseline(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const sub = argv[0];
  const { pos, flags } = parse(argv.slice(1));
  const dir = resolve(process.env.BASELINE_DIR ?? 'baseline');
  const historyPath = join(dir, 'history.jsonl');
  const baselinePath = join(dir, 'baseline.json');
  const pendingPath = join(dir, 'pending-notes.txt');

  if (sub === 'show') {
    const history = await readHistory(historyPath);
    const active = await readBaseline(baselinePath);
    out(history.length ? formatTable(history, active?.id ?? null) : 'history is empty');
    return 0;
  }

  if (sub === 'record') {
    const file = pos[0];
    if (!file) { console.error(USAGE); return 2; }
    const res = await loadResults(file);
    const pending = await readPendingNotes(pendingPath);
    const notes = [pending, flags.notes].filter(Boolean).join(' | ');
    const rec = fromResults(res, { notes });
    const added = await appendHistory(historyPath, rec);
    if (!added) { out(`already recorded: ${rec.id}`); return 0; }
    await consumePendingNotes(pendingPath);
    out(`recorded ${rec.id} -> ${historyPath}`);
    if (res.run.truncated) out('note: run was truncated; it cannot be promoted without --force');
    return 0;
  }

  if (sub === 'promote') {
    const target = pos[0];
    if (!target) { console.error(USAGE); return 2; }
    const force = flags.force === 'true';
    let history = await readHistory(historyPath);

    let rec: HistoryRecord;
    let fromFile = false;
    if (existsSync(target)) {
      const res = await loadResults(target);
      const notes = [await readPendingNotes(pendingPath), flags.notes].filter(Boolean).join(' | ');
      rec = fromResults(res, { notes });
      fromFile = true;
    } else {
      rec = findRecord(history, target);
    }

    const why = incompleteReasons(rec);
    if (why.length && !force) {
      console.error(`refusing to promote ${rec.id}: ${why.join('; ')} (use --force to override)`);
      return 1;
    }
    const errs = validateRecord(rec);
    if (errs.length) { console.error(`invalid record: ${errs.join('; ')}`); return 1; }

    // Keep the outgoing baseline in history so it is never lost.
    const prev = await readBaseline(baselinePath);
    if (prev && prev.id !== rec.id && prev.date && !history.some((r) => r.id === prev.id) && validateRecord(prev).length === 0) {
      await appendHistory(historyPath, prev);
    }
    if (fromFile && (await appendHistory(historyPath, rec))) await consumePendingNotes(pendingPath);
    history = await readHistory(historyPath);
    await writeBaseline(baselinePath, history.find((r) => r.id === rec.id) ?? rec);
    out(`promoted ${rec.id} -> ${baselinePath}${why.length ? ` (forced: ${why.join('; ')})` : ''}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}
