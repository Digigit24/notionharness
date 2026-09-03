import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

const SECTIONS: Array<{ path: string; label: string }> = [
  { path: '', label: 'Home' },
  { path: '/inbox', label: 'Inbox' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/projects', label: 'Projects' },
  { path: '/agents', label: 'Agents' },
  { path: '/audit', label: 'Audit' },
  { path: '/settings', label: 'Settings' },
]

test.describe('workspace sidebar navigation', () => {
  let slug: string
  test.beforeAll(() => {
    slug = testWorkspaceSlug()
  })

  for (const section of SECTIONS) {
    test(`sidebar link "${section.label}" opens /workspace/:slug${section.path}`, async ({ page }) => {
      await page.goto(`/workspace/${slug}`)
      await page.getByRole('link', { name: section.label, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/workspace/${slug}${section.path}$`))
      await expectNoErrorBoundary(page)
    })
  }

  test('direct navigation to the workspace health page succeeds', async ({ page }) => {
    await page.goto(`/workspace/${slug}/health`)
    await expect(page).toHaveURL(new RegExp(`/workspace/${slug}/health$`))
    await expectNoErrorBoundary(page)
  })

  test('an unknown workspace slug 404s instead of crashing', async ({ page }) => {
    const response = await page.goto('/workspace/definitely-not-a-real-workspace-slug-xyz')
    expect(response?.status()).toBe(404)
  })
})
