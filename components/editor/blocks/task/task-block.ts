import { BlockComponent } from '@/lib/blocksuite-block-std'
import { css, html, type PropertyValues } from 'lit'
import { ref, createRef } from 'lit/directives/ref.js'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TaskBlockModel } from './schema'
import { TaskBlockView } from './task-block-view'

/**
 * ROADMAP B3.4 — Task block: a real, read-through/write-through reference
 * to a row in the `tasks` collection (see `schema.ts`'s "reference, never
 * container" comment). Mounts `TaskBlockView` (React) into a container Lit
 * manages via the `ref()` directive — same "React root inside a Lit-owned
 * `<div>`" recipe `record-detail-panel.ts`'s `reactSlot` established for
 * the native-database record drawer, just mounted once at block-render
 * time instead of per-drawer-open. Mounted once, not re-rendered on every
 * Lit update: `taskId` never changes after a block is created (same
 * assumption `run-card-block.ts` makes about `runId`), and `TaskBlockView`
 * owns its own live data via `getTask`/polling-free re-fetch on prop change.
 */
export class TaskBlockComponent extends BlockComponent<TaskBlockModel> {
  static override styles = css`
    affine-task-block {
      display: block;
      margin: 4px 0;
    }
  `

  private _containerRef = createRef<HTMLDivElement>()
  private _root: Root | null = null

  /** Same `data-workspace-slug` lookup `native-database-block.ts`'s own
   * `_workspaceSlug` getter and the run-card block use. */
  private get _workspaceSlug(): string | null {
    return this.closest('[data-workspace-slug]')?.getAttribute('data-workspace-slug') ?? null
  }

  override connectedCallback() {
    super.connectedCallback()
    this.contentEditable = 'false'
  }

  override disconnectedCallback() {
    super.disconnectedCallback()
    this._root?.unmount()
    this._root = null
  }

  override firstUpdated(changed: PropertyValues) {
    super.firstUpdated(changed)
    const taskId = this.model.taskId
    const el = this._containerRef.value
    if (taskId === null || !el) return
    this._root = createRoot(el)
    this._root.render(
      createElement(TaskBlockView, {
        taskId,
        workspaceSlug: this._workspaceSlug,
        onOpenTask: (id: number) => {
          const slug = this._workspaceSlug
          if (!slug) return
          window.location.href = `/workspace/${slug}/tasks?task=${id}`
        },
      }),
    )
  }

  override renderBlock() {
    if (this.model.taskId === null) {
      return html`<div style="font-size:13px;color:var(--affine-text-disable-color,#999)">No task linked</div>`
    }
    return html`<div ${ref(this._containerRef)}></div>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-task-block': TaskBlockComponent
  }
}
