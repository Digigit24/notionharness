import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('projects list page loads', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/projects`)
  await expectNoErrorBoundary(page)
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
})
