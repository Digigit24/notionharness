import { test, expect } from '@playwright/test'
import { testWorkspaceSlug } from '../fixtures'

// The stale-build auto-recovery in components/app/stale-build-notice.tsx,
// proven end to end rather than trusted: a tab whose build id no longer
// matches what `/api/build-id` reports must reload itself once, and a tab
// that is STILL mismatched right after that reload (the window between a
// build finishing and the server restarting) must show the banner rather
// than reload again — the sessionStorage guard is what stands between a
// deploy and a tab thrashing itself.
//
// The mismatch is simulated by answering `/api/build-id` with a made-up id
// from the test itself, which exercises the real client code against the
// real page without restarting the server mid-suite. `visibilitychange` is
// dispatched to run the check immediately instead of waiting out the 30s
// poll — the component listens for it precisely so a tab you switch back to
// catches up at once.
test('a tab whose build no longer matches the server reloads itself once, then shows the banner instead of looping', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const slug = testWorkspaceSlug()

  await page.goto(`/workspace/${slug}`)
  await expect(page.getByTitle('New page', { exact: true })).toBeVisible()

  let loads = 0
  page.on('load', () => {
    loads += 1
  })

  await page.route('**/api/build-id', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ buildId: 'not-the-build-this-tab-was-served' }),
    }),
  )

  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForEvent('load', { timeout: 20_000 })
  expect(loads).toBe(1)

  // Still mismatched after the reload: the guard must hold.
  await expect(page.getByTitle('New page', { exact: true })).toBeVisible()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByText('This page is running an older version of the app.')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(3_000)
  expect(loads).toBe(1)
})
