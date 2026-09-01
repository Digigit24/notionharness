import { html } from 'lit'
import {
  colorClasses,
  smallButtonClass,
  type TeableField,
  type TeableRecord,
  type TeableViewController,
  type TeableViewHost,
} from './teable-types'

/**
 * Calendar view: a standard month grid (7×6) with one chip per record on its
 * date-field value. Driven by the first `date`-type field on the connected
 * Teable table (e.g. "Due Date" on the seeded Projects/Tasks tables). Month
 * navigation via prev/next + a "Today" button; clicking a chip opens the
 * shared record-detail popover through `host.openRecordDetail()`.
 *
 * One record → at most one chip per day on that record's single date value;
 * multi-day/date ranges are out of scope per the master plan (a record whose
 * date value is missing or unparseable is simply not rendered).
 *
 * Multi-record days cap visible chips at 3 with a "+N more" overflow indicator
 * that expands the day in place.
 */
export class CalendarViewController implements TeableViewController {
  private _fields: TeableField[] = []
  private _records: TeableRecord[] = []
  private _loading = false
  private _error: string | null = null
  private _dateField: TeableField | null = null
  private _viewId: string | null = null
  private _filterField = ''
  private _filterValue = ''

  private readonly _today = new Date()
  private _viewYear = this._today.getFullYear()
  private _viewMonth = this._today.getMonth()
  private _expandedDayKey: string | null = null

  constructor(
    private readonly _host: TeableViewHost,
    private readonly _teableTableId: string,
  ) {}

  dispose() {
    this.closePopovers()
  }

  closePopovers() {
    if (this._expandedDayKey === null) return
    this._expandedDayKey = null
    this._host.requestUpdate()
  }

  async refresh() {
    this._loading = true
    this._error = null
    this._host.requestUpdate()
    try {
      const viewsRes = await fetch(`/api/teable/tables/${this._teableTableId}/views`)
      const views = await viewsRes.json().catch(() => []) as Array<{ id: string; type?: string }>
      this._viewId = views.find((view) => view.type === 'calendar')?.id ?? views[0]?.id ?? null
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
      this._dateField = this._pickDateField(this._fields)
      if (!this._dateField) {
        this._error = 'No date field on this table — add a Date property to use Calendar view.'
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load the Teable table.'
    } finally {
      this._loading = false
      this._host.requestUpdate()
    }
  }

  /** Re-fetches a single record (e.g. after the record-detail popover reports an edit). */
  async refreshRecord(recordId: string) {
    if (!this._dateField) return
    try {
      const res = await fetch(`/api/teable/tables/${this._teableTableId}/records/${recordId}`)
      if (!res.ok) return
      const updated: TeableRecord = await res.json()
      this._records = this._records.map((r) => (r.id === recordId ? updated : r))
      this._host.requestUpdate()
    } catch {
      // best-effort; the popover already reflects its own edits
    }
  }

  private _pickDateField(fields: TeableField[]): TeableField | null {
    return fields.find((f) => f.type === 'date') ?? null
  }

  // --- view-scoped filter (Teable view sub-resource, same pattern as Table view) ---

  private _renderViewControls() {
    if (!this._viewId) return null
    return html`
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
    `
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

  // --- month navigation ---------------------------------------------------

  private _shiftMonth(delta: number) {
    const next = new Date(this._viewYear, this._viewMonth + delta, 1)
    this._viewYear = next.getFullYear()
    this._viewMonth = next.getMonth()
    this._expandedDayKey = null
    this._host.requestUpdate()
  }

  private _goToToday() {
    this._viewYear = this._today.getFullYear()
    this._viewMonth = this._today.getMonth()
    this._expandedDayKey = null
    this._host.requestUpdate()
  }

  // --- date helpers -------------------------------------------------------

  /** Local-date key (YYYY-MM-DD) used to bucket records by day cell. */
  private _dateKey(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null
    // Teable stores dates as ISO strings (verified via the table-view's date
    // input handler: `value.slice(0, 10)`); treat the first 10 chars as the
    // local date portion regardless of trailing TZ.
    const head = value.slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null
  }

  /** Returns the 6×7 grid of date keys for the current view month. */
  private _buildGridDays(): string[] {
    const firstOfMonth = new Date(this._viewYear, this._viewMonth, 1)
    // Sunday-first week so it matches the Notion-style convention used elsewhere.
    const startOffset = firstOfMonth.getDay()
    const gridStart = new Date(this._viewYear, this._viewMonth, 1 - startOffset)
    const days: string[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      days.push(`${y}-${m}-${day}`)
    }
    return days
  }

  // --- render -------------------------------------------------------------

  render() {
    if (this._loading) {
      return html`<div class="px-3 py-2.5 text-sm text-black/40 dark:text-white/40">Loading Teable table…</div>`
    }
    return html`
      <div class="flex items-center justify-between gap-2 border-b border-black/5 bg-black/[.02] px-3 py-1.5 dark:border-white/10 dark:bg-white/[.03]">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class=${smallButtonClass}
            title="Previous month"
            @click=${() => this._shiftMonth(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            class=${smallButtonClass}
            title="Next month"
            @click=${() => this._shiftMonth(1)}
          >
            ›
          </button>
          <button type="button" class=${smallButtonClass} @click=${() => this._goToToday()}>Today</button>
        </div>
        <div class="text-xs font-medium text-black/70 dark:text-white/70">
          ${this._monthLabel(this._viewYear, this._viewMonth)}
        </div>
        <div class="flex items-center gap-1">${this._renderViewControls()}</div>
      </div>
      ${this._error
        ? html`<div class="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
            ${this._error}
          </div>`
        : null}
      ${this._dateField ? this._renderGrid() : null}
    `
  }

  private _monthLabel(year: number, month: number): string {
    return new Date(year, month, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' })
  }

  private _renderGrid() {
    const days = this._buildGridDays()
    const todayKey = this._dateKey(this._today.toISOString()) ?? ''
    const monthStart = new Date(this._viewYear, this._viewMonth, 1)
    const monthEnd = new Date(this._viewYear, this._viewMonth + 1, 1)
    const dayBuckets = new Map<string, TeableRecord[]>()
    if (this._dateField) {
      for (const r of this._records) {
        const key = this._dateKey(r.fields[this._dateField.name])
        if (!key) continue
        const bucketDay = new Date(`${key}T00:00:00`)
        if (bucketDay < monthStart || bucketDay >= monthEnd) continue
        const existing = dayBuckets.get(key)
        if (existing) existing.push(r)
        else dayBuckets.set(key, [r])
      }
    }
    const weekdayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return html`
      <div class="grid grid-cols-7 border-b border-black/5 bg-black/[.02] text-[11px] font-medium uppercase text-black/40 dark:border-white/10 dark:bg-white/[.03] dark:text-white/40">
        ${weekdayHeaders.map((w) => html`<div class="px-2 py-1">${w}</div>`)}
      </div>
      <div class="grid grid-cols-7 grid-rows-6">
        ${days.map((key) => this._renderDayCell(key, todayKey, dayBuckets.get(key) ?? []))}
      </div>
    `
  }

  private _renderDayCell(key: string, todayKey: string, records: TeableRecord[]) {
    const [, m, d] = key.split('-').map((n) => Number(n))
    const inMonth = m - 1 === this._viewMonth
    const isToday = key === todayKey
    const expanded = this._expandedDayKey === key
    const visible = expanded ? records : records.slice(0, 3)
    const overflow = records.length - visible.length
    return html`
      <div
        class="flex min-h-[88px] flex-col gap-1 border-b border-r border-black/5 p-1.5 text-xs dark:border-white/5 ${inMonth
          ? 'bg-white dark:bg-transparent'
          : 'bg-black/[.015] text-black/30 dark:bg-white/[.015] dark:text-white/30'}"
      >
        <div class="flex items-center justify-between">
          <span class="${isToday
            ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/[.08] text-[11px] font-medium text-black dark:bg-white/15 dark:text-white'
            : 'text-[11px]'}">${d}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          ${visible.map(
            (r) => html`<button
              type="button"
              class="truncate rounded px-1.5 py-0.5 text-left text-[11px] ${this._chipClasses(r)}"
              title=${this._recordTitle(r)}
              @click=${() => this._host.openRecordDetail(r.id)}
            >
              ${this._recordTitle(r)}
            </button>`,
          )}
          ${overflow > 0
            ? html`<button
                type="button"
                class="text-left text-[10px] text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60"
                @click=${() => {
                  this._expandedDayKey = expanded ? null : key
                  this._host.requestUpdate()
                }}
              >
                +${overflow} more
              </button>`
            : null}
        </div>
      </div>
    `
  }

  /** Default title: first non-empty string field on the record; falls back to the record id. */
  private _recordTitle(record: TeableRecord): string {
    for (const f of this._fields) {
      if (f.type !== 'singleLineText' && f.type !== 'longText') continue
      const v = record.fields[f.name]
      if (typeof v === 'string' && v.trim()) return v
    }
    return record.id
  }

  /** Tint chips by the record's first singleSelect choice, falling back to gray. */
  private _chipClasses(record: TeableRecord): string {
    for (const f of this._fields) {
      if (f.type !== 'singleSelect') continue
      const raw = record.fields[f.name]
      const name = typeof raw === 'string' ? raw : null
      if (!name) continue
      const choice = (f.options?.choices ?? []).find((c) => c.name === name)
      return colorClasses(choice?.color)
    }
    return colorClasses('gray')
  }
}
