import { BlockComponent } from '@blocksuite/block-std'
import { html } from 'lit'
import type { TeableDatabaseBlockModel } from './schema'
import { smallButtonClass, type ConnectionOption, type TeableViewController, type TeableViewHost } from './teable-types'
import { TableViewController } from './table-view'
import { CalendarViewController } from './calendar-view'
import { KanbanViewController } from './kanban-view'
import { openRecordDetail as showRecordDetail, closeRecordDetail } from './record-detail-bridge'

type ViewTabKey = 'table' | 'kanban' | 'calendar'

interface TeableViewMeta {
  id: string
  type: string
}

const VIEW_TABS: Array<{ key: ViewTabKey; label: string; teableType: 'grid' | 'kanban' | 'calendar' }> = [
  { key: 'table', label: 'Table', teableType: 'grid' },
  { key: 'kanban', label: 'Kanban', teableType: 'kanban' },
  { key: 'calendar', label: 'Calendar', teableType: 'calendar' },
]

/**
 * Shell for a connected Teable table: connect/create flow, a view-switcher
 * (Table/Kanban/Calendar tabs, each backed by a real Teable view row — see
 * `_ensureTeableView`), and delegates the active tab's rendering to a
 * per-view controller (`TableViewController` for Table; Kanban/Calendar
 * render a placeholder until their own controllers land — add
 * `kanban-view.ts`/`calendar-view.ts` implementing `TeableViewController`
 * from `./teable-types` and wire them into `_activateView` below, without
 * touching `table-view.ts`).
 *
 * Renders as a plain custom element in the light DOM (no shadow root), so
 * the app's global Tailwind stylesheet applies directly.
 */
export class TeableDatabaseBlockComponent extends BlockComponent<TeableDatabaseBlockModel> implements TeableViewHost {
  private _connecting = false
  private _connections: ConnectionOption[] = []
  private _creatingTable = false
  private _newTableName = ''
  private _loading = false
  private _error: string | null = null
  private _tableName: string | null = null
  private _teableTableId: string | null = null
  private _viewController: TeableViewController | null = null
  private _onDocPointerDown = (e: PointerEvent) => {
    if (!this.contains(e.target as Node)) this._viewController?.closePopovers?.()
  }

  override connectedCallback() {
    super.connectedCallback()
    this.contentEditable = 'false'
    document.addEventListener('pointerdown', this._onDocPointerDown)
    if (this.model.teableDatabaseId !== null) void this._loadConnectedTable()
  }

  override disconnectedCallback() {
    super.disconnectedCallback()
    document.removeEventListener('pointerdown', this._onDocPointerDown)
    this._viewController?.dispose()
    closeRecordDetail()
  }

  private get _workspaceId(): string | null {
    return this.closest('[data-workspace-id]')?.getAttribute('data-workspace-id') ?? null
  }

  // --- TeableViewHost -----------------------------------------------------
  // `requestUpdate()` is inherited from `BlockComponent`/`ReactiveElement`.

  openRecordDetail(recordId: string) {
    if (!this._teableTableId) return
    const tableId = this._teableTableId
    showRecordDetail({
      teableTableId: tableId,
      recordId,
      onUpdated: () => {
        if (this._viewController instanceof TableViewController) void this._viewController.refreshRecord(recordId)
      },
    })
  }

  // --- connect / create flow ----------------------------------------------

  private async _openConnect() {
    this._connecting = true
    this._creatingTable = false
    this._error = null
    this.requestUpdate()
    try {
      const res = await fetch(`/api/teable-databases?workspaceId=${this._workspaceId ?? ''}`)
      const json = await res.json()
      this._connections = json.docs ?? []
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Could not load connections.'
    } finally {
      this.requestUpdate()
    }
  }

  private _openCreateTable() {
    this._creatingTable = true
    this._newTableName = ''
    this.requestUpdate()
  }

  private async _submitCreateTable() {
    const workspaceId = this._workspaceId
    if (!this._newTableName.trim() || !workspaceId) return
    this._loading = true
    this._error = null
    this.requestUpdate()
    try {
      const res = await fetch('/api/teable/create-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this._newTableName.trim(), workspaceId: Number(workspaceId) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create table.')
      this._creatingTable = false
      this._selectConnection(json.doc)
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to create table.'
      this._loading = false
      this.requestUpdate()
    }
  }

  private _selectConnection(conn: ConnectionOption) {
    this.doc.updateBlock(this.model, { teableDatabaseId: conn.id })
    this._connecting = false
    this._tableName = conn.name
    this._teableTableId = conn.teableTableId
    this._error = null
    void this._activateView(this.model.activeView)
  }

  private async _loadConnectedTable() {
    const id = this.model.teableDatabaseId
    if (id === null) return
    this._loading = true
    this._error = null
    this.requestUpdate()
    try {
      const connRes = await fetch(`/api/teable-databases/${id}`)
      const connJson = await connRes.json()
      if (!connRes.ok) throw new Error(connJson.error || 'Connection not found.')
      this._tableName = connJson.doc.name
      this._teableTableId = connJson.doc.teableTableId
      await this._activateView(this.model.activeView)
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load the Teable table.'
      this._loading = false
      this.requestUpdate()
    }
  }

  // --- view-switcher --------------------------------------------------------

  private _switchView(tab: ViewTabKey) {
    if (this.model.activeView === tab) return
    this.doc.updateBlock(this.model, { activeView: tab })
    void this._activateView(tab)
  }

  /** Ensures a real Teable view backs `tab`, and wires up (or tears down) that tab's controller. */
  private async _activateView(tab: ViewTabKey) {
    const meta = VIEW_TABS.find((t) => t.key === tab)!
    void this._ensureTeableView(meta.teableType)

    this._viewController?.dispose()
    this._viewController =
      tab === 'table' && this._teableTableId
        ? new TableViewController(this, this._teableTableId)
        : tab === 'calendar' && this._teableTableId
          ? new CalendarViewController(this, this._teableTableId)
          : tab === 'kanban' && this._teableTableId
            ? new KanbanViewController(this, this._teableTableId)
            : null

    if (this._viewController) {
      await this._viewController.refresh()
    }
    this._loading = false
    this.requestUpdate()
  }

  /** Creates a Teable view of `teableType` for the connected table if one doesn't already exist. */
  private async _ensureTeableView(teableType: 'grid' | 'kanban' | 'calendar') {
    if (!this._teableTableId) return
    try {
      const res = await fetch(`/api/teable/tables/${this._teableTableId}/views`)
      const views: TeableViewMeta[] = res.ok ? await res.json() : []
      if (Array.isArray(views) && views.some((v) => v.type === teableType)) return
      const label = teableType === 'grid' ? 'Table' : teableType === 'kanban' ? 'Kanban' : 'Calendar'
      await fetch(`/api/teable/tables/${this._teableTableId}/views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: label, type: teableType }),
      })
    } catch {
      // Non-fatal — the tab still renders (grid data comes from table-level
      // endpoints regardless; Kanban/Calendar show their placeholder either way).
    }
  }

  // --- render ---------------------------------------------------------------

  override renderBlock() {
    if (this._connecting) return this._renderPicker()
    if (this.model.teableDatabaseId === null) return this._renderPlaceholder()
    if (this._loading && !this._viewController) return this._renderLoading()
    if (this._error && !this._teableTableId) return this._renderErrorState()
    return this._renderShell()
  }

  private _renderPlaceholder() {
    return html`
      <div
        class="my-2 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-black/15 px-3 py-2.5 text-sm text-black/50 hover:bg-black/[.03] dark:border-white/15 dark:text-white/50 dark:hover:bg-white/[.04]"
        @click=${() => this._openConnect()}
      >
        <span>🗂️</span>
        <span>Connect a Teable table…</span>
      </div>
    `
  }

  private _renderLoading() {
    return html`<div class="my-2 rounded-lg border border-black/10 px-3 py-2.5 text-sm text-black/40 dark:border-white/10 dark:text-white/40">
      Loading Teable table…
    </div>`
  }

  private _renderErrorState() {
    return html`
      <div
        class="my-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-400"
      >
        <span>${this._error}</span>
        <div class="flex shrink-0 gap-1">
          <button type="button" class="rounded px-2 py-1 text-xs hover:bg-red-100 dark:hover:bg-red-950/40" @click=${() => this._loadConnectedTable()}>
            Retry
          </button>
          <button type="button" class="rounded px-2 py-1 text-xs hover:bg-red-100 dark:hover:bg-red-950/40" @click=${() => this._openConnect()}>
            Change table
          </button>
        </div>
      </div>
    `
  }

  private _renderPicker() {
    return html`
      <div class="my-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/10">
        <div class="mb-2 font-medium">Connect a Teable table</div>
        ${this._error ? html`<div class="mb-2 text-xs text-red-600 dark:text-red-400">${this._error}</div>` : null}
        ${this._connections.length
          ? this._connections.map(
              (c) =>
                html`<button
                  type="button"
                  class="block w-full truncate rounded px-2 py-1 text-left hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                  @click=${() => this._selectConnection(c)}
                >
                  ${c.name}
                </button>`,
            )
          : html`<div class="px-2 py-1 text-xs text-black/40 dark:text-white/40">No Teable tables connected to this workspace yet.</div>`}
        ${this._creatingTable
          ? html`
              <div class="mt-2 flex items-center gap-2 border-t border-black/10 pt-2 dark:border-white/10">
                <input
                  placeholder="New table name"
                  class="min-w-0 flex-1 rounded border border-black/10 bg-transparent px-2 py-1 text-xs outline-none dark:border-white/10"
                  .value=${this._newTableName}
                  @input=${(e: Event) => {
                    this._newTableName = (e.target as HTMLInputElement).value
                  }}
                />
                <button type="button" class="rounded bg-black/[.06] px-2 py-1 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20" @click=${() => this._submitCreateTable()}>
                  Create
                </button>
              </div>
            `
          : html`
              <button
                type="button"
                class="mt-2 block w-full rounded px-2 py-1 text-left text-black/60 hover:bg-black/[.06] dark:text-white/60 dark:hover:bg-white/[.08]"
                @click=${() => this._openCreateTable()}
              >
                + Create new table
              </button>
            `}
        <button
          type="button"
          class="mt-2 text-xs text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60"
          @click=${() => {
            this._connecting = false
            this._creatingTable = false
            this.requestUpdate()
          }}
        >
          Cancel
        </button>
      </div>
    `
  }

  private _renderShell() {
    const active = this.model.activeView
    return html`
      <div class="my-2 overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
        <div
          class="flex items-center justify-between gap-2 border-b border-black/5 bg-black/[.02] px-3 py-1.5 text-xs font-medium text-black/60 dark:border-white/10 dark:bg-white/[.03] dark:text-white/60"
        >
          <span class="truncate">🗂️ ${this._tableName ?? 'Teable table'}</span>
          <button type="button" class=${smallButtonClass} @click=${() => this._openConnect()}>Change table</button>
        </div>
        <div class="flex items-center gap-3 border-b border-black/5 px-3 pt-1.5 dark:border-white/10">
          ${VIEW_TABS.map(
            (t) => html`
              <button
                type="button"
                class="border-b-2 pb-1.5 text-xs ${active === t.key
                  ? 'border-black/70 font-medium text-black/80 dark:border-white/70 dark:text-white/80'
                  : 'border-transparent text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60'}"
                @click=${() => this._switchView(t.key)}
              >
                ${t.label}
              </button>
            `,
          )}
        </div>
        ${active === 'table' || active === 'calendar' || active === 'kanban'
          ? (this._viewController?.render() ?? html`<div class="px-3 py-2.5 text-sm text-black/40 dark:text-white/40">Loading…</div>`)
          : html`<div class="px-3 py-8 text-center text-sm text-black/40 dark:text-white/40">
              ${VIEW_TABS.find((t) => t.key === active)?.label} view isn't built yet.
            </div>`}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-teable-database': TeableDatabaseBlockComponent
  }
}
