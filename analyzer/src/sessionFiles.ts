import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The main transcript plus its subagents' transcripts (`<session>/subagents/*.jsonl`).
 * Work delegated to subagents (the Achilles orchestrator and its experts) is only
 * recorded there.
 */
export async function sessionTranscripts(transcriptPath: string): Promise<string[]> {
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return [transcriptPath]; }
  return [transcriptPath, ...names.filter((n) => n.endsWith('.jsonl')).sort().map((n) => join(dir, n))];
}
