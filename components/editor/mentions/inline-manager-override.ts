import type { ExtensionType } from '@/lib/blocksuite-block-std'
import { StdIdentifier } from '@/lib/blocksuite-block-std'
import {
  BackgroundInlineSpecExtension,
  BoldInlineSpecExtension,
  CodeInlineSpecExtension,
  ColorInlineSpecExtension,
  InlineManager,
  InlineManagerIdentifier,
  ItalicInlineSpecExtension,
  LatexInlineSpecExtension,
  LinkInlineSpecExtension,
  MarkdownMatcherIdentifier,
  ReferenceInlineSpecExtension,
  StrikeInlineSpecExtension,
  UnderlineInlineSpecExtension,
} from '@/lib/blocksuite-affine-components'
import { MentionInlineSpecExtension } from './spec'

// See spec.ts's own comment for the full diagnosis. Short version: BlockSuite
// builds the paragraph/list blocks' actual attribute validator from
// `DefaultInlineManagerExtension`'s hardcoded `specs: [...]` list (@blocksuite/
// affine-components/rich-text/all-extensions.ts), not from every registered
// `InlineSpecExtension` — registering `MentionInlineSpecExtension` on its own
// makes it discoverable by id but never gets it INTO that list, so every
// mention insert failed zod validation ("expected never, received object")
// even though the `@` popover itself worked. This re-registers the exact
// same identifier with the same built-in specs plus ours, using `di.override`
// (not `di.addImpl`, which throws `DuplicateServiceDefinitionError` for an
// identifier that's already registered — and `DefaultInlineManagerExtension`
// always is, via PageEditorBlockSpecs).
const DEFAULT_INLINE_MANAGER_ID = 'DefaultInlineManager'

export const MentionAwareDefaultInlineManagerExtension: ExtensionType = {
  setup: (di) => {
    di.override(InlineManagerIdentifier(DEFAULT_INLINE_MANAGER_ID), (provider) => {
      return new InlineManager(
        provider.get(StdIdentifier),
        Array.from(provider.getAll(MarkdownMatcherIdentifier).values()),
        provider.get(BoldInlineSpecExtension.identifier),
        provider.get(ItalicInlineSpecExtension.identifier),
        provider.get(UnderlineInlineSpecExtension.identifier),
        provider.get(StrikeInlineSpecExtension.identifier),
        provider.get(CodeInlineSpecExtension.identifier),
        provider.get(BackgroundInlineSpecExtension.identifier),
        provider.get(ColorInlineSpecExtension.identifier),
        provider.get(LatexInlineSpecExtension.identifier),
        provider.get(ReferenceInlineSpecExtension.identifier),
        provider.get(LinkInlineSpecExtension.identifier),
        provider.get(MentionInlineSpecExtension.identifier),
      )
    })
  },
}
