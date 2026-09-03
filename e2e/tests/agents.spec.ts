import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('agents page loads', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/agents`)
  await expectNoErrorBoundary(page)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
})
