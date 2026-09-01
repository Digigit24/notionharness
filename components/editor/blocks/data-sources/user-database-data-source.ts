import type { PropertyMetaConfig, TypeInstance } from '@blocksuite/data-view'
import { propertyPresets } from '@blocksuite/data-view/property-presets'
import type { InsertToPosition } from '@blocksuite/affine-shared/utils'
import { GenericDataSource, type GenericField, type GenericRecord } from './generic-data-source'

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

export class UserDatabaseDataSource extends GenericDataSource {
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

  constructor(private readonly _databaseId: number) {
    super()
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
    this._fields.value = this._fields.value.map((f) =>
      f.id === propertyId
        ? { ...f, type: toType, options: isSelect ? { choices: wasSelect ? (f.options?.choices ?? []) : [] } : undefined }
        : f,
    )
    this._persistFields()
  }

  propertyDataGet(propertyId: string): Record<string, unknown> {
    const field = this._fieldById(propertyId)
    if (!field || (field.type !== 'select' && field.type !== 'multi-select')) return {}
    return { options: (field.options?.choices ?? []).map((c) => ({ id: c.id, value: c.name, color: c.color })) }
  }

  propertyDataSet(propertyId: string, data: Record<string, unknown>): void {
    const field = this._fieldById(propertyId)
    if (!field || (field.type !== 'select' && field.type !== 'multi-select')) return
    const options = data.options as Array<{ id?: string; value: string; color?: string }> | undefined
    if (!options) return
    const choices = options.map((o, i) => ({ id: o.id || `choice-${Date.now()}-${i}`, name: o.value, color: o.color ?? 'grey' }))
    this._fields.value = this._fields.value.map((f) => (f.id === propertyId ? { ...f, options: { choices } } : f))
    this._persistFields()
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
