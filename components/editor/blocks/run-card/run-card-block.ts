import { BlockComponent } from '@/lib/blocksuite-block-std'
import { css, html } from 'lit'
import type { RunCardBlockModel } from './schema'

interface RunCardData {
  id: number
  status: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  stepCount: number
  chips: {
    files: string
    commands: string
    cost: string
  }
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const POLL_MS = 4000

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  dispatched: 'Starting…',
  running: 'Running',
  waiting_directory: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_COLOR: Record<string, string> = {
  queued: '#999',
  dispatched: '#d69c55',
  running: '#1e96eb',
  waiting_directory: '#d69c55',
  completed: '#2f6b41',
  failed: '#de5246',
  cancelled: '#999',
}

function formatElapsed(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return ''
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const start = new Date(startedAt).getTime()
  const minutes = Math.max(0, Math.round((end - start) / 60000))
  return `${minutes}m`
}

/**
 * ROADMAP 6.3 — a lightweight, read-only, non-editable reference embed (no
 * child content, no DataView) that polls `GET /api/runs/{id}` for a run's
 * live status/cost/step-count while it's non-terminal, and stops polling
 * once it settles (a finished run's status never changes again). Originally
 * had no slash-menu entry (there was no "assign work to an agent" flow to
 * produce a real run id to hand-type) — B3.5's `/run` and `/summarise`
 * items (`components/editor/slash-commands/page-commands.ts`) and P6.2's
 * "Ask agent" (`agent-thread/block-anchored-thread.tsx`) now all insert one
 * programmatically after `enqueuePageRun` returns a real id.
 *
 * B3.4 — click-through to the trace: when the block sits inside an editor
 * whose container carries `data-workspace-slug` (set by `BlockSuiteEditor.tsx`
 * whenever a caller passes `workspaceSlug` — some embedding contexts, like
 * the record-detail drawer, don't), the whole card becomes a real link to
 * `/workspace/{slug}/runs/{id}/review`, the DetailLayout-based review page
 * (`app/(app)/workspace/[workspaceSlug]/runs/[runId]/review/page.tsx`).
 * Without a slug, it stays a plain non-interactive summary, same
 * "no-op when it isn't set" convention `native-database-block.ts`'s own
 * `_workspaceSlug` getter already established.
 */
export class RunCardBlockComponent extends BlockComponent<RunCardBlockModel> {
  static override styles = css`
    affine-run-card {
      display: block;
      margin: 4px 0;
    }
    .run-card {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--affine-border-color, rgba(0, 0, 0, 0.1));
      background: var(--affine-background-secondary-color, rgba(0, 0, 0, 0.03));
      font-size: 13px;
      cursor: default;
      user-select: none;
    }
    .run-card .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .run-card .sep {
      color: var(--affine-text-disable-color, #ccc);
    }
    .run-card.clickable {
      cursor: pointer;
      text-decoration: none;
      color: inherit;
    }
    .run-card.clickable:hover {
      background: var(--affine-hover-color, rgba(0, 0, 0, 0.06));
    }
  `

  private _data: RunCardData | null = null
  private _error: string | null = null
  private _pollTimer: ReturnType<typeof setTimeout> | null = null

  /** Same `data-workspace-slug` lookup `native-database-block.ts`'s own
   * `_workspaceSlug` getter uses — set on the editor's container in
   * `BlockSuiteEditor.tsx` only when a caller passes `workspaceSlug`. */
  private get _workspaceSlug(): string | null {
    return this.closest('[data-workspace-slug]')?.getAttribute('data-workspace-slug') ?? null
  }

  override connectedCallback() {
    super.connectedCallback()
    this.contentEditable = 'false'
    if (this.model.runId !== null) void this._load()
  }

  override disconnectedCallback() {
    super.disconnectedCallback()
    if (this._pollTimer) clearTimeout(this._pollTimer)
  }

  private async _load() {
    const runId = this.model.runId
    if (runId === null) return
    try {
      const res = await fetch(`/api/runs/${runId}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Run not found.')
      this._data = json
      this._error = null
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load run.'
    } finally {
      this.requestUpdate()
      if (this._data && !TERMINAL_STATUSES.has(this._data.status)) {
        this._pollTimer = setTimeout(() => void this._load(), POLL_MS)
      }
    }
  }

  override renderBlock() {
    if (this.model.runId === null) {
      return html`<div class="run-card"><span style="color:var(--affine-text-disable-color,#999)">No run linked</span></div>`
    }
    if (this._error) {
      return html`<div class="run-card"><span style="color:#de5246">${this._error}</span></div>`
    }
    if (!this._data) {
      return html`<div class="run-card"><span style="color:var(--affine-text-disable-color,#999)">Loading run…</span></div>`
    }
    const d = this._data
    const elapsed = formatElapsed(d.startedAt, d.completedAt)
    const body = html`
      <span class="dot" style="background:${STATUS_COLOR[d.status] ?? '#999'}"></span>
      <span>Run #${d.id}</span>
      <span class="sep">·</span>
      <span>${STATUS_LABEL[d.status] ?? d.status}</span>
      ${elapsed ? html`<span class="sep">·</span><span>${elapsed}</span>` : null}
      <span class="sep">·</span>
      <span>${d.stepCount} step${d.stepCount === 1 ? '' : 's'}</span>
      <span class="sep">·</span>
      <span>${d.chips.files}</span>
      <span class="sep">·</span>
      <span>${d.chips.commands}</span>
      <span class="sep">·</span>
      <span>${d.chips.cost}</span>
    `
    const slug = this._workspaceSlug
    if (!slug) return html`<div class="run-card">${body}</div>`
    return html`
      <a class="run-card clickable" href="/workspace/${slug}/runs/${d.id}/review" title="Open trace">${body}</a>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-run-card': RunCardBlockComponent
  }
}
