// Throwaway: fails on purpose to test the CI failure report (step 2). Never merged.
import { expect, it } from 'vitest';

it('fails on purpose for the CI report test', () => {
  expect(1 + 1).toBe(3);
});
