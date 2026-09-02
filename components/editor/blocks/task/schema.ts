import { defineBlockSchema, type SchemaToModel } from '@/lib/blocksuite-store'

// ROADMAP B3.4 — "turn any line into a real task with an assignee and a
// status, rendered inline, editable from the page, backed by the tasks
// table. Notion's to-do that is actually a work item." Same "reference,
// never container" shape as `run-card/schema.ts`: the block holds nothing
// but a pointer to the real row in the `tasks` collection — title/status/
// assignee are all read from (and written back to) that row, never
// duplicated into block props, so there is exactly one source of truth.
export const TaskBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-task',
  props: () => ({
    taskId: null as number | null,
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note'],
    children: [],
  },
})

export type TaskBlockModel = SchemaToModel<typeof TaskBlockSchema>

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace BlockSuite {
    interface BlockModels {
      'affine:embed-task': TaskBlockModel
    }
  }
}
