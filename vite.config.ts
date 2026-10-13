import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build runs from any sub-path (GitHub Pages, file shares, local servers).
  base: './',
  server: { host: true },
  build: {
    // iOS 15+ Safari: WebGL2, ES2020, module workers.
    target: ['es2020', 'safari15'],
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
