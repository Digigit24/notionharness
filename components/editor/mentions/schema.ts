import { z } from 'zod'

// Declaration merging onto BlockSuite's own `AffineTextAttributes` interface —
// the same mechanism `reference`/`link`/`latex` use — so a mention is just
// another named inline delta attribute, not a parallel content model.
declare module '@blocksuite/affine-shared/types' {
  interface AffineTextAttributes {
    mention?: MentionAttribute | null
  }
}

export interface MentionAttribute {
  userId: string
  name: string
}

export const MentionAttributeSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
  })
  .optional()
  .nullable()
  .catch(undefined)
