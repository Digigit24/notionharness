import { defineBlockSchema, type SchemaToModel } from '@blocksuite/store'

// Pure `@blocksuite/store` schema — see `teable-database/schema.ts` for why
// the flavour is `affine:embed-*` (required to satisfy `affine:note`'s
// children allow-list in this BlockSuite version).
export const TeableNativeBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-teable-native',
  props: () => ({
    teableDatabaseId: null as number | null,
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
