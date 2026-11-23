import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One suite per machine (#109).
    globalSetup: ['test/global-setup.ts'],
    // Tests never play sound: say/afplay are silent stand-ins and a test that used them fails (test/helpers/no-sound.ts).
    setupFiles: ['test/no-sound-check.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    // Integration tests launch real browsers; keep them from fighting over CPU.
    fileParallelism: false,
  },
});
