import { defineBlockSchema, type SchemaToModel } from '@/lib/blocksuite-store'

// ROADMAP P2.3/D3 — which `GenericDataSource` backend this block is
// connected to. `null` (the pre-P2.3 default) means "legacy Teable block":
// existing documents already have `teableDatabaseId` set with no
// `sourceType` at all, so `native-database-block.ts` treats `sourceType ===
// null && teableDatabaseId !== null` as `'teable'` rather than requiring a
// migration of every existing block.
export type NativeDatabaseSourceType = 'teable' | 'payload' | 'user-database'

// Pure `@blocksuite/store` schema — see `teable-database/schema.ts` for why
// the flavour is `affine:embed-*` (required to satisfy `affine:note`'s
// children allow-list in this BlockSuite version).
//
// NOTION-PARITY 4 — the flavour string itself (`affine:embed-teable-native`)
// is DELIBERATELY left unchanged even though everything else in this block
// was renamed from "teable-native" to "native-database": it's persisted
// verbatim inside every existing page's Yjs docState blob in the live DB.
// Renaming it would make the block unresolvable on load for every page that
// already has one — this block's own view/schema registration is what maps
// the (old) flavour string to the (new) class/component names, so nothing
// about that mapping requires the flavour string to change too.
export const NativeDatabaseBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-teable-native',
  props: () => ({
    teableDatabaseId: null as number | null,
    sourceType: null as NativeDatabaseSourceType | null,
    payloadCollection: null as string | null,
    userDatabaseId: null as number | null,
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note'],
    children: [],
  },
})

export type NativeDatabaseBlockModel = SchemaToModel<typeof NativeDatabaseBlockSchema>

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace BlockSuite {
    interface BlockModels {
      'affine:embed-teable-native': NativeDatabaseBlockModel
    }
  }
}
