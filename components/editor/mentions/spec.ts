import { ConfigExtension, type ExtensionType } from '@/lib/blocksuite-block-std'
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

// Overrides `affine:page`'s stock `getMenus`, which is otherwise the sole
// handler for the `@` trigger — see menu.ts for why this composes rather
// than replaces the existing "link to doc" behavior.
const MentionMenuConfigExtension = ConfigExtension('affine:page', {
  linkedWidget: { getMenus: getMenusWithMentions },
})

export const MentionSpec: ExtensionType[] = [MentionInlineSpecExtension, MentionMenuConfigExtension]
