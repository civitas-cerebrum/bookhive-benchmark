import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence, SuiteRun } from './types.js';

/** A command is a full-suite run when it invokes playwright test with no narrowing flag or path. */
export function isFullSuiteCommand(cmd: string): boolean {
  if (!/\bplaywright\s+test\b/.test(cmd)) return false;
  return !/--grep|(^|\s)-g\s|--last-failed|--list|--repeat-each|--project|--shard|\.spec\b|tests\/e2e\/\S|--only-changed/.test(cmd);
}

/** Parses the textual output of a playwright run (dot/list reporter). Returns null when it is not a run summary. */
export function parseSuiteOutput(out: string): Omit<SuiteRun, 'exit_code' | 'at' | 'command'> | null {
  const running = out.match(/Running (\d+) tests?/);
  if (!running) return null;
  const count = (word: string) => {
    const m = out.match(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const passed = count('passed');
  const failed = count('failed');
  if (passed === 0 && failed === 0) return null;
  // The failure list prints each failing test title once (`[project] › file › title`); dedupe retries.
  const failing = new Set(out.split('\n').filter((l) => /^\s*(?:\d+\)\s*)?\[[^\]]+\] ›/.test(l)).map((l) => l.trim().replace(/^\d+\)\s*/, '')));
  const known = [...failing].filter((l) => l.includes('@known-defect')).length;
  return {
    total: Number(running[1]),
    passed,
    failed,
    flaky: count('flaky'),
    skipped: count('skipped'),
    known_defect_failures: known,
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('\n');
  return '';
}

/** The last full-suite playwright run recorded in the session transcript, or null. */
export async function findLastSuiteRun(transcriptPath: string): Promise<SuiteRun | null> {
  let raw: string;
  try { raw = await readFile(transcriptPath, 'utf8'); } catch { return null; }
  const commands = new Map<string, string>();
  let last: SuiteRun | null = null;
  for (const line of raw.split('\n')) {
    if (!line.includes('playwright') && !line.includes('tool_use_id')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (o.type === 'assistant' && part?.type === 'tool_use' && part.name === 'Bash' && typeof part.input?.command === 'string') {
        commands.set(part.id, part.input.command);
      } else if (o.type === 'user' && part?.type === 'tool_result') {
        const cmd = commands.get(part.tool_use_id);
        if (!cmd || !isFullSuiteCommand(cmd)) continue;
        const text = textOf(part.content);
        const parsed = parseSuiteOutput(text);
        if (!parsed) continue;
        const ec = text.match(/^Error: Exit code (\d+)/m) ?? text.match(/^Exit code (\d+)/m);
        const exit_code = ec ? Number(ec[1]) : part.is_error ? 1 : 0;
        last = { ...parsed, exit_code, at: typeof o.timestamp === 'string' ? o.timestamp : '', command: cmd };
      }
    }
  }
  return last;
}

/**
 * Pages in the journey map: rows of the `## Site Map` table in
 * tests/e2e/docs/journey-map.md, else the `**Pages discovered:** N` header.
 */
export async function countJourneyMapPages(projectDir: string): Promise<{ pages: number; source: string } | null> {
  const rel = 'tests/e2e/docs/journey-map.md';
  let md: string;
  try { md = await readFile(join(projectDir, rel), 'utf8'); } catch { return null; }
  const section = md.split(/^## /m).find((s) => /^Site Map\b/.test(s));
  if (section) {
    const rows = section.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).length;
    if (rows > 0) return { pages: rows, source: `${rel}: ${rows} rows in the Site Map table` };
  }
  const h = md.match(/\*\*Pages discovered:\*\*\s*(\d+)/);
  if (h) return { pages: Number(h[1]), source: `${rel}: "Pages discovered" header` };
  return null;
}

export async function deriveEvidence(transcriptPath: string, projectDir: string | undefined): Promise<Evidence> {
  return {
    suite: await findLastSuiteRun(transcriptPath),
    journeyMapPages: projectDir ? await countJourneyMapPages(projectDir) : null,
  };
}
