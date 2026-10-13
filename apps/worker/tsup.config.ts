import { defineConfig } from 'tsup';

// Workspace packages are TypeScript sources: bundle them; keep npm dependencies external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@leadguard\//],
});
