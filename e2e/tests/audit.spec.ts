import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('audit log page loads', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/audit`)
  await expectNoErrorBoundary(page)
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible()
})
