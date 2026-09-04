// zod v3, NOT this app's top-level zod v4 — BlockSuite's own inline-attribute
// merge (`@blocksuite/inline`'s `normalizeAttributes`) does its own internal
// zod v3 instanceof/`_def` checks on every registered spec's schema. A v4
// schema object doesn't satisfy those checks, so BlockSuite silently treats
// the `mention` key as unregistered (`z.never()`) — confirmed live: every
// mention insert threw `ZodError: expected never, received object` at
// `insertText` time, which aborted the insert with no visible error to the
// user (the popover just closed with nothing written). `zod-v3` is an
// npm-aliased pin of the exact version `@blocksuite/inline` itself bundles
// (node_modules/@blocksuite/inline/node_modules/zod), not a separate
// dependency choice.
import { z } from 'zod-v3'

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
