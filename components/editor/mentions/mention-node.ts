import { ShadowlessElement } from '@/lib/blocksuite-block-std'
import { WithDisposable } from '@/lib/blocksuite-global'
import { type DeltaInsert, ZERO_WIDTH_NON_JOINER, ZERO_WIDTH_SPACE } from '@/lib/blocksuite-inline'
import { css, html, nothing } from 'lit'
import type { AffineTextAttributes } from '@/lib/blocksuite-affine-shared'
import {
  openAgentSessionBlock,
  type AgentSessionDocLike,
} from '@/components/editor/blocks/agent-session/open-session-block'

// ROADMAP 6.3 audit — keep mentions inline (not a block): matches real
// Notion UX, and migrating a persisted inline delta to a block flavour is
// real migration risk for a cosmetic win. This only adds a render-time
// live-status dot for `kind: 'agent'` mentions; the persisted delta/mention
// shape and the markdown serializer are untouched.
const AGENT_STATUS_POLL_MS = 4000



// An agent mention is now interactive: clicking it starts (or reveals) an
// agent conversation on this page, rendered as a `notionforge:agent-session`
// block right after the paragraph the mention sits in. That is the whole
// point of mentioning an agent in a document — before this, the chip was a
// coloured span that did nothing, and the only way to talk to an agent was
// to leave the page.
//
// Person and page mentions stay inert, unchanged.
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
    .affine-mention.clickable {
      cursor: pointer;
    }
    .affine-mention.clickable:hover {
      background: rgba(124, 58, 237, 0.2);
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

  /**
   * Opens this agent's conversation on the page.
   *
   * Reveals an existing session block for the same agent if one is already
   * here — mentioning an agent twice in a document means one conversation,
   * not two — and otherwise inserts a fresh one directly after the paragraph
   * containing the mention, so the chat appears exactly where it was asked
   * for.
   */
  private _openConversation(agentId: number) {
    const host = this.closest('editor-host') as
      | (HTMLElement & { doc?: AgentSessionDocLike })
      | null
    const doc = host?.doc
    if (!doc) return
    openAgentSessionBlock({
      doc,
      anchorBlockId: this.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
      agentId,
      scrollTarget: host,
    })
  }

  override render() {
    const mention = this.delta.attributes?.mention
    if (!mention) return nothing

    // See reference-node.ts: an embed inline element needs a zero-width
    // joiner v-text child so BlockSuite's inline-range math stays correct.
    const isAgent = mention.kind === 'agent'
    const agentId = isAgent ? Number(mention.userId) : Number.NaN
    const clickable = isAgent && Number.isFinite(agentId)
    return html`<span
      class="affine-mention ${isAgent ? 'agent' : ''} ${clickable ? 'clickable' : ''}"
      title=${clickable ? `Open a conversation with ${mention.name} on this page` : ''}
      @click=${clickable
        ? (event: MouseEvent) => {
            // The chip lives inside editable text; without this the click
            // just places a caret.
            event.preventDefault()
            event.stopPropagation()
            this._openConversation(agentId)
          }
        : nothing}
      >${isAgent && this._agentActive ? html`<span class="live-dot" title="Currently running"></span>` : nothing}${isAgent
        ? '@🤖 '
        : '@'}${mention.name}<v-text .str=${ZERO_WIDTH_NON_JOINER}></v-text
    ></span>`
  }
}
