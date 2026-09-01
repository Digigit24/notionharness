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
  // Holds a Better Auth user id when `kind` is 'user' (or omitted, for
  // mentions persisted before agent mentions existed) and an `agents`
  // collection id when `kind` is 'agent' — one id slot, not two, since a
  // mention only ever points at one or the other.
  userId: string
  name: string
  kind?: 'user' | 'agent'
}

export const MentionAttributeSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    kind: z.enum(['user', 'agent']).optional(),
  })
  .optional()
  .nullable()
  .catch(undefined)
