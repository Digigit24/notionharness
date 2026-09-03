import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('creating a new page from the sidebar opens the page canvas', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}`)

  await page.getByTitle('New page', { exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/workspace/${slug}/p/\\d+$`))
  await expectNoErrorBoundary(page)
  // BlockSuite's editor is a heavy client-side mount (see AGENTS.md's
  // lib/blocksuite-doc.ts notes) — asserting the seeded "Untitled" title is
  // visible somewhere is enough for a smoke check without depending on
  // BlockSuite's internal DOM shape.
  await expect(page.getByText('Untitled', { exact: false }).first()).toBeVisible()
})
