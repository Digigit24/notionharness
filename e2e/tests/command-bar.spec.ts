import { test, expect } from '@playwright/test'
import { testWorkspaceSlug } from '../fixtures'

test('command bar opens via Ctrl+K, searches, and closes on Escape', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}`)

  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  const searchInput = dialog.getByPlaceholder(/or run a command/i)
  await expect(searchInput).toBeFocused()

  await searchInput.fill('Tasks')
  await expect(dialog.getByText('Tasks', { exact: false }).first()).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})

test('command bar search trigger button also opens it', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}`)

  await page.getByTitle(/Open the command bar/i).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})
