import type { PropertyMetaConfig, TypeInstance } from '@blocksuite/data-view'
import { propertyPresets } from '@blocksuite/data-view/property-presets'
import type { InsertToPosition } from '@blocksuite/affine-shared/utils'
import { signal, type ReadonlySignal } from '@preact/signals-core'
import { GenericDataSource, type GenericField, type GenericRecord } from './generic-data-source'
import { relationPropertyConfig } from './relation-property'
import { openGenericRecordDetailPanel } from './generic-record-detail-panel'

// ROADMAP P2.3/D4 — backs an `affine:database` block with the generic
// `databases`/`database-rows` Payload collections instead of any system
// table. Unlike `TeableDataSource` (bridging a foreign REST API's own type
// vocabulary) or `PayloadDataSource` (bridging a fixed, code-defined
// collection schema), this data source *owns* its storage format end to
// end — a field's `type` is already a BlockSuite property-preset type
// string, and cell values are stored exactly as BlockSuite hands them over
// (keyed by field id, not name). That's why most of the translation
// machinery `TeableDataSource` needs simply doesn't exist here.

async function userDbFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
}

interface DatabaseDoc {
  id: number
  name: string
  fields?: GenericField[] | null
}

interface TargetDatabaseEntry {
  fields: GenericField[]
  records: GenericRecord[]
}

export class UserDatabaseDataSource extends GenericDataSource {
  get propertyMetas(): PropertyMetaConfig[] {
    return [
      propertyPresets.textPropertyConfig,
      propertyPresets.numberPropertyConfig,
      propertyPresets.checkboxPropertyConfig,
      propertyPresets.selectPropertyConfig,
      propertyPresets.multiSelectPropertyConfig,
      propertyPresets.datePropertyConfig,
      relationPropertyConfig,
    ] as PropertyMetaConfig[]
  }

  // NOTION-PARITY 1 — cache of other databases' fields+rows, populated
  // lazily by `loadTargetDatabase` as relation cells need them (a relation
  // field points at a database this data source doesn't otherwise load at
  // all). Signal-backed so cell renderers (which extend `SignalWatcher`)
  // re-render automatically once an async load resolves.
  private readonly _targetDatabaseCache = signal<Map<number, TargetDatabaseEntry>>(new Map())

  get targetDatabaseCache$(): ReadonlySignal<Map<number, TargetDatabaseEntry>> {
    return this._targetDatabaseCache
  }

  constructor(
    private readonly _databaseId: number,
    private readonly _workspaceId: number,
  ) {
    super()
  }

  /** Public for `generic-record-detail-panel.ts`'s reverse-link lookup, which
   * needs to know which database the row it's showing actually belongs to. */
  get databaseId(): number {
    return this._databaseId
  }

  protected async fetchFields(): Promise<GenericField[]> {
    const res = await userDbFetch(`/api/user-databases/${this._databaseId}`)
    const json = await res.json().catch(() => null)
    const doc = json?.doc as DatabaseDoc | undefined
    return Array.isArray(doc?.fields) ? doc!.fields! : []
  }

  protected async fetchRecords(): Promise<GenericRecord[]> {
    const res = await userDbFetch(`/api/user-databases/${this._databaseId}/rows`)
    const json = await res.json().catch(() => ({ docs: [] }))
    const docs: { id: number; cells?: Record<string, unknown> | null }[] = Array.isArray(json.docs) ? json.docs : []
    return docs.map((d) => ({ id: String(d.id), fields: d.cells ?? {} }))
  }

  protected getPrimaryFieldId(fields: GenericField[]): string | undefined {
    // No foreign "primary field" concept to read here (unlike Teable) — the
    // first defined property is a reasonable default for the hover-expand
    // title column, same fallback `TeableDataSource` uses when Teable's own
    // `isPrimary` flag is absent.
    return fields[0]?.id
  }

  /** Fires a debounced PATCH of the *whole* `fields` array — every property
   * mutation (add/delete/rename/retype) boils down to this, since the schema
   * lives as one JSON blob on the `databases` doc (see `collections/Databases.ts`). */
  private _persistFields() {
    this._debouncedCall('fields', 300, () => {
      void userDbFetch(`/api/user-databases/${this._databaseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: this._fields.value }),
      })
    })
  }

  // --- relations (NOTION-PARITY 1) ------------------------------------------

  /** Every `databases` doc in this data source's workspace, for the "link to
   * database" picker (`relation-property.ts`'s `_pickTargetDatabase`). */
  async listDatabases(): Promise<{ id: number; name: string }[]> {
    const res = await userDbFetch(`/api/user-databases?workspaceId=${this._workspaceId}`)
    const json = await res.json().catch(() => ({ docs: [] }))
    // Deliberately includes this data source's own database — self-reference
    // is a legitimate relation (e.g. a "parent task" field on `tasks` itself).
    return Array.isArray(json.docs) ? json.docs : []
  }

  /** Fetches+caches a target database's fields/rows for relation cell
   * rendering/picking. Idempotent — returns the cached entry if already
   * loaded, never refetches on every cell render. */
  async loadTargetDatabase(targetDatabaseId: number): Promise<TargetDatabaseEntry> {
    const cached = this._targetDatabaseCache.value.get(targetDatabaseId)
    if (cached) return cached
    const [fieldsRes, rowsRes] = await Promise.all([
      userDbFetch(`/api/user-databases/${targetDatabaseId}`),
      userDbFetch(`/api/user-databases/${targetDatabaseId}/rows`),
    ])
    const fieldsJson = await fieldsRes.json().catch(() => null)
    const rowsJson = await rowsRes.json().catch(() => ({ docs: [] }))
    const fields: GenericField[] = Array.isArray(fieldsJson?.doc?.fields) ? fieldsJson.doc.fields : []
    const rowDocs: { id: number; cells?: Record<string, unknown> | null }[] = Array.isArray(rowsJson.docs) ? rowsJson.docs : []
    const entry: TargetDatabaseEntry = {
      fields,
      records: rowDocs.map((d) => ({ id: String(d.id), fields: d.cells ?? {} })),
    }
    const next = new Map(this._targetDatabaseCache.value)
    next.set(targetDatabaseId, entry)
    this._targetDatabaseCache.value = next
    return entry
  }

  /** Best-effort display text for a linked row: its target database's
   * primary field value. Degrades to the raw row id if the target database
   * hasn't finished loading yet (never silently blank — same "don't let
   * content disappear" standard used for markdown export elsewhere in this
   * app) or the row was deleted since the link was made. */
  getTargetRowLabel(targetDatabaseId: number, rowId: string): string {
    const entry = this._targetDatabaseCache.value.get(targetDatabaseId)
    if (!entry) return rowId
    const row = entry.records.find((r) => r.id === rowId)
    if (!row) return `(deleted row ${rowId})`
    const primaryFieldId = entry.fields[0]?.id
    const label = primaryFieldId ? row.fields[primaryFieldId] : undefined
    return typeof label === 'string' && label.trim() ? label : 'Untitled'
  }

  /** NOTION-PARITY 1, requirement 4 — bidirectional visibility computed at
   * read time, not stored: for a row in `targetDatabaseId`, finds every OTHER
   * database in the same workspace with a relation field pointing back at
   * `targetDatabaseId`, and returns whichever of THEIR rows reference this
   * one. No reciprocal write on link/unlink — avoids write-amplification and
   * the two-sided-consistency bugs that come with it; the cost is a scan
   * across the workspace's databases on read, acceptable at this scale (a
   * single user's workspace, not a multi-tenant table). */
  async getReverseLinks(targetDatabaseId: number, rowId: string): Promise<{ databaseId: number; databaseName: string; fieldId: string; rowId: string; label: string }[]> {
    const databases = await this.listDatabases()
    const results: { databaseId: number; databaseName: string; fieldId: string; rowId: string; label: string }[] = []
    for (const db of databases) {
      const entry = await this.loadTargetDatabase(db.id)
      const relationFields = entry.fields.filter((f) => f.type === 'relation' && f.options?.targetDatabaseId === targetDatabaseId)
      if (relationFields.length === 0) continue
      const primaryFieldId = entry.fields[0]?.id
      for (const field of relationFields) {
        for (const row of entry.records) {
          const linked = row.fields[field.id]
          if (Array.isArray(linked) && linked.includes(rowId)) {
            const label = primaryFieldId ? row.fields[primaryFieldId] : undefined
            results.push({
              databaseId: db.id,
              databaseName: db.name,
              fieldId: field.id,
              rowId: row.id,
              label: typeof label === 'string' && label.trim() ? label : 'Untitled',
            })
          }
        }
      }
    }
    return results
  }

  /** Opens the real BlockSuite `RecordDetail` panel for a linked row —
   * requirement 5: same click-to-detail UX Teable's relation chips already
   * have. Builds a fresh `UserDatabaseDataSource` + its default table view
   * for the *target* database (this data source only holds its own). */
  async openRelatedRow(targetDatabaseId: number, rowId: string): Promise<void> {
    const target = new UserDatabaseDataSource(targetDatabaseId, this._workspaceId)
    await target.refresh()
    const view = target.viewManager.viewGet('table-view')
    openGenericRecordDetailPanel({ view, rowId })
  }

  // --- cells --------------------------------------------------------------
  // Values are stored exactly as BlockSuite hands them over, keyed by field
  // id — no name/id or color-token translation needed, since this data
  // source owns the storage format.

  cellValueGet(rowId: string, propertyId: string): unknown {
    return this._recordById(rowId)?.fields[propertyId]
  }

  cellValueChange(rowId: string, propertyId: string, value: unknown): void {
    const record = this._recordById(rowId)
    if (!record) return

    this._records.value = this._records.value.map((r) =>
      r.id === rowId ? { ...r, fields: { ...r.fields, [propertyId]: value } } : r,
    )

    this._debouncedCall(`${rowId}:${propertyId}`, 500, () => {
      void userDbFetch(`/api/user-databases/${this._databaseId}/rows/${this._resolveRowId(rowId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ cells: { [propertyId]: value } }),
      })
    })
  }

  // --- rows -----------------------------------------------------------------

  rowAdd(_insertToPosition: InsertToPosition | number): string {
    // Rows are real Payload documents with a server-assigned numeric id, so
    // (unlike `propertyAdd` below) this still needs the optimistic-id/alias
    // pattern — same reasoning as `TeableDataSource.rowAdd`.
    return this._optimisticCreate<GenericRecord>({
      tempIdPrefix: 'pending-row',
      target: this._records,
      aliasMap: this._rowIdAliases,
      placeholder: { fields: {} },
      logLabel: 'rowAdd',
      create: async () => {
        const res = await userDbFetch(`/api/user-databases/${this._databaseId}/rows`, {
          method: 'POST',
          body: JSON.stringify({ cells: {} }),
        })
        if (!res.ok) throw new Error('Failed to create row.')
        const json = await res.json()
        if (!json?.doc?.id) throw new Error('Server did not return the created row.')
        return { id: String(json.doc.id), fields: json.doc.cells ?? {} }
      },
    })
  }

  rowDelete(ids: string[]): void {
    this._records.value = this._records.value.filter((r) => !ids.includes(r.id))
    for (const id of ids) {
      const realId = this._resolveRowId(id)
      this._rowIdAliases.delete(id)
      if (realId === id && id.startsWith('pending-row-')) continue
      void userDbFetch(`/api/user-databases/${this._databaseId}/rows/${realId}`, { method: 'DELETE' })
    }
  }

  // --- properties (fields) --------------------------------------------------
  // No id-aliasing needed for fields at all: the schema is one JSON blob this
  // data source already owns, so a new field's id can be generated locally
  // and included directly in what gets persisted — there's no foreign
  // id-generator to wait on, unlike `TeableDataSource.propertyAdd`. This is
  // the concrete example `_optimisticCreate`'s own doc comment points at.

  propertyNameSet(propertyId: string, name: string): void {
    const field = this._fieldById(propertyId)
    if (!field) return
    this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, name } : f))
    this._persistFields()
  }

  propertyTypeGet(propertyId: string): string {
    return this._fieldById(propertyId)?.type ?? 'text'
  }

  propertyTypeSet(propertyId: string, toType: string): void {
    const field = this._fieldById(propertyId)
    if (!field) return
    const isSelect = toType === 'select' || toType === 'multi-select'
    const wasSelect = field.type === 'select' || field.type === 'multi-select'
    const isRelation = toType === 'relation'
    this._fields.value = this._fields.value.map((f) =>
      f.id === propertyId
        ? {
            ...f,
            type: toType,
            options: isSelect
              ? { choices: wasSelect ? (f.options?.choices ?? []) : [] }
              : isRelation
                // No `targetDatabaseId` yet — `RelationCellEditing` prompts to
                // pick one on first edit (unless retyping an existing relation
                // field, which keeps whatever it already pointed at).
                ? { targetDatabaseId: f.options?.targetDatabaseId, cardinality: f.options?.cardinality ?? 'many' }
                : undefined,
          }
        : f,
    )
    this._persistFields()
  }

  propertyDataGet(propertyId: string): Record<string, unknown> {
    const field = this._fieldById(propertyId)
    if (!field) return {}
    if (field.type === 'select' || field.type === 'multi-select') {
      return { options: (field.options?.choices ?? []).map((c) => ({ id: c.id, value: c.name, color: c.color })) }
    }
    if (field.type === 'relation') {
      return { targetDatabaseId: field.options?.targetDatabaseId, cardinality: field.options?.cardinality ?? 'many' }
    }
    return {}
  }

  propertyDataSet(propertyId: string, data: Record<string, unknown>): void {
    const field = this._fieldById(propertyId)
    if (!field) return
    if (field.type === 'select' || field.type === 'multi-select') {
      const options = data.options as Array<{ id?: string; value: string; color?: string }> | undefined
      if (!options) return
      const choices = options.map((o, i) => ({ id: o.id || `choice-${Date.now()}-${i}`, name: o.value, color: o.color ?? 'grey' }))
      this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, options: { choices } } : f))
      this._persistFields()
      return
    }
    if (field.type === 'relation') {
      const targetDatabaseId = typeof data.targetDatabaseId === 'number' ? data.targetDatabaseId : field.options?.targetDatabaseId
      const cardinality = data.cardinality === 'one' ? 'one' : 'many'
      this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, options: { targetDatabaseId, cardinality } } : f))
      this._persistFields()
    }
  }

  propertyDataTypeGet(propertyId: string): TypeInstance | undefined {
    const field = this._fieldById(propertyId)
    if (!field) return undefined
    const meta = this.propertyMetaGet(field.type)
    return meta?.config.type?.({ data: this.propertyDataGet(propertyId), dataSource: this })
  }

  propertyAdd(_insertToPosition: InsertToPosition, type?: string): string {
    const id = `field-${crypto.randomUUID()}`
    const newField: GenericField = { id, name: this._newPropertyName(), type: type ?? 'text' }
    this._fields.value = [...this._fields.value, newField]
    this._persistFields()
    return id
  }

  propertyDelete(id: string): void {
    this._fields.value = this._fields.value.filter((f) => f.id !== id)
    this._persistFields()
  }

  propertyDuplicate(propertyId: string): string {
    const field = this._fieldById(propertyId)
    if (!field) throw new Error(`Property ${propertyId} not found`)
    const id = `field-${crypto.randomUUID()}`
    const index = this._fields.value.findIndex((f) => f.id === propertyId)
    const copy: GenericField = { ...field, id, name: `${field.name} copy` }
    const list = [...this._fields.value]
    list.splice(index + 1, 0, copy)
    this._fields.value = list
    this._persistFields()
    return id
  }
}
