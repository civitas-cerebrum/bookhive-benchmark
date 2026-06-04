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
