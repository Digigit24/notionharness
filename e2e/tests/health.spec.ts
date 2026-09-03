import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('health page loads with its real metric cards', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/health`)
  await expectNoErrorBoundary(page)
  await expect(page.getByRole('heading', { name: 'Health', level: 1 })).toBeVisible()
})
