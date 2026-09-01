import { defineBlockSchema, type SchemaToModel } from '@/lib/blocksuite-store'

// Pure `@blocksuite/store` schema definition — no `lit`/DOM imports — so it can be
// registered from both the browser (BlockSuiteEditor.tsx) and the headless
// server-side doc mirror (lib/blocksuite-doc.ts) without pulling in view code.
//
// Named `affine:embed-*` (not just `affine:teable-database`) because
// `affine:note`'s schema restricts its `children` to a fixed allow-list that
// includes the `affine:embed-*` glob but not arbitrary flavours — this is the
// only flavour-naming scheme under which a custom block can be a child of a
// note in this BlockSuite version. Kept a plain `defineBlockSchema` (not
// `createEmbedBlockSchema`) to avoid its GFX/edgeless/caption machinery, which
// this block doesn't need.
export const TeableDatabaseBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-teable-database',
  props: () => ({
    teableDatabaseId: null as number | null,
    // Which view tab was last active, so reopening the doc restores it.
    // Kanban/Calendar are valid values even before those views are built —
    // the tab itself renders a placeholder until their controllers land.
    activeView: 'table' as 'table' | 'kanban' | 'calendar',
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note'],
    children: [],
  },
})

export type TeableDatabaseBlockModel = SchemaToModel<typeof TeableDatabaseBlockSchema>

declare global {
  // BlockSuite augments its own `BlockSuite.BlockModels` ambient namespace this
  // same way to register a flavour's model type — no ES module alternative exists.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace BlockSuite {
    interface BlockModels {
      'affine:embed-teable-database': TeableDatabaseBlockModel
    }
  }
}
