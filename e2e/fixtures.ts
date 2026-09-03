import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { WORKSPACE_INFO_PATH } from './test-identity'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function testWorkspaceSlug(): string {
  const raw = fs.readFileSync(path.join(__dirname, WORKSPACE_INFO_PATH), 'utf-8')
  return (JSON.parse(raw) as { workspaceSlug: string }).workspaceSlug
}

// Checks for this app's own route-level error.tsx text and Next.js dev
// mode's runtime-error overlay text. Deliberately does NOT check for the
// `<nextjs-portal>` element itself — that custom element also hosts Next
// dev mode's always-present dev-tools indicator badge, so its mere presence
// says nothing about whether anything actually broke.
export async function expectNoErrorBoundary(page: Page) {
  const { expect } = await import('@playwright/test')
  await expect(page.getByText('Something broke on this page', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Application error', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Unhandled Runtime Error', { exact: false })).toHaveCount(0)
}
