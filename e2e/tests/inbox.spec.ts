import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('inbox page loads', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/inbox`)
  await expectNoErrorBoundary(page)
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible()
})
