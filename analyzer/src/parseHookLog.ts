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
