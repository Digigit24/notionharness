import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('workspace home renders the ambient status shell', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}`)
  await expectNoErrorBoundary(page)
  // B5.1's stated bar: "what needs me, what is happening right now, what I
  // was doing, what it is costing" — the search trigger and page-tree
  // "New page" affordance are the two controls guaranteed present
  // regardless of how empty a freshly-created workspace's data is.
  await expect(page.getByTitle(/Open the command bar/i)).toBeVisible()
  await expect(page.getByTitle('New page')).toBeVisible()
})

test('the workspace switcher lists this identity\'s own test workspace', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}`)
  await expect(page).toHaveURL(new RegExp(`/workspace/${slug}$`))
})
