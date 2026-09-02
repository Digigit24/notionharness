import { type ExtensionType } from '@/lib/blocksuite-block-std'
import { InlineSpecExtension } from '@/lib/blocksuite-affine-components'
import { html } from 'lit'
import { getMenusWithMentions } from './menu'
import { MentionAttributeSchema } from './schema'

const MentionInlineSpecExtension = InlineSpecExtension({
  name: 'mention',
  // This app depends on zod v4 directly, but BlockSuite's own nested zod dep
  // is v3 (its `InlineSpecs.schema` type is v3's `ZodTypeAny`) — the runtime
  // `.parse()`/`.catch()` API used here is stable across both major versions,
  // so this is a type-only cast, not a behavior workaround.
  schema: MentionAttributeSchema as unknown as never,
  match: (delta) => !!delta.attributes?.mention,
  renderer: ({ delta }) => html`<affine-mention .delta=${delta}></affine-mention>`,
  embed: true,
})

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
