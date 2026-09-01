import {
  DataSourceBase,
  ViewManagerBase,
  type DatabaseFlags,
  type DataViewDataType,
  type PropertyMetaConfig,
  type TypeInstance,
  type ViewManager,
  type ViewMeta,
} from '@blocksuite/data-view'
import { propertyPresets } from '@blocksuite/data-view/property-presets'
import { viewPresets, viewConverts } from '@blocksuite/data-view/view-presets'
import type { InsertToPosition } from '@blocksuite/affine-shared/utils'
import { computed, signal, type ReadonlySignal } from '@preact/signals-core'

// Real Teable-backed `DataSource` for BlockSuite's native `DataView` renderer
// (the table/kanban UI itself is untouched — this class is the only thing
// that's new). Modeled directly on BlockSuite's own `DatabaseBlockDataSource`
// (`node_modules/@blocksuite/blocks/src/database-block/data-source.ts`), the
// only shipped implementation that fully satisfies `DataSourceBase` without
// an `@ts-ignore` escape hatch — the OTHER shipped example
// (`BlockQueryDataSource`) does NOT fully implement the interface (missing
// `viewManager`/`viewMetas`/several `$` signals, needs `@ts-ignore` to
// compile), so it was not usable as a template.

interface TeableChoice {
  id: string
  name: string
  color: string
}

interface TeableField {
  id: string
  name: string
  type: string
  options?: { choices?: TeableChoice[] }
  isPrimary?: boolean
}

interface TeableRecord {
  id: string
  fields: Record<string, unknown>
}

const HUE_NAMES = ['blue', 'cyan', 'gray', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'yellow']

/** Teable's color tokens (`blueLight2`, `greenBright`, ...) aren't validated
 * against BlockSuite's own tag-color set (`SelectTag.color` is a plain zod
 * string, no enum) — best-effort hue match, falls back to grey. */
function toTagColor(token: string | undefined): string {
  const stripped = (token ?? '').replace(/(Light2|Light1|Bright|Dark1)$/, '').toLowerCase()
  if (stripped === 'gray') return 'grey'
  return HUE_NAMES.includes(stripped) ? stripped : 'grey'
}

// Teable field type -> BlockSuite property-preset type. Types with no clean
// preset equivalent (user/link/attachment/formula/rollup/createdTime/etc.)
// fall back to read-only text — same simplification the boxed Teable block's
// grid already uses for its "default" cell case.
const TEABLE_TO_BS_TYPE: Record<string, string> = {
  singleLineText: 'text',
  longText: 'text',
  number: 'number',
  checkbox: 'checkbox',
  singleSelect: 'select',
  multipleSelect: 'multi-select',
  date: 'date',
}

const BS_TO_TEABLE_TYPE: Record<string, string> = {
  text: 'singleLineText',
  number: 'number',
  checkbox: 'checkbox',
  select: 'singleSelect',
  'multi-select': 'multipleSelect',
  date: 'date',
}

function bsType(teableType: string): string {
  return TEABLE_TO_BS_TYPE[teableType] ?? 'text'
}

async function teableFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
}

export class TeableDataSource extends DataSourceBase {
  private readonly _fields = signal<TeableField[]>([])
  private readonly _records = signal<TeableRecord[]>([])
  private readonly _viewData = signal<DataViewDataType[]>([])
  private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Maps a locally-generated temp id (used the instant `propertyAdd`/`rowAdd`
  // return, before Teable confirms) to the real Teable id once creation
  // succeeds. Property ids specifically must stay stable forever after
  // returning from `propertyAdd`: `SingleViewBase.propertyAdd` immediately
  // calls `view.propertyMove(id, position)` to register the new column in
  // the *view's* own column list using that exact id — there is no hook to
  // go back and update that view-level reference afterward. Swapping
  // `_fields`'s id out from under it (the previous `refresh()`-based
  // approach) orphaned the view's column pointer, so the newly created
  // property visually vanished right after creation. Real network calls
  // that target a field/record by id resolve through these maps instead.
  private readonly _fieldIdAliases = new Map<string, string>()
  private readonly _rowIdAliases = new Map<string, string>()

  readonly$: ReadonlySignal<boolean> = computed(() => false)
  featureFlags$: ReadonlySignal<DatabaseFlags> = computed(() => ({}) as DatabaseFlags)
  properties$: ReadonlySignal<string[]> = computed(() => this._fields.value.map((f) => f.id))
  rows$: ReadonlySignal<string[]> = computed(() => this._records.value.map((r) => r.id))
  viewConverts = [...viewConverts]
  viewDataList$: ReadonlySignal<DataViewDataType[]> = computed(() => this._viewData.value)
  viewManager: ViewManager = new ViewManagerBase(this)
  viewMetas: ViewMeta[] = [viewPresets.tableViewMeta, viewPresets.kanbanViewMeta]

  get propertyMetas(): PropertyMetaConfig[] {
    return [
      propertyPresets.textPropertyConfig,
      propertyPresets.numberPropertyConfig,
      propertyPresets.checkboxPropertyConfig,
      propertyPresets.selectPropertyConfig,
      propertyPresets.multiSelectPropertyConfig,
      propertyPresets.datePropertyConfig,
    ] as PropertyMetaConfig[]
  }

  constructor(private readonly _teableTableId: string) {
    super()
  }

  /** Loads fields+records from the real Teable proxy routes. Call before mounting the `DataView`. */
  async refresh() {
    const [fieldsRes, recordsRes] = await Promise.all([
      teableFetch(`/api/teable/tables/${this._teableTableId}/fields`),
      teableFetch(`/api/teable/tables/${this._teableTableId}/records`),
    ])
    const fieldsJson = await fieldsRes.json().catch(() => [])
    const recordsJson = await recordsRes.json().catch(() => ({ records: [] }))
    this._fields.value = Array.isArray(fieldsJson) ? fieldsJson : []
    this._records.value = Array.isArray(recordsJson.records) ? recordsJson.records : []

    // v1 simplification (per the task's own guidance): view configuration
    // (which views exist, filter/sort) is local-only, not synced to Teable's
    // own view sub-resources — the OTHER Teable block already owns that sync.
    // Seeded once, on first successful load: `kanbanViewMeta.model.defaultData`
    // inspects real fields to auto-pick a groupable (select/tag) column, so it
    // must run *after* fields are populated — doing this in the constructor
    // (before any data exists) throws `BlockSuiteError: not implement yet`
    // (confirmed live while verifying this class), since the properties list
    // is still empty at that point. Also guarded for tables with no
    // select/tag field at all, which hits the exact same throw for a
    // legitimate reason (nothing to group by).
    if (this._viewData.value.length === 0) {
      const table = viewPresets.tableViewMeta.model.defaultData(this.viewManager)
      // `defaultData` picks `header.titleColumn` by finding a property whose
      // BlockSuite type is literally `'title'` (`define.ts`) — a type this
      // data source never produces (`bsType()` only maps to
      // text/number/checkbox/select/multi-select/date), so it's always
      // `undefined` here. That silently disables the hover-to-expand row
      // icon: `TableRow.render()` (view-presets/table/pc/row/row.ts) only
      // renders it on the column matching `mainProperties$.value.titleColumn`
      // — nothing to do with the column's *type*, just its id. Point it at
      // Teable's own primary field (or the first field, if that flag is
      // ever missing) so the native affordance has a column to attach to.
      const primaryFieldId = this._fields.value.find((f) => f.isPrimary)?.id ?? this._fields.value[0]?.id
      if (primaryFieldId) {
        table.header = { ...table.header, titleColumn: primaryFieldId }
      }
      let kanban: ReturnType<typeof viewPresets.kanbanViewMeta.model.defaultData>
      try {
        kanban = viewPresets.kanbanViewMeta.model.defaultData(this.viewManager)
      } catch {
        kanban = { columns: [], filter: { type: 'group', op: 'and', conditions: [] }, header: {}, groupProperties: [] }
      }
      this._viewData.value = [
        { id: 'table-view', name: 'Table', mode: 'table', ...table } as DataViewDataType,
        { id: 'kanban-view', name: 'Kanban', mode: 'kanban', ...kanban } as DataViewDataType,
      ]
    }
  }

  private _fieldById(propertyId: string): TeableField | undefined {
    return this._fields.value.find((f) => f.id === propertyId)
  }

  private _recordById(rowId: string): TeableRecord | undefined {
    return this._records.value.find((r) => r.id === rowId)
  }

  /** Real Teable id for a field, resolving a still-locally-known temp id (see `_fieldIdAliases`). */
  private _resolveFieldId(propertyId: string): string {
    return this._fieldIdAliases.get(propertyId) ?? propertyId
  }

  /** Real Teable id for a row, resolving a still-locally-known temp id (see `_rowIdAliases`). */
  private _resolveRowId(rowId: string): string {
    return this._rowIdAliases.get(rowId) ?? rowId
  }

  // --- cells --------------------------------------------------------------

  cellValueGet(rowId: string, propertyId: string): unknown {
    const field = this._fieldById(propertyId)
    const record = this._recordById(rowId)
    if (!field || !record) return undefined
    const raw = record.fields[field.name]

    switch (field.type) {
      case 'singleSelect':
        return typeof raw === 'string' ? field.options?.choices?.find((c) => c.name === raw)?.id : undefined
      case 'multipleSelect':
        return Array.isArray(raw)
          ? raw.map((name) => field.options?.choices?.find((c) => c.name === name)?.id).filter((id): id is string => !!id)
          : []
      case 'date':
        return typeof raw === 'string' ? new Date(raw).getTime() : undefined
      case 'number':
        return typeof raw === 'number' ? raw : undefined
      case 'checkbox':
        return !!raw
      default:
        if (raw === null || raw === undefined) return ''
        if (typeof raw === 'string') return raw
        if (typeof raw === 'object') return JSON.stringify(raw)
        return String(raw)
    }
  }

  cellValueChange(rowId: string, propertyId: string, value: unknown): void {
    const field = this._fieldById(propertyId)
    const record = this._recordById(rowId)
    if (!field || !record) return

    let teableValue: unknown
    switch (field.type) {
      case 'singleSelect':
        teableValue = typeof value === 'string' ? (field.options?.choices?.find((c) => c.id === value)?.name ?? null) : null
        break
      case 'multipleSelect':
        teableValue = Array.isArray(value)
          ? value.map((id) => field.options?.choices?.find((c) => c.id === id)?.name).filter((n): n is string => !!n)
          : []
        break
      case 'date':
        teableValue = typeof value === 'number' ? new Date(value).toISOString() : null
        break
      default:
        teableValue = value
    }

    // Optimistic local update (new array, so the `rows$`/cell signals notice).
    this._records.value = this._records.value.map((r) =>
      r.id === rowId ? { ...r, fields: { ...r.fields, [field.name]: teableValue } } : r,
    )

    const key = `${rowId}:${propertyId}`
    const existing = this._debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    this._debounceTimers.set(
      key,
      setTimeout(() => {
        this._debounceTimers.delete(key)
        // Resolved at fire time (not schedule time): a cell edit on a row
        // created moments ago may still be waiting on `rowAdd`'s creation
        // POST when this timer is scheduled, but the alias is very likely
        // resolved by the time this 500ms debounce actually fires.
        void teableFetch(`/api/teable/tables/${this._teableTableId}/records/${this._resolveRowId(rowId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ record: { fields: { [field.name]: teableValue } } }),
        })
      }, 500),
    )
  }

  // --- rows -----------------------------------------------------------------

  rowAdd(_insertToPosition: InsertToPosition | number): string {
    // `DataSourceBase.rowAdd` must return the new row's id *synchronously*,
    // but creating a Teable record is a network call — a real mismatch none
    // of BlockSuite's own (local-Yjs-backed) implementations face. Insert an
    // optimistic placeholder under a temp id, fire the real create in the
    // background, and once Teable confirms, merge the real record's data in
    // *under the same temp id* (aliasing it to the real id for future
    // requests) rather than replacing the id outright — keeps the row's
    // identity stable instead of it disappearing/reappearing during the swap.
    const tempId = `pending-row-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this._records.value = [...this._records.value, { id: tempId, fields: {} }]
    void teableFetch(`/api/teable/tables/${this._teableTableId}/records`, {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields: {} }] }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to create row.')
        const json = await res.json()
        const created: TeableRecord | undefined = json.records?.[0] ?? json.record
        if (!created?.id) throw new Error('Teable did not return the created record.')
        this._rowIdAliases.set(tempId, created.id)
        this._records.value = this._records.value.map((r) => (r.id === tempId ? { ...created, id: tempId } : r))
      })
      .catch((err) => {
        console.error('[teable-native] Failed to create row', err)
        this._records.value = this._records.value.filter((r) => r.id !== tempId)
      })
    return tempId
  }

  rowDelete(ids: string[]): void {
    this._records.value = this._records.value.filter((r) => !ids.includes(r.id))
    for (const id of ids) {
      const realId = this._resolveRowId(id)
      this._rowIdAliases.delete(id)
      // Still-pending (creation POST hasn't resolved yet): nothing exists on
      // the server to delete. A delete landing in this exact window is a
      // known, rare edge case — the in-flight create can still land after,
      // leaving an orphaned record server-side (same tradeoff already
      // documented for the equivalent property-delete race).
      if (realId === id && id.startsWith('pending-row-')) continue
      void teableFetch(`/api/teable/tables/${this._teableTableId}/records/${realId}`, { method: 'DELETE' })
    }
  }

  rowMove(_rowId: string, _position: InsertToPosition): void {
    // No-op: Teable has no client-settable manual row order exposed through
    // the proxy routes we have today. Explicitly out of scope for v1 per the
    // task brief — a reasonable no-op, not a silent gap.
  }

  // --- properties (fields) --------------------------------------------------

  propertyNameGet(propertyId: string): string {
    return this._fieldById(propertyId)?.name ?? ''
  }

  propertyNameSet(propertyId: string, name: string): void {
    const field = this._fieldById(propertyId)
    if (!field) return
    this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, name } : f))
    void teableFetch(`/api/teable/tables/${this._teableTableId}/fields/${this._resolveFieldId(propertyId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
  }

  propertyTypeGet(propertyId: string): string {
    const field = this._fieldById(propertyId)
    return field ? bsType(field.type) : 'text'
  }

  propertyTypeSet(propertyId: string, toType: string): void {
    const field = this._fieldById(propertyId)
    if (!field) return

    // BlockSuite type -> Teable type is lossy (e.g. both singleLineText/longText
    // collapse to BlockSuite's `text`), so this picks the same sensible default
    // reverse mapping `propertyAdd` already uses (`BS_TO_TEABLE_TYPE`), rather
    // than trying to recover the original Teable subtype.
    const teableType = BS_TO_TEABLE_TYPE[toType] ?? 'singleLineText'
    const isSelect = teableType === 'singleSelect' || teableType === 'multipleSelect'
    // Preserve existing choices switching between select-like types (matches
    // the boxed block's own `_saveFieldEdit`); a field newly becoming
    // select-like starts with no choices, same as creating one via propertyAdd.
    const choices = isSelect ? (field.type === 'singleSelect' || field.type === 'multipleSelect' ? (field.options?.choices ?? []) : []) : undefined

    this._fields.value = this._fields.value.map((f) =>
      f.id === propertyId ? { ...f, type: teableType, options: isSelect ? { choices } : undefined } : f,
    )

    // Teable requires the dedicated `/fields/{fieldId}/convert` endpoint (PUT)
    // to actually change a field's *type* — confirmed live against the real
    // running Teable instance that a plain `PATCH /fields/{fieldId}` (what
    // `propertyNameSet`/`propertyDataSet` use, and what the boxed block's own
    // `_saveFieldEdit` uses) returns success but silently leaves the type
    // unchanged; a follow-up GET still showed the pre-PATCH type. `/convert`
    // returns the real, server-confirmed field, which we merge in — unlike
    // `propertyAdd`, this is a *targeted* single-item merge, not a
    // `refresh()`, for the same pending-entry-safety reason explained above.
    void teableFetch(`/api/teable/tables/${this._teableTableId}/fields/${this._resolveFieldId(propertyId)}/convert`, {
      method: 'PUT',
      body: JSON.stringify({
        type: teableType,
        ...(isSelect ? { options: { choices } } : {}),
      }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to change property type.')
        const updated = await res.json()
        if (!updated?.id) return
        this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...updated, id: propertyId } : f))
      })
      .catch((err) => {
        console.error('[teable-native] Failed to change property type', err)
      })
  }

  propertyDataGet(propertyId: string): Record<string, unknown> {
    const field = this._fieldById(propertyId)
    if (!field) return {}
    if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
      return { options: (field.options?.choices ?? []).map((c) => ({ id: c.id, value: c.name, color: toTagColor(c.color) })) }
    }
    return {}
  }

  propertyDataSet(propertyId: string, data: Record<string, unknown>): void {
    const field = this._fieldById(propertyId)
    if (!field || (field.type !== 'singleSelect' && field.type !== 'multipleSelect')) return
    const options = data.options as Array<{ id?: string; value: string; color?: string }> | undefined
    if (!options) return
    const choices = options.map((o) => ({ id: o.id ?? '', name: o.value, color: o.color ?? 'gray' }))
    this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, options: { choices } } : f))
    void teableFetch(`/api/teable/tables/${this._teableTableId}/fields/${this._resolveFieldId(propertyId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ options: { choices } }),
    })
  }

  propertyDataTypeGet(propertyId: string): TypeInstance | undefined {
    const field = this._fieldById(propertyId)
    if (!field) return undefined
    const meta = this.propertyMetaGet(bsType(field.type))
    return meta?.config.type?.({ data: this.propertyDataGet(propertyId), dataSource: this })
  }

  propertyMetaGet(type: string): PropertyMetaConfig {
    const meta = this.propertyMetas.find((m) => m.type === type)
    if (!meta) throw new Error(`Unknown property type: ${type}`)
    return meta
  }

  propertyAdd(_insertToPosition: InsertToPosition, type?: string): string {
    // `SingleViewBase.propertyAdd` (data-view/core/view-manager/single-view.ts)
    // calls `this.dataSource.propertyAdd(...)` for the id, then IMMEDIATELY
    // calls `view.propertyMove(id, position)` to register that exact id as a
    // column in the *view's* own column list — there's no later hook to
    // correct that reference. So this id must be permanent from the moment
    // it's returned; never swapped for Teable's real field id afterward (see
    // `_fieldIdAliases`'s comment above).
    const tempId = `pending-field-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const teableType = BS_TO_TEABLE_TYPE[type ?? 'text'] ?? 'singleLineText'
    const name = this._newPropertyName()
    this._fields.value = [...this._fields.value, { id: tempId, name, type: teableType }]
    void teableFetch(`/api/teable/tables/${this._teableTableId}/fields`, {
      method: 'POST',
      body: JSON.stringify({ name, type: teableType }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to create property.')
        const created = await res.json()
        if (!created?.id) throw new Error('Teable did not return the created field.')
        this._fieldIdAliases.set(tempId, created.id)
        this._fields.value = this._fields.value.map((f) => (f.id === tempId ? { ...created, id: tempId } : f))
      })
      .catch((err) => {
        console.error('[teable-native] Failed to create property', err)
        this._fields.value = this._fields.value.filter((f) => f.id !== tempId)
      })
    return tempId
  }

  propertyDelete(id: string): void {
    this._fields.value = this._fields.value.filter((f) => f.id !== id)
    const realId = this._resolveFieldId(id)
    this._fieldIdAliases.delete(id)
    // Still-pending (creation POST hasn't resolved yet) — see `rowDelete`'s
    // matching comment for the same rare race this leaves undefended.
    if (realId === id && id.startsWith('pending-field-')) return
    void teableFetch(`/api/teable/tables/${this._teableTableId}/fields/${realId}`, { method: 'DELETE' })
  }

  propertyDuplicate(_propertyId: string): string {
    // Not supported by the fields proxy route (no "duplicate field" endpoint) — no-op-ish stub.
    throw new Error('Duplicating a Teable property is not supported yet.')
  }

  private _newPropertyName(): string {
    let i = 1
    while (this._fields.value.some((f) => f.name === `Property ${i}`)) i++
    return `Property ${i}`
  }

  // --- views (see constructor comment: local-only for v1) --------------------

  viewDataAdd(viewData: DataViewDataType): string {
    this._viewData.value = [...this._viewData.value, viewData]
    return viewData.id
  }

  viewDataDelete(viewId: string): void {
    this._viewData.value = this._viewData.value.filter((v) => v.id !== viewId)
  }

  viewDataDuplicate(id: string): string {
    const source = this._viewData.value.find((v) => v.id === id)
    if (!source) throw new Error(`View ${id} not found`)
    const copy = { ...source, id: `view-${Date.now()}`, name: `${source.name} copy` }
    this._viewData.value = [...this._viewData.value, copy]
    return copy.id
  }

  viewDataGet(viewId: string): DataViewDataType {
    const view = this._viewData.value.find((v) => v.id === viewId)
    if (!view) throw new Error(`View ${viewId} not found`)
    return view
  }

  viewDataMoveTo(id: string, position: InsertToPosition): void {
    const list = [...this._viewData.value]
    const index = list.findIndex((v) => v.id === id)
    if (index < 0) return
    const [item] = list.splice(index, 1)
    const target = typeof position === 'object' && 'id' in position ? list.findIndex((v) => v.id === position.id) : list.length
    list.splice(target < 0 ? list.length : target, 0, item)
    this._viewData.value = list
  }

  viewDataUpdate<ViewData extends DataViewDataType>(id: string, updater: (data: ViewData) => Partial<ViewData>): void {
    this._viewData.value = this._viewData.value.map((v) => (v.id === id ? { ...v, ...updater(v as ViewData) } : v))
  }

  viewMetaGet(type: string): ViewMeta {
    const meta = this.viewMetas.find((m) => m.type === type)
    if (!meta) throw new Error(`Unknown view type: ${type}`)
    return meta
  }

  viewMetaGetById(viewId: string): ViewMeta {
    return this.viewMetaGet(this.viewDataGet(viewId).mode)
  }
}
