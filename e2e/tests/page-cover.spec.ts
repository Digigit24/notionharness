import { test, expect } from '@playwright/test'
import { testWorkspaceSlug } from '../fixtures'

// Regression for "the cover flickers and then disappears". The first version
// of this spec was purely observational (sampled the cover every 500ms for
// 12s after the click and again after a reload) and proved the cover never
// moves in a clean session — the disappearance came from a tab that had
// outlived its build. Kept as a hard assertion so any future change to the
// save path (its revalidation, its optimistic state) that reintroduces a
// revert fails here rather than being rediscovered by hand.
test('a cover added to a page stays after its save lands, and after a reload', async ({ page }) => {
  test.setTimeout(90_000)
  const slug = testWorkspaceSlug()

  await page.goto(`/workspace/${slug}`)
  await page.getByTitle('New page', { exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/workspace/${slug}/p/\\d+$`))
  const title = page.getByLabel('Page title')
  await expect(title).toBeVisible()

  await page.getByRole('button', { name: 'Add cover' }).click()
  await page.getByTitle('Use this cover').first().click()

  const cover = page.locator('div.group.relative.h-40.w-full')
  const failureToast = page.getByText("Couldn't update the cover")
  await expect(cover).toBeVisible()

  // Long enough for the save's round trip — and the layout revalidation it
  // triggers, which re-renders the whole workspace subtree — to land. If
  // that response ever reset the page's local state, this is where the
  // cover would vanish.
  await page.waitForTimeout(6_000)
  await expect(cover).toBeVisible()
  await expect(failureToast).toHaveCount(0)

  await page.reload()
  await expect(title).toBeVisible()
  await expect(cover).toBeVisible()
  await page.waitForTimeout(6_000)
  await expect(cover).toBeVisible()
})
