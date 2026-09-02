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
 * once it settles (a finished run's status never changes again). No slash-
 * menu entry yet, deliberately: there's no "assign work to an agent" flow
 * in this app to produce a real run id to reference (that's Pillar 3.5/5.x),
 * so hand-typing a raw id via slash-menu wouldn't be a real user flow — this
 * scaffolds the block type/schema/renderer so 6.1 ("agents write into the
 * page") or 6.2 (block-anchored threads) can insert one programmatically
 * once they exist, per the task's own "get the block types/schema right so
 * it's ready" framing.
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
  `

  private _data: RunCardData | null = null
  private _error: string | null = null
  private _pollTimer: ReturnType<typeof setTimeout> | null = null

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
    return html`
      <div class="run-card">
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
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-run-card': RunCardBlockComponent
  }
}
