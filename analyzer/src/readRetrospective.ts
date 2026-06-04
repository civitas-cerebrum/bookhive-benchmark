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
