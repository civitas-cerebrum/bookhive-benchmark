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
  const instance = new Ajv2020({ allErrors: true, strict: false });
  addFormats(instance);
  const results = JSON.parse(await readFile(join(SCHEMA_DIR, 'results.schema.json'), 'utf8'));
  const runSummary = JSON.parse(await readFile(join(SCHEMA_DIR, 'run-summary.schema.json'), 'utf8'));
  instance.addSchema(results, 'results');
  instance.addSchema(runSummary, 'run-summary');
  ajv = instance;
  return instance;
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
