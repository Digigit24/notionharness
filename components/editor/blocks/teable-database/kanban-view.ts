import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { html } from 'lit'
import { KanbanBoard } from '@/components/database/kanban-board'
import type { TeableField, TeableRecord, TeableViewController, TeableViewHost } from './teable-types'

/**
 * Kanban view: cards grouped into columns by a singleSelect field (preferring
 * one named "Status"), drag-and-drop between columns via `@dnd-kit/core`.
 *
 * `@dnd-kit/core`'s `DndContext`/`useDraggable`/`useDroppable` are React
 * primitives — they can't be driven from a lit `html` template the way
 * `table-view.ts`/`calendar-view.ts` render. Instead this controller owns the
 * fetch/loading/error lifecycle (same shape as the other view controllers)
 * and, once data is ready, mounts a self-contained `KanbanBoard` React island
 * into a persistent container `div` via `react-dom/client` — the same
 * bridging technique `record-detail-bridge.ts` uses for the record-detail
 * popover, just mounted inline (returned from `render()`) instead of appended
 * to `document.body`. `KanbanBoard` owns its own optimistic drag/patch state
 * internally; this controller only re-renders the island on the initial
 * successful load, not on every host `requestUpdate()`.
 */
export class KanbanViewController implements TeableViewController {
  private _fields: TeableField[] = []
  private _records: TeableRecord[] = []
  private _loading = false
  private _error: string | null = null
  private _viewId: string | null = null
  private _filterField = ''
  private _filterValue = ''
  private readonly _container: HTMLDivElement
  private readonly _root: Root

  constructor(
    private readonly _host: TeableViewHost,
    private readonly _teableTableId: string,
  ) {
    this._container = document.createElement('div')
    this._root = createRoot(this._container)
  }

  dispose() {
    this._root.unmount()
  }

  async refresh() {
    this._loading = true
    this._error = null
    this._renderIsland()
    this._host.requestUpdate()
    try {
      const viewsRes = await fetch(`/api/teable/tables/${this._teableTableId}/views`)
      const views = (await viewsRes.json().catch(() => [])) as Array<{ id: string; type?: string }>
      this._viewId = views.find((v) => v.type === 'kanban')?.id ?? views[0]?.id ?? null
      const [fieldsRes, recordsRes] = await Promise.all([
        fetch(`/api/teable/tables/${this._teableTableId}/fields`),
        fetch(`/api/teable/tables/${this._teableTableId}/records${this._viewId ? `?viewId=${encodeURIComponent(this._viewId)}` : ''}`),
      ])
      const fieldsJson = await fieldsRes.json()
      const recordsJson = await recordsRes.json()
      if (!fieldsRes.ok) throw new Error(fieldsJson.error || 'Failed to load properties.')
      if (!recordsRes.ok) throw new Error(recordsJson.error || 'Failed to load rows.')
      this._fields = Array.isArray(fieldsJson) ? fieldsJson : []
      this._records = Array.isArray(recordsJson.records) ? recordsJson.records : []
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load the Teable table.'
    } finally {
      this._loading = false
      this._renderIsland()
      this._host.requestUpdate()
    }
  }

  render(): unknown {
    if (this._loading) return this._container
    return html`<div>${this._renderFilterControls()}${this._container}</div>`
  }

  /** Filter-only toolbar, matching `table-view.ts`'s `_renderViewControls()` pattern (field + value
   * select, PATCHed onto this tab's own Teable view). Sort doesn't apply to a grouping-based layout. */
  private _renderFilterControls() {
    if (!this._viewId) return null
    return html`<div
      class="flex items-center gap-1 border-b border-black/5 bg-black/[.02] px-3 py-1 dark:border-white/10 dark:bg-white/[.03]"
    >
      <select
        class="rounded border border-black/10 bg-transparent px-1 py-0.5 text-[11px] dark:border-white/10 dark:bg-[#2f2f2f]"
        .value=${this._filterField}
        @change=${(e: Event) => {
          this._filterField = (e.target as HTMLSelectElement).value
          void this._persistView(
            'filter',
            this._filterField ? { conjunction: 'and', filterSet: [{ fieldId: this._filterField, operator: 'is', value: this._filterValue }] } : null,
          )
        }}
      >
        <option value="">Filter…</option>
        ${this._fields.map((field) => html`<option value=${field.id}>${field.name}</option>`)}
      </select>
      <input
        class="w-20 rounded border border-black/10 bg-transparent px-1 py-0.5 text-[11px] dark:border-white/10"
        placeholder="Value"
        .value=${this._filterValue}
        @change=${(e: Event) => {
          this._filterValue = (e.target as HTMLInputElement).value
          if (this._filterField) {
            void this._persistView('filter', { conjunction: 'and', filterSet: [{ fieldId: this._filterField, operator: 'is', value: this._filterValue }] })
          }
        }}
      />
    </div>`
  }

  private async _persistView(resource: string, value: unknown) {
    if (!this._viewId) return
    const response = await fetch(`/api/teable/tables/${this._teableTableId}/views/${this._viewId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource, value }),
    })
    if (response.ok) await this.refresh()
  }

  private _groupingField(): TeableField | null {
    const singleSelects = this._fields.filter((f) => f.type === 'singleSelect')
    if (singleSelects.length === 0) return null
    return singleSelects.find((f) => f.name.toLowerCase() === 'status') ?? singleSelects[0]
  }

  /** Renders the React island once data is settled — never while `_loading`, so `KanbanBoard`'s
   * internal optimistic state (seeded once from props on mount) is always seeded with real data. */
  private _renderIsland() {
    if (this._loading) {
      this._root.render(createElement('div', { className: 'px-3 py-2.5 text-sm text-black/40 dark:text-white/40' }, 'Loading Teable table…'))
      return
    }
    if (this._error) {
      this._root.render(
        createElement(
          'div',
          { className: 'px-3 py-2.5 text-sm text-red-600 dark:text-red-400' },
          this._error,
        ),
      )
      return
    }
    const groupingField = this._groupingField()
    if (!groupingField) {
      this._root.render(
        createElement(
          'div',
          { className: 'px-3 py-8 text-center text-sm text-black/40 dark:text-white/40' },
          'Add a Select property (e.g. "Status") in Table view to group cards here.',
        ),
      )
      return
    }
    this._root.render(
      createElement(KanbanBoard, {
        teableTableId: this._teableTableId,
        fields: this._fields,
        records: this._records,
        groupingField,
        onOpenRecord: (recordId: string) => this._host.openRecordDetail(recordId),
      }),
    )
  }
}
