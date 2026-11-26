/**
 * Planned protections that have no code yet (docs/INJECTION-COVERAGE.md, "Planned, not built"). They are todo
 * entries, so CI stays green. Each one is listed with its source row and the file that will need it.
 */
import { describe, it } from 'vitest';

describe('planned protections (not built yet)', () => {
  it.todo('job output: frame it in <untrusted_job_output> if it ever enters a model prompt (src/jobs/spec.ts cleanJobOutput)');
  it.todo('memory proposals: an untrusted origin (email, canvas, web) refuses imperative text before it is stored (src/memory/proposals.ts propose)');
  it.todo('incident issue text: the parser keeps code words and numbers only and drops planted free text (ADR-014 phase 2, scripts/incident-parse.mjs)');
});
