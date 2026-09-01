import {
  DataSourceBase,
  ViewManagerBase,
  type DatabaseFlags,
  type DataViewDataType,
  type PropertyMetaConfig,
  type ViewManager,
  type ViewMeta,
} from '@blocksuite/data-view'
import { viewPresets, viewConverts } from '@blocksuite/data-view/view-presets'
import type { InsertToPosition } from '@blocksuite/affine-shared/utils'
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals-core'

/**
 * ROADMAP P2.3/D3/D4 — the shared shape every `GenericDataSource` backend
 * stores its properties/rows in, and the abstraction point that makes
 * `TeableDataSource`/`PayloadDataSource`/`UserDatabaseDataSource`
 * interchangeable: whatever a backend's *native* schema/value system looks
 * like, it gets translated to/from this shape at the data source's own edge
 * (see e.g. `TeableDataSource`'s `TEABLE_TO_BS_TYPE`/`toTagColor`), not
 * threaded through the rest of BlockSuite's `DataView` rendering.
 */
export interface GenericChoice {
  id: string
  name: string
  color: string
}

export interface GenericField {
  id: string
  name: string
  /** Backend-native type string (e.g. Teable's `singleLineText`, or — for a
   * backend with no foreign type system, like `UserDatabaseDataSource` —
   * simply a BlockSuite property-preset type directly). */
  type: string
  options?: {
    choices?: GenericChoice[]
    /** NOTION-PARITY 1 — only meaningful when `type === 'relation'`. See
     * `data-sources/relation-property.ts` for the full property implementation. */
    targetDatabaseId?: number
    /** Defaults to `'many'` (Notion/Airtable convention) when unset. */
    cardinality?: 'one' | 'many'
  }
  /** This field is the backend's own "primary"/title column, if it has that
   * concept (Teable does; a plain user database may not). Used to seed the
   * table view's `header.titleColumn` — see `refresh()` below. */
  isPrimary?: boolean
}

export interface GenericRecord {
  id: string
  fields: Record<string, unknown>
}

/**
 * Extracted from `TeableDataSource` (the original, reference implementation
 * — see its own file for the full history of *why* each piece here is
 * shaped the way it is, especially the id-aliasing comments). This class
 * pulls out everything that was genuinely backend-agnostic in that
 * implementation — view management, the temp-id/real-id aliasing pattern
 * `propertyAdd`/`rowAdd` need because BlockSuite's `DataSourceBase` demands
 * a synchronous id return for an inherently asynchronous remote create, and
 * the `refresh()` view-seeding template — so three backends (Teable, a
 * Payload collection, or the generic `databases`/`database_rows` tables)
 * can share it instead of re-deriving it.
 *
 * What's deliberately left abstract: property *semantics* (type mapping,
 * cell value translation, select-choice handling) genuinely differ enough
 * per backend that forcing them into a shared implementation here would be
 * a leaky abstraction, not a useful one. Each concrete subclass owns those.
 */
export abstract class GenericDataSource extends DataSourceBase {
  protected readonly _fields = signal<GenericField[]>([])
  protected readonly _records = signal<GenericRecord[]>([])
  protected readonly _viewData = signal<DataViewDataType[]>([])
  private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // See `TeableDataSource`'s original comment on `_fieldIdAliases`/`_rowIdAliases`
  // for the full reasoning: `SingleViewBase.propertyAdd` registers a new
  // property's id as a view column *at the moment `propertyAdd` returns* —
  // there's no later hook to correct that reference, so an id handed out by
  // `_optimisticCreate` must never change identity, only gain a real-id alias
  // for outgoing requests.
  protected readonly _fieldIdAliases = new Map<string, string>()
  protected readonly _rowIdAliases = new Map<string, string>()

  readonly$: ReadonlySignal<boolean> = computed(() => false)
  featureFlags$: ReadonlySignal<DatabaseFlags> = computed(() => ({}) as DatabaseFlags)
  properties$: ReadonlySignal<string[]> = computed(() => this._fields.value.map((f) => f.id))
  rows$: ReadonlySignal<string[]> = computed(() => this._records.value.map((r) => r.id))
  viewConverts = [...viewConverts]
  viewDataList$: ReadonlySignal<DataViewDataType[]> = computed(() => this._viewData.value)
  viewManager: ViewManager = new ViewManagerBase(this)
  viewMetas: ViewMeta[] = [viewPresets.tableViewMeta, viewPresets.kanbanViewMeta]

  abstract get propertyMetas(): PropertyMetaConfig[]

  /** Loads fields+records from the concrete backend. Call before mounting the `DataView`. */
  async refresh() {
    const [fields, records] = await Promise.all([this.fetchFields(), this.fetchRecords()])
    this._fields.value = fields
    this._records.value = records

    // Seeded once, on first successful load (view configuration itself is
    // local-only for v1, same simplification `TeableDataSource` already
    // made — see its own comment for why `kanbanViewMeta.model.defaultData`
    // needs to run after fields are populated, and why it's wrapped in a
    // try/catch for tables with nothing groupable).
    if (this._viewData.value.length === 0) {
      const table = viewPresets.tableViewMeta.model.defaultData(this.viewManager)
      const primaryFieldId = this.getPrimaryFieldId(this._fields.value)
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

  /** Fetches the current field list from the backend. Called once per `refresh()`. */
  protected abstract fetchFields(): Promise<GenericField[]>

  /** Fetches the current record list from the backend. Called once per `refresh()`. */
  protected abstract fetchRecords(): Promise<GenericRecord[]>

  /** Which field should back the hover-to-expand title column (see
   * `TeableDataSource`'s `refresh()` comment for why this can't just be
   * "whichever field has BlockSuite type `'title'`" — no backend here
   * produces that type). Return `undefined` if there's no reasonable choice
   * (e.g. no fields yet). */
  protected abstract getPrimaryFieldId(fields: GenericField[]): string | undefined

  protected _fieldById(propertyId: string): GenericField | undefined {
    return this._fields.value.find((f) => f.id === propertyId)
  }

  protected _recordById(rowId: string): GenericRecord | undefined {
    return this._records.value.find((r) => r.id === rowId)
  }

  /** Real backend id for a field, resolving a still-locally-known temp id (see `_fieldIdAliases`). */
  protected _resolveFieldId(propertyId: string): string {
    return this._fieldIdAliases.get(propertyId) ?? propertyId
  }

  /** Real backend id for a row, resolving a still-locally-known temp id (see `_rowIdAliases`). */
  protected _resolveRowId(rowId: string): string {
    return this._rowIdAliases.get(rowId) ?? rowId
  }

  /**
   * The `propertyAdd`/`rowAdd` pattern every backend with a real remote
   * create needs: `DataSourceBase.propertyAdd`/`rowAdd` must return the new
   * id *synchronously*, but creating anything server-side is a network call.
   * Inserts `placeholder` under a temp id immediately, fires `create()` in
   * the background, and on success merges the real data in *under the same
   * temp id* (aliasing the temp id to the real one via `aliasMap` for future
   * requests) rather than replacing the id outright — see the class-level
   * comment on `_fieldIdAliases` for why identity must never change. On
   * failure, rolls the optimistic placeholder back out.
   *
   * Not used by every backend: `UserDatabaseDataSource`'s `propertyAdd`
   * doesn't need it at all (it can generate the field's id client-side and
   * include it directly in the single JSON blob it persists — there's no
   * foreign id-generator to wait on), which is a real example of this
   * abstraction not forcing an ill-fitting pattern everywhere.
   */
  protected _optimisticCreate<T extends { id: string }>(opts: {
    tempIdPrefix: string
    target: Signal<T[]>
    aliasMap: Map<string, string>
    placeholder: Omit<T, 'id'>
    create: () => Promise<T>
    logLabel: string
  }): string {
    const tempId = `${opts.tempIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    opts.target.value = [...opts.target.value, { ...opts.placeholder, id: tempId } as T]
    void opts
      .create()
      .then((created) => {
        if (!created?.id) throw new Error(`${opts.logLabel}: backend did not return a created id.`)
        opts.aliasMap.set(tempId, created.id)
        opts.target.value = opts.target.value.map((item) => (item.id === tempId ? { ...created, id: tempId } : item))
      })
      .catch((err) => {
        console.error(`[data-source] ${opts.logLabel} failed`, err)
        opts.target.value = opts.target.value.filter((item) => item.id !== tempId)
      })
    return tempId
  }

  /** Debounces a write keyed by `key` (e.g. `${rowId}:${propertyId}`), matching the
   * cell-edit debounce every backend here uses to avoid a network round-trip per keystroke. */
  protected _debouncedCall(key: string, delayMs: number, fn: () => void): void {
    const existing = this._debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    this._debounceTimers.set(
      key,
      setTimeout(() => {
        this._debounceTimers.delete(key)
        fn()
      }, delayMs),
    )
  }

  // --- views (local-only for v1, identical for every backend — see `TeableDataSource`'s
  // original constructor comment for why view *configuration* isn't synced remotely) ------

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

  // --- properties/rows: shared reads, backend-specific writes -------------------------

  propertyNameGet(propertyId: string): string {
    return this._fieldById(propertyId)?.name ?? ''
  }

  propertyMetaGet(type: string): PropertyMetaConfig {
    const meta = this.propertyMetas.find((m) => m.type === type)
    if (!meta) throw new Error(`Unknown property type: ${type}`)
    return meta
  }

  /** Default: no manual row ordering. None of the three backends here expose
   * a client-settable order today (matches `TeableDataSource`'s original
   * reasoning) — a reasonable no-op, not a silent gap. Override if a future
   * backend adds real support. */
  rowMove(_rowId: string, _position: InsertToPosition): void {}

  protected _newPropertyName(): string {
    let i = 1
    while (this._fields.value.some((f) => f.name === `Property ${i}`)) i++
    return `Property ${i}`
  }
}
