import { propertyPresets, type PropertyMetaConfig, type TypeInstance } from '@/lib/blocksuite-data-view'
import type { InsertToPosition } from '@/lib/blocksuite-affine-shared'
import { GenericDataSource, type GenericField, type GenericRecord } from './generic-data-source'
import { showClientError } from '@/lib/client-notify'

// ROADMAP P2.3/D5 — backs an `affine:database` block with a real Payload
// collection ("system tables" per D5/D4 — `pages` today; `tasks`/`projects`
// once 2.1 lands). Unlike Teable or `UserDatabaseDataSource`, the schema
// here is *fixed*: it's whatever `app/api/payload-datasource/_lib.ts`'s
// small, explicit allowlist maps for that collection, defined in code, not
// runtime-editable by an end user — so property add/delete/rename/retype
// all throw a clear "not supported" error, same established precedent as
// `TeableDataSource.propertyDuplicate`. Only cell values (existing fields on
// existing docs) and row add/delete are real, working operations.

async function payloadDsFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
}

export class PayloadDataSource extends GenericDataSource {
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

  constructor(
    private readonly _collection: string,
    private readonly _workspaceId: number,
  ) {
    super()
  }

  private _schemaNotEditableError(op: string): Error {
    return new Error(`${op}: this database's schema comes from the "${this._collection}" Payload collection and can't be edited from here.`)
  }

  protected async fetchFields(): Promise<GenericField[]> {
    const res = await payloadDsFetch(`/api/payload-datasource/${this._collection}?workspaceId=${this._workspaceId}`)
    const json = await res.json().catch(() => null)
    // A non-OK response used to fall through to `json?.properties ?? []` —
    // an empty schema, indistinguishable from "this collection genuinely has
    // no fields yet." That silently rendered a blank table instead of the
    // block's own error state, which already exists and already has a
    // "Change table" recovery action — it just never got the message.
    if (!res.ok) throw new Error(json?.error || `Failed to load this table's columns (HTTP ${res.status}).`)
    const properties: Array<{ id: string; name: string; type: string; isPrimary?: boolean }> = json?.properties ?? []
    return properties.map((p) => ({ id: p.id, name: p.name, type: p.type, isPrimary: p.isPrimary }))
  }

  protected async fetchRecords(): Promise<GenericRecord[]> {
    const res = await payloadDsFetch(`/api/payload-datasource/${this._collection}?workspaceId=${this._workspaceId}`)
    const json = await res.json().catch(() => ({ docs: [] }))
    if (!res.ok) throw new Error(json?.error || `Failed to load this table's rows (HTTP ${res.status}).`)
    const docs: { id: number; fields: Record<string, unknown> }[] = Array.isArray(json.docs) ? json.docs : []
    return docs.map((d) => ({ id: String(d.id), fields: d.fields }))
  }

  protected getPrimaryFieldId(fields: GenericField[]): string | undefined {
    return fields.find((f) => f.isPrimary)?.id ?? fields[0]?.id
  }

  // --- cells --------------------------------------------------------------

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
      void payloadDsFetch(`/api/payload-datasource/${this._collection}/records/${this._resolveRowId(rowId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ propertyId, value }),
      }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      }).catch((err) => {
        console.error('[data-source] cell edit failed', err)
        showClientError("Couldn't save this edit. Check your connection and try again.")
      })
    })
  }

  // --- rows -----------------------------------------------------------------

  rowAdd(_insertToPosition: InsertToPosition | number): string {
    return this._optimisticCreate<GenericRecord>({
      tempIdPrefix: 'pending-row',
      target: this._records,
      aliasMap: this._rowIdAliases,
      placeholder: { fields: {} },
      logLabel: 'rowAdd',
      create: async () => {
        const res = await payloadDsFetch(`/api/payload-datasource/${this._collection}`, {
          method: 'POST',
          body: JSON.stringify({ workspaceId: this._workspaceId }),
        })
        if (!res.ok) throw new Error('Failed to create row.')
        const json = await res.json()
        if (!json?.doc?.id) throw new Error('Server did not return the created row.')
        return { id: String(json.doc.id), fields: json.doc.fields ?? {} }
      },
    })
  }

  rowDelete(ids: string[]): void {
    this._records.value = this._records.value.filter((r) => !ids.includes(r.id))
    for (const id of ids) {
      const realId = this._resolveRowId(id)
      this._rowIdAliases.delete(id)
      if (realId === id && id.startsWith('pending-row-')) continue
      void payloadDsFetch(`/api/payload-datasource/${this._collection}/records/${realId}`, { method: 'DELETE' })
    }
  }

  // --- properties (fields): schema is fixed, so only reads are real ---------

  propertyTypeGet(propertyId: string): string {
    return this._fieldById(propertyId)?.type ?? 'text'
  }

  propertyDataGet(_propertyId: string): Record<string, unknown> {
    return {}
  }

  propertyDataTypeGet(propertyId: string): TypeInstance | undefined {
    const field = this._fieldById(propertyId)
    if (!field) return undefined
    const meta = this.propertyMetaGet(field.type)
    return meta?.config.type?.({ data: {}, dataSource: this })
  }

  propertyNameSet(): void {
    throw this._schemaNotEditableError('propertyNameSet')
  }

  propertyTypeSet(): void {
    throw this._schemaNotEditableError('propertyTypeSet')
  }

  propertyDataSet(): void {
    throw this._schemaNotEditableError('propertyDataSet')
  }

  propertyAdd(): string {
    throw this._schemaNotEditableError('propertyAdd')
  }

  propertyDelete(): void {
    throw this._schemaNotEditableError('propertyDelete')
  }

  propertyDuplicate(): string {
    throw this._schemaNotEditableError('propertyDuplicate')
  }
}
