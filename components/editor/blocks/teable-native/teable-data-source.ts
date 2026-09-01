import type { PropertyMetaConfig, TypeInstance } from '@blocksuite/data-view'
import { propertyPresets } from '@blocksuite/data-view/property-presets'
import type { InsertToPosition } from '@blocksuite/affine-shared/utils'
import { GenericDataSource, type GenericField, type GenericRecord } from '../data-sources/generic-data-source'

// Real Teable-backed `DataSource` for BlockSuite's native `DataView` renderer
// (the table/kanban UI itself is untouched — this class is the only thing
// that's new). Modeled directly on BlockSuite's own `DatabaseBlockDataSource`
// (`node_modules/@blocksuite/blocks/src/database-block/data-source.ts`), the
// only shipped implementation that fully satisfies `DataSourceBase` without
// an `@ts-ignore` escape hatch — the OTHER shipped example
// (`BlockQueryDataSource`) does NOT fully implement the interface (missing
// `viewManager`/`viewMetas`/several `$` signals, needs `@ts-ignore` to
// compile), so it was not usable as a template.
//
// ROADMAP P2.3/D3/D4: this is the reference implementation `GenericDataSource`
// was extracted from. Everything backend-agnostic (views, id-aliasing,
// refresh's view-seeding, the optimistic-create pattern) now lives there;
// what's left here is genuinely Teable-specific — its own type vocabulary,
// its own REST proxy routes, its own select-choice/date/number value shapes.

interface TeableChoice {
  id: string
  name: string
  color: string
}

interface TeableField extends GenericField {
  options?: { choices?: TeableChoice[] }
}

type TeableRecord = GenericRecord

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

export class TeableDataSource extends GenericDataSource {
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

  protected async fetchFields(): Promise<GenericField[]> {
    const res = await teableFetch(`/api/teable/tables/${this._teableTableId}/fields`)
    const json = await res.json().catch(() => [])
    return Array.isArray(json) ? json : []
  }

  protected async fetchRecords(): Promise<GenericRecord[]> {
    const res = await teableFetch(`/api/teable/tables/${this._teableTableId}/records`)
    const json = await res.json().catch(() => ({ records: [] }))
    return Array.isArray(json.records) ? json.records : []
  }

  protected getPrimaryFieldId(fields: GenericField[]): string | undefined {
    // Same fix as before extraction: `defaultData` (in BlockSuite's own
    // `view-presets/table/define.ts`) picks `header.titleColumn` by finding
    // a property whose BlockSuite type is literally `'title'` — a type this
    // data source never produces (`bsType()` only maps to
    // text/number/checkbox/select/multi-select/date), so it's always
    // `undefined` there. That silently disables the hover-to-expand row
    // icon: `TableRow.render()` (view-presets/table/pc/row/row.ts) only
    // renders it on the column matching `mainProperties$.value.titleColumn`
    // — nothing to do with the column's *type*, just its id. Point it at
    // Teable's own primary field (or the first field, if that flag is ever
    // missing) so the native affordance has a column to attach to.
    return (fields as TeableField[]).find((f) => f.isPrimary)?.id ?? fields[0]?.id
  }

  // --- cells --------------------------------------------------------------

  cellValueGet(rowId: string, propertyId: string): unknown {
    const field = this._fieldById(propertyId) as TeableField | undefined
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
    const field = this._fieldById(propertyId) as TeableField | undefined
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

    // Resolved at fire time (not schedule time): a cell edit on a row
    // created moments ago may still be waiting on `rowAdd`'s creation POST
    // when this timer is scheduled, but the alias is very likely resolved by
    // the time this 500ms debounce actually fires.
    this._debouncedCall(`${rowId}:${propertyId}`, 500, () => {
      void teableFetch(`/api/teable/tables/${this._teableTableId}/records/${this._resolveRowId(rowId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ record: { fields: { [field.name]: teableValue } } }),
      })
    })
  }

  // --- rows -----------------------------------------------------------------

  rowAdd(_insertToPosition: InsertToPosition | number): string {
    return this._optimisticCreate<TeableRecord>({
      tempIdPrefix: 'pending-row',
      target: this._records,
      aliasMap: this._rowIdAliases,
      placeholder: { fields: {} },
      logLabel: 'rowAdd',
      create: async () => {
        const res = await teableFetch(`/api/teable/tables/${this._teableTableId}/records`, {
          method: 'POST',
          body: JSON.stringify({ records: [{ fields: {} }] }),
        })
        if (!res.ok) throw new Error('Failed to create row.')
        const json = await res.json()
        const created: TeableRecord | undefined = json.records?.[0] ?? json.record
        if (!created?.id) throw new Error('Teable did not return the created record.')
        return created
      },
    })
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

  // --- properties (fields) --------------------------------------------------

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
    const field = this._fieldById(propertyId) as TeableField | undefined
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
    // `refresh()`, for the same pending-entry-safety reason explained in
    // `GenericDataSource`'s `_optimisticCreate` comment.
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
    const field = this._fieldById(propertyId) as TeableField | undefined
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

  propertyAdd(_insertToPosition: InsertToPosition, type?: string): string {
    const teableType = BS_TO_TEABLE_TYPE[type ?? 'text'] ?? 'singleLineText'
    const name = this._newPropertyName()
    // See `GenericDataSource._optimisticCreate`'s comment for why the id this
    // returns must never change identity afterward.
    return this._optimisticCreate<TeableField>({
      tempIdPrefix: 'pending-field',
      target: this._fields,
      aliasMap: this._fieldIdAliases,
      placeholder: { name, type: teableType },
      logLabel: 'propertyAdd',
      create: async () => {
        const res = await teableFetch(`/api/teable/tables/${this._teableTableId}/fields`, {
          method: 'POST',
          body: JSON.stringify({ name, type: teableType }),
        })
        if (!res.ok) throw new Error('Failed to create property.')
        const created = await res.json()
        if (!created?.id) throw new Error('Teable did not return the created field.')
        return created
      },
    })
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
}
