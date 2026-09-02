import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// Mirrors tsconfig.json's `"paths": { "@/*": ["./*"] }`. Vitest (via Vite)
// doesn't read tsconfig path aliases on its own, and this repo has no other
// Vite-adjacent tooling already providing that resolution — it's a Next.js/
// webpack app, and Next's own alias handling only applies inside `next dev`/
// `next build`, not here. A single `resolve.alias` entry covers the repo's
// one alias without adding a `vite-tsconfig-paths` dependency for it.
export default defineConfig({
  resolve: {
    alias: {
      '@': rootDir,
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
  },
})
