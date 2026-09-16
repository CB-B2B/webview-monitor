import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.spec.ts'],
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
});
