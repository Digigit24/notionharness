import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`

// A shared Supabase Postgres DB backs this app in every environment (see
// AGENTS.md's DB safety note) — there is no disposable local DB to point
// tests at. e2e/global-setup.ts confines all writes to one clearly-labeled
// test user + workspace (see e2e/test-identity.ts) rather than touching any
// pre-existing data, and every spec below only ever navigates inside that
// workspace.
export default defineConfig({
  testDir: './e2e/tests',
  // Generous: against `next dev` (this repo's typical already-running
  // server — see the webServer note below), an as-yet-uncompiled route's
  // first request pays a real on-demand webpack-compile cost on top of
  // normal render time, especially the BlockSuite-heavy page canvas route.
  // Once a route has compiled once, it stays fast for the rest of the run.
  timeout: 60_000,
  expect: { timeout: 8_000 },
  // Deliberately NOT parallel: every spec shares the one "Playwright E2E"
  // workspace in the real shared Supabase DB (see e2e/test-identity.ts and
  // AGENTS.md's own note on that DB's low connection cap), and several
  // specs mutate it (create a task, create a page). Running those
  // concurrently raced each other and starved the DB pool — real flakiness
  // from real contention, not a test-timing fudge. Since this DB may also
  // be serving your own manual testing at the same time, serial is the
  // safer default even though it costs wall-clock time.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: path.join(rootDir, 'e2e/global-setup.ts'),
  use: {
    baseURL: BASE_URL,
    storageState: path.join(rootDir, 'e2e/.auth/user.json'),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Reuses whatever is already listening on BASE_URL (this repo's dev/start
  // server is frequently left running already — see AGENTS.md) and only
  // falls back to booting its own `next dev` when nothing answers there.
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
