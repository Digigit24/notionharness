import { ShadowlessElement } from '@/lib/blocksuite-block-std'
import { WithDisposable } from '@/lib/blocksuite-global'
import { type DeltaInsert, ZERO_WIDTH_NON_JOINER, ZERO_WIDTH_SPACE } from '@/lib/blocksuite-inline'
import { css, html, nothing } from 'lit'
import type { AffineTextAttributes } from '@/lib/blocksuite-affine-shared'

// Non-interactive v1 chip: renders "@Name" inline. No click/hover popup yet —
// that's a reasonable follow-up, not a blocker for mentions to exist at all.
export class AffineMention extends WithDisposable(ShadowlessElement) {
  // Plain (non-decorator) reactive-property declaration — this app's build
  // doesn't support the `@property()` + `accessor` combo BlockSuite's own
  // (separately pre-built) components use, so match this codebase's existing
  // no-decorator Lit convention instead (see teable-native-block.ts).
  static override properties = {
    delta: { type: Object },
  }

  declare delta: DeltaInsert<AffineTextAttributes>

  static override styles = css`
    .affine-mention {
      display: inline-block;
      border-radius: 4px;
      padding: 1px 4px;
      color: var(--affine-text-primary-color, #1e96eb);
      background: var(--affine-hover-color, rgba(30, 150, 235, 0.1));
      white-space: nowrap;
    }
  `

  constructor() {
    super()
    this.delta = { insert: ZERO_WIDTH_SPACE, attributes: {} }
  }

  override render() {
    const mention = this.delta.attributes?.mention
    if (!mention) return nothing

    // See reference-node.ts: an embed inline element needs a zero-width
    // joiner v-text child so BlockSuite's inline-range math stays correct.
    return html`<span class="affine-mention">@${mention.name}<v-text .str=${ZERO_WIDTH_NON_JOINER}></v-text
    ></span>`
  }
}
