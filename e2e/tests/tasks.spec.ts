import { test, expect } from '@playwright/test'
import { testWorkspaceSlug, expectNoErrorBoundary } from '../fixtures'

test('tasks board renders the default status columns', async ({ page }) => {
  const slug = testWorkspaceSlug()
  await page.goto(`/workspace/${slug}/tasks`)
  await expectNoErrorBoundary(page)
  for (const status of ['Backlog', 'To Do', 'In Progress', 'Done']) {
    await expect(page.getByText(status, { exact: true })).toBeVisible()
  }
})

test('can add a task via the Backlog column and see it appear', async ({ page }) => {
  const slug = testWorkspaceSlug()
  const title = `Playwright smoke task ${Date.now()}`
  await page.goto(`/workspace/${slug}/tasks`)

  // Columns are seeded in Backlog/To Do/In Progress/Done order (see
  // app/(app)/actions.ts's DEFAULT_TASK_STATUSES), so the first "Add task"
  // control in DOM order belongs to Backlog.
  await page.getByRole('button', { name: 'Add task' }).first().click()
  const input = page.getByPlaceholder('Task title')
  await input.fill(title)
  await input.press('Enter')

  await expect(page.getByText(title, { exact: true })).toBeVisible()
})

test('opening a task card shows its detail drawer', async ({ page }) => {
  const slug = testWorkspaceSlug()
  const title = `Playwright detail-open task ${Date.now()}`
  await page.goto(`/workspace/${slug}/tasks`)

  await page.getByRole('button', { name: 'Add task' }).first().click()
  const input = page.getByPlaceholder('Task title')
  await input.fill(title)
  await input.press('Enter')

  // Deliberately `dispatchEvent('click')`, not `.click()`: TaskCard spreads
  // dnd-kit's `useDraggable` pointer listeners across the whole card (see
  // components/tasks/task-board-view.tsx), and Playwright's real, tightly-
  // batched pointerdown/pointerup sequence reliably locks up the page's JS
  // thread there — confirmed reproducible 3/3 runs against a clean
  // production server with zero other load, and confirmed NOT triggered by
  // a manual mouse.move+down+up sequence or a plain DOM click dispatch, so
  // it's specific to dnd-kit's PointerSensor reacting to that exact event
  // timing (dnd-kit 6.x's peer deps target React <=18; this repo runs
  // React 19). A real mouse user's down-to-up gap is always far larger than
  // this, so it's very unlikely to bite an actual person — but it is a
  // real, live hang, not a test artifact, and is worth fixing upstream
  // (e.g. isolating the drag handle from the click target) independent of
  // this workaround.
  await page.getByText(title, { exact: true }).dispatchEvent('click')
  const drawer = page.getByRole('dialog', { name: 'Task details' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText(title, { exact: true })).toBeVisible()

  await drawer.getByRole('button', { name: 'Close task details' }).click()
  await expect(drawer).not.toBeVisible()
})
