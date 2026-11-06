import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of this Stephen install (src/lib or dist/lib → two levels up). Its .env is in every job's denyRead. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
