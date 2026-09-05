import { test, expect } from '@playwright/test'
import { testWorkspaceSlug } from '../fixtures'

// Regression for the real "Illegal constructor" crash: BlockSuiteEditor.tsx
// has five separate import sites (page-canvas.tsx and canvas-pane.tsx via
// next/dynamic, plus static imports in artifact-panel.tsx, task-work-tab.tsx,
// and record-detail-note.tsx). Webpack is free to put each in its own
// chunk, and each chunk that contains a copy of the module got its own copy
// of the old module-level "register custom elements once" guard — so a
// session that opened the editor via a SECOND entry point loaded a second,
// independent copy that had never heard of the first, and called
// customElements.define() again. This opens the editor via two different
// entry points (a plain page via page-canvas.tsx's dynamic chunk, then a
// task's Work tab via task-work-tab.tsx's static import) in one tab and
// asserts neither throws.
test('opening the editor via two different entry points in one tab does not crash', async ({ page }) => {
  test.setTimeout(90_000)
  const slug = testWorkspaceSlug()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })

  try {
    // Entry point A: a plain page (page-canvas.tsx -> next/dynamic chunk).
    await page.goto(`/workspace/${slug}`)
    await page.getByTitle('New page', { exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/workspace/${slug}/p/\\d+$`))
    const pageTitle = page.getByLabel('Page title')
    await expect(pageTitle).toBeVisible()
    await pageTitle.fill(`multi-entry page ${Date.now()}`)
    await pageTitle.blur()

    // Entry point B: a task's Work tab (task-work-tab.tsx -> static import,
    // a different module instance than page-canvas.tsx's dynamic chunk if
    // webpack split them separately).
    await page.goto(`/workspace/${slug}/tasks`)
    await page.getByRole('button', { name: 'Add task' }).first().click()
    const taskInput = page.getByPlaceholder('Task title')
    const title = `multi-entry task ${Date.now()}`
    await taskInput.fill(title)
    await taskInput.press('Enter')
    await page.getByText(title, { exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/workspace/${slug}/tasks/\\d+`))

    // The Work tab's own BlockSuite editor for the task's paired page —
    // same DOM shape page-canvas.tsx's editor produces.
    const taskEditor = page.locator('.affine-page-root-block-container, affine-page-root')
    await expect(taskEditor.first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(3_000)

    // Back to entry point A once more — if the second entry point's
    // registration silently broke something, re-mounting the first kind is
    // where it would show.
    await page.goto(`/workspace/${slug}`)
    await page.getByTitle('New page', { exact: true }).click()
    await expect(page.getByLabel('Page title')).toBeVisible()
    await page.waitForTimeout(3_000)
  } finally {
    console.log(errors.length ? `CLIENT ERRORS:\n${errors.join('\n')}` : '(no client errors)')
  }

  expect(errors.filter((e) => /Illegal constructor/i.test(e))).toHaveLength(0)
  await expect(page.getByText('This page is running an older version of the app.')).toHaveCount(0)
})
