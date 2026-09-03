import { chromium, type FullConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTH_STATE_PATH, TEST_USER, TEST_WORKSPACE_NAME, WORKSPACE_INFO_PATH } from './test-identity'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Bootstraps the one dedicated E2E identity this whole suite runs as (see
// test-identity.ts for why it's fixed rather than random) and hands every
// spec a pre-authenticated storage state plus that identity's workspace
// slug — so no spec ever has to touch the login form or workspace picker
// itself, and no spec ever creates a second workspace by accident.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL as string
  const authDir = path.join(__dirname, '.auth')
  fs.mkdirSync(authDir, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()

  await page.goto('/signup')
  await page.getByPlaceholder('Name').fill(TEST_USER.name)
  await page.getByPlaceholder('Email').fill(TEST_USER.email)
  await page.getByPlaceholder('Password').fill(TEST_USER.password)
  await page.getByRole('button', { name: 'Sign up' }).click()

  const signupFailed = await Promise.race([
    page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: 10_000 }).then(() => false),
    page.getByText(/already exist|invalid|something went wrong/i).first().waitFor({ timeout: 10_000 }).then(() => true),
  ]).catch(() => true)

  if (signupFailed) {
    // Account already exists from a prior run — log in instead.
    await page.goto('/login')
    await page.getByPlaceholder('Email').fill(TEST_USER.email)
    await page.getByPlaceholder('Password').fill(TEST_USER.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  }

  // The auth form's own client-side redirect() lands on `/` first; if this
  // identity already owns exactly one workspace, `/` then issues a second,
  // server-side redirect into it (app/(app)/page.tsx). Settling network
  // activity here avoids reading `page.url()` mid-hop, between those two
  // redirects, as `/` itself.
  await page.waitForLoadState('networkidle')

  // Home page either auto-redirected into this identity's own workspace, or
  // (first run for this account) is showing the picker/create-workspace
  // form — find this identity's own workspace by name there, or create it.
  let workspaceSlug: string | null = null
  const url = new URL(page.url())
  const workspaceMatch = url.pathname.match(/^\/workspace\/([^/]+)/)
  if (workspaceMatch) {
    workspaceSlug = workspaceMatch[1]
  } else {
    const ownWorkspaceLink = page.getByRole('link', { name: TEST_WORKSPACE_NAME, exact: true })
    if (await ownWorkspaceLink.count()) {
      const href = await ownWorkspaceLink.first().getAttribute('href')
      workspaceSlug = href?.match(/^\/workspace\/([^/]+)/)?.[1] ?? null
    } else {
      await page.getByPlaceholder('New workspace name').fill(TEST_WORKSPACE_NAME)
      await page.getByRole('button', { name: 'Create workspace' }).click()
      await page.waitForURL((u) => /^\/workspace\/[^/]+/.test(u.pathname), { timeout: 15_000 })
      workspaceSlug = new URL(page.url()).pathname.match(/^\/workspace\/([^/]+)/)?.[1] ?? null
    }
  }

  if (!workspaceSlug) {
    throw new Error('global-setup: could not resolve the Playwright E2E test workspace slug')
  }

  fs.writeFileSync(path.join(__dirname, WORKSPACE_INFO_PATH), JSON.stringify({ workspaceSlug }, null, 2))
  await context.storageState({ path: path.join(__dirname, AUTH_STATE_PATH) })

  await browser.close()
}
