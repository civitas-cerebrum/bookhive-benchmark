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
    const role: TurnEvent['role'] = obj.type === 'user' ? 'user' : 'assistant';

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
