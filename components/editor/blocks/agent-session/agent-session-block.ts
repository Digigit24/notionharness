import { BlockComponent } from '@/lib/blocksuite-block-std'
import { css, html, type PropertyValues } from 'lit'
import { ref, createRef } from 'lit/directives/ref.js'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentSessionBlockModel } from './schema'
import { AgentSessionBlockView } from './agent-session-block-view'

/**
 * The Lit shell for the in-page agent conversation.
 *
 * Follows the recipe `task-block.ts` established: a React root mounted into a
 * container Lit owns via `ref()`, unmounted in `disconnectedCallback`.
 *
 * One deliberate difference from the task block. That one mounts once and
 * never re-renders, because its `taskId` never changes after creation. This
 * block's `sessionId` genuinely does change exactly once — a block inserted
 * by an `@` mention has no session until the first message creates one — so
 * the React tree is re-rendered when the model updates. Everything after
 * that first transition is handled inside React, not by remounting.
 */
export class AgentSessionBlockComponent extends BlockComponent<AgentSessionBlockModel> {
  static override styles = css`
    notionforge-agent-session-block {
      display: block;
      margin: 8px 0;
    }
  `

  private _containerRef = createRef<HTMLDivElement>()
  private _root: Root | null = null

  /** Same `data-workspace-slug` / `data-workspace-id` lookup every other
   * custom block in this editor uses to find its workspace context. */
  private get _workspaceSlug(): string | null {
    return this.closest('[data-workspace-slug]')?.getAttribute('data-workspace-slug') ?? null
  }

  private get _workspaceId(): number | null {
    const raw = this.closest('[data-workspace-id]')?.getAttribute('data-workspace-id')
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  override connectedCallback() {
    super.connectedCallback()
    // The conversation owns its own input; the page's editor must not treat
    // this subtree as editable text.
    this.contentEditable = 'false'
  }

  override disconnectedCallback() {
    super.disconnectedCallback()
    this._root?.unmount()
    this._root = null
  }

  override firstUpdated(changed: PropertyValues) {
    super.firstUpdated(changed)
    this._mount()
  }

  override updated(changed: PropertyValues) {
    super.updated(changed)
    this._mount()
  }

  private _mount() {
    const el = this._containerRef.value
    if (!el) return
    const workspaceId = this._workspaceId
    const workspaceSlug = this._workspaceSlug
    if (workspaceId === null || !workspaceSlug) return

    if (!this._root) this._root = createRoot(el)
    this._root.render(
      createElement(AgentSessionBlockView, {
        workspaceId,
        workspaceSlug,
        sessionId: this.model.sessionId,
        agentId: this.model.agentId,
        collapsed: this.model.collapsed,
        // Writing back through the model is what makes the binding durable:
        // the session id lives in the document, so the page holds this
        // conversation for good, on every device that opens it.
        onSessionCreated: (sessionId: number) => {
          this.doc.updateBlock(this.model, { sessionId })
        },
        onCollapsedChange: (collapsed: boolean) => {
          this.doc.updateBlock(this.model, { collapsed })
        },
      }),
    )
  }

  override renderBlock() {
    return html`<div ${ref(this._containerRef)}></div>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'notionforge-agent-session-block': AgentSessionBlockComponent
  }
}
