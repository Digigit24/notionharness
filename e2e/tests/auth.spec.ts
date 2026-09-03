import { test, expect } from '@playwright/test'

// This whole suite otherwise runs pre-authenticated (playwright.config.ts's
// global storageState) — these two specs deliberately opt out to exercise
// the actual login/signup pages as an anonymous visitor.
test.use({ storageState: { cookies: [], origins: [] } })

test('login page renders the auth form', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'NotionForge' })).toBeVisible()
  await expect(page.getByPlaceholder('Email')).toBeVisible()
  await expect(page.getByPlaceholder('Password')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
})

test('signup page renders the auth form', async ({ page }) => {
  await page.goto('/signup')
  await expect(page.getByPlaceholder('Name')).toBeVisible()
  await expect(page.getByPlaceholder('Email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible()
})

test('login page links to signup and vice versa', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('link', { name: 'Sign up' }).click()
  await expect(page).toHaveURL(/\/signup$/)
  await page.getByRole('link', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/login$/)
})

test('rejects an invalid login with an inline error, not a crash', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('Email').fill('nobody-e2e@notionforge.test')
  await page.getByPlaceholder('Password').fill('wrong-password-123')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.locator('p.text-red-500')).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})
