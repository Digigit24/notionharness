import { defineBlockSchema, type SchemaToModel } from '@blocksuite/store'

// ROADMAP P2.3/D3 — which `GenericDataSource` backend this block is
// connected to. `null` (the pre-P2.3 default) means "legacy Teable block":
// existing documents already have `teableDatabaseId` set with no
// `sourceType` at all, so `teable-native-block.ts` treats `sourceType ===
// null && teableDatabaseId !== null` as `'teable'` rather than requiring a
// migration of every existing block.
export type TeableNativeSourceType = 'teable' | 'payload' | 'user-database'

// Pure `@blocksuite/store` schema — see `teable-database/schema.ts` for why
// the flavour is `affine:embed-*` (required to satisfy `affine:note`'s
// children allow-list in this BlockSuite version).
export const TeableNativeBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-teable-native',
  props: () => ({
    teableDatabaseId: null as number | null,
    sourceType: null as TeableNativeSourceType | null,
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

export type TeableNativeBlockModel = SchemaToModel<typeof TeableNativeBlockSchema>

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace BlockSuite {
    interface BlockModels {
      'affine:embed-teable-native': TeableNativeBlockModel
    }
  }
}
