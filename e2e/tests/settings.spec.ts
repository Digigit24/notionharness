import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

// Exercises the spend-cap save path (components/workspace/spend-cap-form.tsx
// + app/(app)/workspace/[workspaceSlug]/settings/actions.ts) — the exact
// feature that was failing `next build` with a stale-payload-types error
// earlier in this session, now regenerated and wired end-to-end.
test('workspace settings: spend cap can be set and then cleared', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/settings`)
  await expectNoErrorBoundary(page)
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

  const input = page.getByPlaceholder('Uncapped')
  await input.fill('42.50')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Spend cap set to $42.50/mo').first()).toBeVisible()

  // Reload to confirm the value actually persisted, not just optimistic UI.
  await page.reload()
  await expect(page.getByPlaceholder('Uncapped')).toHaveValue('42.50')

  await input.fill('')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Spend cap removed — uncapped').first()).toBeVisible()

  await page.reload()
  await expect(page.getByPlaceholder('Uncapped')).toHaveValue('')
})

test('workspace settings: a negative spend cap is rejected client-side', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/settings`)

  const input = page.getByPlaceholder('Uncapped')
  await input.fill('-10')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Enter a valid amount').first()).toBeVisible()
})
