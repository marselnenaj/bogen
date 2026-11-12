import { defineConfig } from 'vitest/config';
// The suite starts real servers and browsers side by side. One worker per core starved them: a different test timed out on
// each run. So the workers are capped, and a test gets longer than Vitest's 5 s for its turn.
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'], maxWorkers: 10, testTimeout: 30000, hookTimeout: 30000 } });
