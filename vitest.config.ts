import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['analyzer/tests/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
  },
});
