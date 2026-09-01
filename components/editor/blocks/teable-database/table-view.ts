import { html } from 'lit'
import {
  colorClasses,
  formatReadOnly,
  FIELD_TYPE_OPTIONS,
  inputClass,
  parseChoicesInput,
  popoverClass,
  smallButtonClass,
  type TeableField,
  type TeableRecord,
  type TeableViewController,
  type TeableViewHost,
} from './teable-types'

/**
 * Table (grid) view: fields → column headers, records → rows, inline cell
 * editing per property type, add row/property, column menu (rename/change
 * type/delete), and an "expand row" button per row that opens the shared
 * record-detail popover via the host.
 *
 * Owns all of its own state — the host block only calls `refresh()`/`render()`/
 * `dispose()` and never reaches into this controller's internals. A future
 * `kanban-view.ts`/`calendar-view.ts` should follow the same shape
 * (implement `TeableViewController`, take a `TeableViewHost` + `teableTableId`)
 * without needing to touch this file.
 */
export class TableViewController implements TeableViewController {
  private _fields: TeableField[] = []
  private _records: TeableRecord[] = []
  private _loading = false
  private _error: string | null = null
  private _openCellKey: string | null = null
  private _openColumnMenuFieldId: string | null = null
  private _editFieldName = ''
  private _editFieldType = ''
  private _editFieldChoices = ''
  private _addPropertyOpen = false
  private _newPropName = ''
  private _newPropType = 'singleLineText'
  private _newPropChoices = ''
  private _relationTargets: Array<{ id: number; name: string; teableTableId: string }> = []
  private _relationTargetId = ''
  private _relationType = 'manyOne'
  private _relationRecords: TeableRecord[] = []
  private _relationSearch = ''
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _viewId: string | null = null
  private _filterField = ''
  private _filterValue = ''
  private _sortField = ''
  private _sortDirection = 'asc'

  constructor(
    private readonly _host: TeableViewHost,
    private readonly _teableTableId: string,
    private readonly _workspaceId = 1,
  ) {}

  dispose() {
    for (const timer of this._debounceTimers.values()) clearTimeout(timer)
    this._debounceTimers.clear()
    this.closePopovers()
  }

  closePopovers() {
    if (this._openCellKey === null && this._openColumnMenuFieldId === null && !this._addPropertyOpen) return
    this._openCellKey = null
    this._openColumnMenuFieldId = null
    this._addPropertyOpen = false
    this._host.requestUpdate()
  }

  async refresh() {
    this._loading = true
    this._error = null
    this._host.requestUpdate()
    try {
      const viewsRes = await fetch(`/api/teable/tables/${this._teableTableId}/views`)
      const views = await viewsRes.json().catch(() => []) as Array<{ id: string; type?: string }>
      this._viewId = views.find((view) => view.type === 'grid')?.id ?? views[0]?.id ?? null
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
      this._host.requestUpdate()
    }
  }

  /** Re-fetches a single record (e.g. after the record-detail popover reports an edit). */
  async refreshRecord(recordId: string) {
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

  // --- rows/cells -------------------------------------------------------

  private _setCellValueLocal(record: TeableRecord, field: TeableField, value: unknown) {
    record.fields[field.name] = value
    this._host.requestUpdate()
  }

  private _scheduleCellPatch(record: TeableRecord, field: TeableField, value: unknown) {
    const key = `${record.id}:${field.id}`
    const existing = this._debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    this._debounceTimers.set(
      key,
      setTimeout(() => {
        this._debounceTimers.delete(key)
        void this._patchCell(record, field, value)
      }, 500),
    )
  }

  private async _patchCell(record: TeableRecord, field: TeableField, value: unknown) {
    try {
      const res = await fetch(`/api/teable/tables/${this._teableTableId}/records/${record.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: { fields: { [field.name]: value } } }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || 'Failed to save.')
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to save.'
      this._host.requestUpdate()
    }
  }

  private async _addRow() {
    try {
      const res = await fetch(`/api/teable/tables/${this._teableTableId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: {} }] }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to add row.')
      const created: TeableRecord[] = json.records ?? (json.record ? [json.record] : [])
      this._records = [...this._records, ...created]
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to add row.'
    } finally {
      this._host.requestUpdate()
    }
  }

  // --- properties (fields) ----------------------------------------------

  private _openAddProperty() {
    this._addPropertyOpen = !this._addPropertyOpen
    this._openColumnMenuFieldId = null
    this._newPropName = ''
    this._newPropType = 'singleLineText'
    this._newPropChoices = ''
    this._relationTargetId = ''
    this._relationType = 'manyOne'
    this._host.requestUpdate()
  }

  private async _submitAddProperty() {
    if (!this._newPropName.trim()) return
    const isSelect = this._newPropType === 'singleSelect' || this._newPropType === 'multipleSelect'
    if (this._newPropType === 'link' && !this._relationTargetId) return
    try {
      const res = await fetch(`/api/teable/tables/${this._teableTableId}/fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: this._newPropName.trim(),
          type: this._newPropType,
          ...(isSelect ? { options: { choices: parseChoicesInput(this._newPropChoices) } } : {}),
          ...(this._newPropType === 'link' ? { targetDatabaseId: this._relationTargetId, relationship: this._relationType } : {}),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to add property.')
      this._fields = [...this._fields, json]
      this._addPropertyOpen = false
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to add property.'
    } finally {
      this._host.requestUpdate()
    }
  }

  private _openColumnMenu(field: TeableField) {
    const opening = this._openColumnMenuFieldId !== field.id
    this._openColumnMenuFieldId = opening ? field.id : null
    this._addPropertyOpen = false
    if (opening) {
      this._editFieldName = field.name
      this._editFieldType = field.type
      this._editFieldChoices = (field.options?.choices ?? []).map((c) => c.name).join(', ')
    }
    this._host.requestUpdate()
  }

  private async _saveFieldEdit(field: TeableField) {
    if (!this._editFieldName.trim()) return
    const typeChanged = this._editFieldType !== field.type
    const isSelect = this._editFieldType === 'singleSelect' || this._editFieldType === 'multipleSelect'
    try {
      const res = await fetch(`/api/teable/tables/${this._teableTableId}/fields/${field.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: this._editFieldName.trim(),
          ...(typeChanged ? { type: this._editFieldType } : {}),
          ...(typeChanged && isSelect ? { options: { choices: parseChoicesInput(this._editFieldChoices) } } : {}),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Failed to update property.')
      // Teable's field PATCH returns `null` on success (verified live) — merge
      // our own known changes locally instead of trusting the empty response.
      const updated: TeableField = {
        ...field,
        name: this._editFieldName.trim(),
        type: this._editFieldType,
        options: typeChanged && isSelect ? { choices: parseChoicesInput(this._editFieldChoices) } : field.options,
      }
      this._fields = this._fields.map((f) => (f.id === field.id ? updated : f))
      this._openColumnMenuFieldId = null
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to update property.'
    } finally {
      this._host.requestUpdate()
    }
  }

  private async _deleteField(field: TeableField) {
    if (!confirm(`Delete property "${field.name}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/teable/tables/${this._teableTableId}/fields/${field.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || 'Failed to delete property.')
      }
      this._fields = this._fields.filter((f) => f.id !== field.id)
      this._openColumnMenuFieldId = null
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to delete property.'
    } finally {
      this._host.requestUpdate()
    }
  }

  // --- render -------------------------------------------------------------

  render() {
    if (this._loading) {
      return html`<div class="px-3 py-2.5 text-sm text-black/40 dark:text-white/40">Loading Teable table…</div>`
    }
    return html`
      <div class="flex items-center justify-end gap-1 border-b border-black/5 bg-black/[.02] px-3 py-1 dark:border-white/10 dark:bg-white/[.03]">
        ${this._renderViewControls()}
        <button type="button" class=${smallButtonClass} @click=${() => this._openAddProperty()}>+ Property</button>
        <button type="button" class=${smallButtonClass} @click=${() => this._addRow()}>+ Row</button>
      </div>
      ${this._error
        ? html`<div class="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400">
            ${this._error}
          </div>`
        : null}
      ${this._addPropertyOpen ? this._renderAddPropertyMenu() : null}
      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="border-b border-black/10 dark:border-white/10">
              <th class="w-7 border-r border-black/5 dark:border-white/10"></th>
              ${this._fields.map(
                (f) => html`
                  <th
                    class="relative border-r border-black/5 px-2 py-1.5 text-left align-top text-xs font-medium text-black/50 last:border-r-0 dark:border-white/10 dark:text-white/50"
                  >
                    <div class="flex items-center justify-between gap-1">
                      <span class="truncate">${f.name}</span>
                      <button type="button" class="shrink-0 rounded px-1 hover:bg-black/[.06] dark:hover:bg-white/[.08]" @click=${() => this._openColumnMenu(f)}>
                        ⋯
                      </button>
                    </div>
                    ${this._openColumnMenuFieldId === f.id ? this._renderColumnMenu(f) : null}
                  </th>
                `,
              )}
            </tr>
          </thead>
          <tbody>
            ${this._records.map(
              (r) => html`
                <tr class="border-b border-black/5 last:border-b-0 dark:border-white/5">
                  <td class="border-r border-black/5 text-center dark:border-white/5">
                    <button
                      type="button"
                      title="Expand row"
                      class="rounded px-1 py-1.5 text-black/30 hover:bg-black/[.06] hover:text-black/60 dark:text-white/30 dark:hover:bg-white/[.08] dark:hover:text-white/60"
                      @click=${() => this._host.openRecordDetail(r.id)}
                    >
                      ⤢
                    </button>
                  </td>
                  ${this._fields.map((f) => html`<td class="relative border-r border-black/5 last:border-r-0 dark:border-white/5">${this._renderCell(f, r)}</td>`)}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `
  }

  private _renderViewControls() {
    if (!this._viewId) return null
    return html`<select class="rounded border border-black/10 bg-transparent px-1 py-0.5 text-[11px] dark:border-white/10 dark:bg-[#2f2f2f]" .value=${this._filterField} @change=${(e: Event) => { this._filterField = (e.target as HTMLSelectElement).value; void this._persistView('filter', this._filterField ? { conjunction: 'and', filterSet: [{ fieldId: this._filterField, operator: 'is', value: this._filterValue }] } : null) }}><option value="">Filter…</option>${this._fields.map((field) => html`<option value=${field.id}>${field.name}</option>`)}</select><input class="w-20 rounded border border-black/10 bg-transparent px-1 py-0.5 text-[11px] dark:border-white/10" placeholder="Value" .value=${this._filterValue} @change=${(e: Event) => { this._filterValue = (e.target as HTMLInputElement).value; if (this._filterField) void this._persistView('filter', { conjunction: 'and', filterSet: [{ fieldId: this._filterField, operator: 'is', value: this._filterValue }] }) }} /><select class="rounded border border-black/10 bg-transparent px-1 py-0.5 text-[11px] dark:border-white/10 dark:bg-[#2f2f2f]" .value=${this._sortField} @change=${(e: Event) => { this._sortField = (e.target as HTMLSelectElement).value; void this._persistView('sort', this._sortField ? { sortObjs: [{ fieldId: this._sortField, order: this._sortDirection }] } : null) }}><option value="">Sort…</option>${this._fields.map((field) => html`<option value=${field.id}>${field.name}</option>`)}</select><select class="rounded border border-black/10 bg-transparent px-1 py-0.5 text-[11px] dark:border-white/10 dark:bg-[#2f2f2f]" .value=${this._sortDirection} @change=${(e: Event) => { this._sortDirection = (e.target as HTMLSelectElement).value; if (this._sortField) void this._persistView('sort', { sortObjs: [{ fieldId: this._sortField, order: this._sortDirection }] }) }}><option value="asc">↑</option><option value="desc">↓</option></select>`
  }

  private async _persistView(resource: string, value: unknown) {
    if (!this._viewId) return
    const response = await fetch(`/api/teable/tables/${this._teableTableId}/views/${this._viewId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource, value }) })
    if (response.ok) await this.refresh()
  }

  private _renderAddPropertyMenu() {
    const isSelect = this._newPropType === 'singleSelect' || this._newPropType === 'multipleSelect'
    const isRelation = this._newPropType === 'link'
    return html`
      <div class="flex flex-wrap items-center gap-2 border-b border-black/10 bg-black/[.02] px-3 py-2 text-xs dark:border-white/10 dark:bg-white/[.03]">
        <input
          placeholder="Property name"
          class="rounded border border-black/10 bg-transparent px-2 py-1 outline-none dark:border-white/10"
          .value=${this._newPropName}
          @input=${(e: Event) => {
            this._newPropName = (e.target as HTMLInputElement).value
          }}
        />
        <select
          class="rounded border border-black/10 bg-transparent px-2 py-1 outline-none dark:border-white/10 dark:bg-[#2f2f2f]"
          .value=${this._newPropType}
          @change=${(e: Event) => {
            this._newPropType = (e.target as HTMLSelectElement).value
            if (this._newPropType === 'link') void this._loadRelationTargets()
            this._host.requestUpdate()
          }}
        >
          ${FIELD_TYPE_OPTIONS.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
        </select>
        ${isSelect
          ? html`<input
              placeholder="Options, comma separated"
              class="min-w-[160px] flex-1 rounded border border-black/10 bg-transparent px-2 py-1 outline-none dark:border-white/10"
              .value=${this._newPropChoices}
              @input=${(e: Event) => {
                this._newPropChoices = (e.target as HTMLInputElement).value
              }}
            />`
          : null}
        ${isRelation ? html`<select class="rounded border border-black/10 bg-transparent px-2 py-1 dark:border-white/10 dark:bg-[#2f2f2f]" .value=${this._relationTargetId} @change=${(e: Event) => { this._relationTargetId = (e.target as HTMLSelectElement).value }}><option value="">Target table…</option>${this._relationTargets.map((target) => html`<option value=${String(target.id)}>${target.name}</option>`)}</select><select class="rounded border border-black/10 bg-transparent px-2 py-1 dark:border-white/10 dark:bg-[#2f2f2f]" .value=${this._relationType} @change=${(e: Event) => { this._relationType = (e.target as HTMLSelectElement).value }}><option value="manyOne">Many → one</option><option value="oneMany">One → many</option><option value="oneOne">One ↔ one</option><option value="manyMany">Many ↔ many</option></select>` : null}
        <button type="button" class="rounded bg-black/[.06] px-2 py-1 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20" @click=${() => this._submitAddProperty()}>
          Add
        </button>
        <button
          type="button"
          class="text-black/40 hover:text-black/60 dark:text-white/40 dark:hover:text-white/60"
          @click=${() => {
            this._addPropertyOpen = false
            this._host.requestUpdate()
          }}
        >
          Cancel
        </button>
      </div>
    `
  }

  private async _loadRelationTargets() {
    const current = this._teableTableId
    const connection = await fetch(`/api/teable-databases?workspaceId=${this._workspaceId}`).then((res) => res.json()).catch(() => ({ docs: [] }))
    this._relationTargets = (connection.docs || []).filter((target: { teableTableId: string }) => target.teableTableId !== current)
    this._host.requestUpdate()
  }

  private _renderColumnMenu(field: TeableField) {
    const isSelect = this._editFieldType === 'singleSelect' || this._editFieldType === 'multipleSelect'
    return html`
      <div class="${popoverClass} left-0 top-full w-56 p-2 text-left text-xs font-normal normal-case">
        <label class="mb-1 block text-black/40 dark:text-white/40">Name</label>
        <input
          class="mb-2 w-full rounded border border-black/10 bg-transparent px-2 py-1 outline-none dark:border-white/10"
          .value=${this._editFieldName}
          @input=${(e: Event) => {
            this._editFieldName = (e.target as HTMLInputElement).value
          }}
        />
        <label class="mb-1 block text-black/40 dark:text-white/40">Type</label>
        <select
          class="mb-2 w-full rounded border border-black/10 bg-transparent px-2 py-1 outline-none dark:border-white/10 dark:bg-[#2f2f2f]"
          .value=${this._editFieldType}
          @change=${(e: Event) => {
            this._editFieldType = (e.target as HTMLSelectElement).value
            this._host.requestUpdate()
          }}
        >
          ${FIELD_TYPE_OPTIONS.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
        </select>
        ${isSelect
          ? html`<input
              placeholder="Options, comma separated"
              class="mb-2 w-full rounded border border-black/10 bg-transparent px-2 py-1 outline-none dark:border-white/10"
              .value=${this._editFieldChoices}
              @input=${(e: Event) => {
                this._editFieldChoices = (e.target as HTMLInputElement).value
              }}
            />`
          : null}
        <div class="flex items-center justify-between">
          <button type="button" class="rounded bg-black/[.06] px-2 py-1 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20" @click=${() => this._saveFieldEdit(field)}>
            Save
          </button>
          <button
            type="button"
            class="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
            @click=${() => this._deleteField(field)}
          >
            Delete
          </button>
        </div>
      </div>
    `
  }

  private _renderCell(field: TeableField, record: TeableRecord) {
    const value = record.fields[field.name]

    switch (field.type) {
      case 'singleLineText':
      case 'longText':
        return html`<input
          class=${inputClass}
          .value=${typeof value === 'string' ? value : ''}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value
            this._setCellValueLocal(record, field, v)
            this._scheduleCellPatch(record, field, v)
          }}
        />`
      case 'number':
        return html`<input
          type="number"
          class=${inputClass}
          .value=${typeof value === 'number' ? String(value) : ''}
          @input=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value
            const v = raw === '' ? null : Number(raw)
            this._setCellValueLocal(record, field, v)
            this._scheduleCellPatch(record, field, v)
          }}
        />`
      case 'checkbox':
        return html`<div class="flex justify-center px-2 py-1.5">
          <input
            type="checkbox"
            .checked=${!!value}
            @change=${(e: Event) => {
              const v = (e.target as HTMLInputElement).checked
              this._setCellValueLocal(record, field, v)
              void this._patchCell(record, field, v)
            }}
          />
        </div>`
      case 'date': {
        const dateValue = typeof value === 'string' ? value.slice(0, 10) : ''
        return html`<input
          type="date"
          class=${inputClass}
          .value=${dateValue}
          @change=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value
            const v = raw ? new Date(raw).toISOString() : null
            this._setCellValueLocal(record, field, v)
            void this._patchCell(record, field, v)
          }}
        />`
      }
      case 'singleSelect':
        return this._renderSelectCell(field, record, false)
      case 'multipleSelect':
        return this._renderSelectCell(field, record, true)
      case 'link':
        return this._renderRelationCell(field, record)
      default:
        return html`<span class="block truncate px-2 py-1.5 text-sm text-black/40 dark:text-white/40">${formatReadOnly(value)}</span>`
    }
  }

  private _renderSelectCell(field: TeableField, record: TeableRecord, multi: boolean) {
    const key = `${record.id}:${field.id}`
    const raw = record.fields[field.name]
    const selected: string[] = multi ? (Array.isArray(raw) ? (raw as string[]) : []) : raw ? [raw as string] : []
    const choices = field.options?.choices ?? []
    const open = this._openCellKey === key

    return html`
      <div class="relative px-1 py-1">
        <button
          type="button"
          class="flex min-h-[24px] w-full flex-wrap items-center gap-1 rounded px-1 text-left hover:bg-black/[.04] dark:hover:bg-white/[.06]"
          @click=${() => {
            this._openCellKey = open ? null : key
            this._openColumnMenuFieldId = null
            this._addPropertyOpen = false
            this._host.requestUpdate()
          }}
        >
          ${selected.length
            ? selected.map((name) => {
                const choice = choices.find((c) => c.name === name)
                return html`<span class="rounded px-1.5 py-0.5 text-xs ${colorClasses(choice?.color)}">${name}</span>`
              })
            : html`<span class="text-xs text-black/30 dark:text-white/30">Empty</span>`}
        </button>
        ${open
          ? html`
              <div class="${popoverClass} left-0 top-full min-w-[160px] p-1">
                ${choices.length
                  ? choices.map((choice) => {
                      const isSelected = selected.includes(choice.name)
                      return html`
                        <button
                          type="button"
                          class="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-black/[.06] dark:hover:bg-white/[.08]"
                          @click=${() => {
                            const next: string | string[] | null = multi
                              ? isSelected
                                ? selected.filter((s) => s !== choice.name)
                                : [...selected, choice.name]
                              : isSelected
                                ? null
                                : choice.name
                            this._setCellValueLocal(record, field, next)
                            void this._patchCell(record, field, next)
                            if (!multi) {
                              this._openCellKey = null
                              this._host.requestUpdate()
                            }
                          }}
                        >
                          <span class="rounded px-1.5 py-0.5 ${colorClasses(choice.color)}">${choice.name}</span>
                          ${isSelected ? html`<span>✓</span>` : null}
                        </button>
                      `
                    })
                  : html`<div class="px-2 py-1 text-xs text-black/40 dark:text-white/40">No options defined.</div>`}
              </div>
            `
          : null}
      </div>
    `
  }

  private _renderRelationCell(field: TeableField, record: TeableRecord) {
    const raw = record.fields[field.name]
    const values = Array.isArray(raw) ? raw : raw ? [raw] : []
    const key = `${record.id}:${field.id}`
    const open = this._openCellKey === key
    return html`<div class="relative px-1 py-1"><button type="button" class="flex min-h-[24px] w-full flex-wrap gap-1 rounded px-1 text-left hover:bg-black/[.04] dark:hover:bg-white/[.06]" @click=${() => { this._openCellKey = open ? null : key; if (!open) void this._loadRelationRecords(field); this._host.requestUpdate() }}>${values.length ? values.map((value) => html`<span class="rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-300">${typeof value === 'object' && value ? (value as { title?: string }).title || (value as { id?: string }).id : value}</span>`) : html`<span class="text-xs text-black/30 dark:text-white/30">Empty</span>`}</button>${open ? html`<div class="${popoverClass} left-0 top-full min-w-[220px] p-1"><input class="mb-1 w-full rounded border border-black/10 bg-transparent px-2 py-1 text-xs outline-none dark:border-white/10" placeholder="Search records…" .value=${this._relationSearch} @input=${(e: Event) => { this._relationSearch = (e.target as HTMLInputElement).value; this._host.requestUpdate() }} />${this._relationRecords.filter((candidate) => !this._relationSearch || formatReadOnly(candidate.fields.Name).toLowerCase().includes(this._relationSearch.toLowerCase())).map((candidate) => html`<button type="button" class="block w-full rounded px-2 py-1 text-left text-xs hover:bg-black/[.06] dark:hover:bg-white/[.08]" @click=${() => this._toggleRelation(field, record, candidate.id)}>${formatReadOnly(candidate.fields.Name)}</button>`)}</div>` : null}</div>`
  }

  private async _loadRelationRecords(field: TeableField) {
    const target = field.options?.foreignTableId
    if (!target) return
    const response = await fetch(`/api/teable/tables/${target}/records`).then((res) => res.json()).catch(() => ({ records: [] }))
    this._relationRecords = response.records || []
    this._relationSearch = ''
    this._host.requestUpdate()
  }

  private _toggleRelation(field: TeableField, record: TeableRecord, targetRecordId: string) {
    const current = record.fields[field.name]
    const values = Array.isArray(current) ? current : current ? [current] : []
    const ids = values.map((value) => typeof value === 'object' && value ? (value as { id?: string }).id : value).filter((id): id is string => typeof id === 'string')
    const multi = field.options?.relationship === 'manyMany' || field.options?.relationship === 'oneMany'
    const nextIds = multi ? (ids.includes(targetRecordId) ? ids.filter((id) => id !== targetRecordId) : [...ids, targetRecordId]) : ids.includes(targetRecordId) ? [] : [targetRecordId]
    const next = nextIds.map((id) => ({ id }))
    this._setCellValueLocal(record, field, multi ? next : next[0] || null)
    void this._patchCell(record, field, multi ? next : next[0] || null)
    if (!multi) this._openCellKey = null
    this._host.requestUpdate()
  }
}
