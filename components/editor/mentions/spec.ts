import { type ExtensionType } from '@/lib/blocksuite-block-std'
import { InlineSpecExtension } from '@/lib/blocksuite-affine-components'
import { html } from 'lit'
import { getMenusWithMentions } from './menu'
import { MentionAttributeSchema } from './schema'

// `MentionAttributeSchema` (schema.ts) is built from `zod-v3`, an aliased pin
// of the exact zod version every `@blocksuite/*` package bundles — matches
// this repo's own established rule (see lib/blocksuite-affine-components.ts's
// header comment) that anything touching BlockSuite internals must not pull
// in a second, incompatible copy of a dependency BlockSuite itself relies on.
export const MentionInlineSpecExtension = InlineSpecExtension({
  name: 'mention',
  schema: MentionAttributeSchema as unknown as never,
  match: (delta) => !!delta.attributes?.mention,
  renderer: ({ delta }) => html`<affine-mention .delta=${delta}></affine-mention>`,
  embed: true,
})

// `MentionInlineSpecExtension` alone only makes a "mention" inline spec
// DISCOVERABLE by id — registering it here does NOT, by itself, make any
// paragraph/list block's actual attribute validator accept a `mention` key.
// That validator comes from `DefaultInlineManagerExtension` (@blocksuite/
// affine-components/rich-text/all-extensions.ts), whose own `specs: [...]`
// array is a closed, hardcoded list of BlockSuite's built-in specs (bold,
// italic, ..., reference, link) that has no way to know about ours. Every
// paragraph/list block reads `inlineManager.getSchema()`, which merges
// exactly that closed list — so inserting a mention there always failed
// zod validation with "expected never, received object" for the `mention`
// key (confirmed live via a scripted repro), even though the popover menu
// itself worked fine end to end. `./inline-manager-override.ts` (imported
// directly by BlockSuiteEditor.tsx, not re-exported here, to avoid a
// circular import — that module imports `MentionInlineSpecExtension` from
// this file) fixes the actual defect by re-registering
// `DefaultInlineManagerExtension`'s own identifier (via `di.override`, not
// `di.addImpl`, since re-`addImpl`-ing an existing identifier throws
// `DuplicateServiceDefinitionError`) with the same built-in spec list plus
// this one.

export const MentionSpec: ExtensionType[] = [MentionInlineSpecExtension]

// Overrides `affine:page`'s stock `getMenus`, which is otherwise the sole
// handler for the `@` trigger — see menu.ts for why this composes rather
// than replaces the existing "link to doc" behavior.
//
// NOT wrapped in its own `ConfigExtension('affine:page', ...)` here — that
// extension throws `DuplicateServiceDefinitionError` if a second config is
// registered for the same block flavour, and `agent-thread/toolbar-trigger.ts`
// also needs an `affine:page` config (for `toolbarMoreMenu`). Both raw config
// objects are merged into ONE `ConfigExtension` call in BlockSuiteEditor.tsx,
// the single place that already composes every spec — so this module and
// toolbar-trigger.ts don't need to know about each other.
export const mentionPageConfig = {
  linkedWidget: { getMenus: getMenusWithMentions },
}
