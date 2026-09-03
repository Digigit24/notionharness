// Single source of truth for the dedicated E2E identity, shared between
// global-setup (which creates/logs into it) and any spec that needs to
// assert against it by name (e.g. the workspace switcher). Fixed, not
// randomly generated, so repeated local runs reuse the same account/
// workspace in the shared DB instead of accumulating a new one every time.
export const TEST_USER = {
  name: 'Playwright E2E',
  email: process.env.E2E_TEST_EMAIL || 'playwright-e2e@notionforge.test',
  password: process.env.E2E_TEST_PASSWORD || 'PlaywrightE2E!2026',
}

export const TEST_WORKSPACE_NAME = 'Playwright E2E'

// Relative to this file's own directory (e2e/) — global-setup.ts and
// fixtures.ts both resolve these against their own `__dirname`;
// playwright.config.ts (at the repo root) prefixes with `e2e/` itself.
export const AUTH_STATE_PATH = '.auth/user.json'
export const WORKSPACE_INFO_PATH = '.auth/workspace.json'
