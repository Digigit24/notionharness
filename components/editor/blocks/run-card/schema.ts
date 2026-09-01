import { defineBlockSchema, type SchemaToModel } from '@/lib/blocksuite-store'

// ROADMAP 6.3 — "a run card... references a run by id and renders its live
// status, outcome chips and cost inline. Reference, never container." A
// fresh, dedicated flavour (unlike native-database's reused legacy Teable
// flavour string) since there's no prior persisted data to stay compatible with.
export const RunCardBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-run-card',
  props: () => ({
    runId: null as number | null,
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note'],
    children: [],
  },
})

export type RunCardBlockModel = SchemaToModel<typeof RunCardBlockSchema>

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace BlockSuite {
    interface BlockModels {
      'affine:embed-run-card': RunCardBlockModel
    }
  }
}
