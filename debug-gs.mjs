import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const context = await browser.newContext({ baseURL: 'http://localhost:3001' })
const page = await context.newPage()

await page.goto('/login')
await page.getByPlaceholder('Email').fill('playwright-e2e@notionforge.test')
await page.getByPlaceholder('Password').fill('PlaywrightE2E!2026')
await page.getByRole('button', { name: 'Log in' }).click()
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 })
await page.waitForLoadState('networkidle')
console.log('URL:', page.url())
console.log('BODY:', JSON.stringify((await page.locator('body').innerText()).slice(0, 300)))
await browser.close()
