import { ShadowlessElement } from '@/lib/blocksuite-block-std'
import { WithDisposable } from '@/lib/blocksuite-global'
import { type DeltaInsert, ZERO_WIDTH_NON_JOINER, ZERO_WIDTH_SPACE } from '@/lib/blocksuite-inline'
import { css, html, nothing } from 'lit'
import type { AffineTextAttributes } from '@/lib/blocksuite-affine-shared'

// ROADMAP 6.3 audit — keep mentions inline (not a block): matches real
// Notion UX, and migrating a persisted inline delta to a block flavour is
// real migration risk for a cosmetic win. This only adds a render-time
// live-status dot for `kind: 'agent'` mentions; the persisted delta/mention
// shape and the markdown serializer are untouched.
const AGENT_STATUS_POLL_MS = 4000

// Non-interactive v1 chip: renders "@Name" inline. No click/hover popup yet —
// that's a reasonable follow-up, not a blocker for mentions to exist at all.
export class AffineMention extends WithDisposable(ShadowlessElement) {
  // Plain (non-decorator) reactive-property declaration — this app's build
  // doesn't support the `@property()` + `accessor` combo BlockSuite's own
  // (separately pre-built) components use, so match this codebase's existing
  // no-decorator Lit convention instead (see native-database-block.ts).
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
    .affine-mention.agent {
      color: #7c3aed;
      background: rgba(124, 58, 237, 0.1);
    }
    .affine-mention .live-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-right: 3px;
      border-radius: 999px;
      background: #1e96eb;
      animation: affine-mention-pulse 1.2s ease-in-out infinite;
    }
    @keyframes affine-mention-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.3;
      }
    }
  `

  private _agentActive = false
  private _pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super()
    this.delta = { insert: ZERO_WIDTH_SPACE, attributes: {} }
  }

  override connectedCallback() {
    super.connectedCallback()
    const mention = this.delta.attributes?.mention
    if (mention?.kind === 'agent') void this._pollAgentStatus(mention.userId)
  }

  override disconnectedCallback() {
    super.disconnectedCallback()
    if (this._pollTimer) clearTimeout(this._pollTimer)
  }

  // Same run-status source the run-card block polls (`runs.status` via a
  // small API route), just keyed by agent id instead of run id — a mention
  // has no specific run to reference, only "is this agent doing something
  // right now." Polls for as long as the chip stays mounted rather than
  // stopping on a terminal state, since the agent's next run could start at
  // any time while the page is open.
  private async _pollAgentStatus(agentId: string) {
    try {
      const res = await fetch(`/api/agents/${agentId}/active-run`)
      const data = res.ok ? ((await res.json()) as { active: boolean }) : { active: false }
      this._agentActive = data.active
    } catch {
      this._agentActive = false
    } finally {
      this.requestUpdate()
      this._pollTimer = setTimeout(() => void this._pollAgentStatus(agentId), AGENT_STATUS_POLL_MS)
    }
  }

  override render() {
    const mention = this.delta.attributes?.mention
    if (!mention) return nothing

    // See reference-node.ts: an embed inline element needs a zero-width
    // joiner v-text child so BlockSuite's inline-range math stays correct.
    const isAgent = mention.kind === 'agent'
    return html`<span class="affine-mention ${isAgent ? 'agent' : ''}"
      >${isAgent && this._agentActive ? html`<span class="live-dot" title="Currently running"></span>` : nothing}${isAgent
        ? '@🤖 '
        : '@'}${mention.name}<v-text .str=${ZERO_WIDTH_NON_JOINER}></v-text
    ></span>`
  }
}
