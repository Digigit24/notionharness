import {
  popMenu,
  popupTargetFromElement,
  menu,
} from '@blocksuite/affine-components/context-menu'
import { BaseCellRenderer, createFromBaseCellRenderer, propertyType, t } from '@blocksuite/data-view'
import { computed } from '@preact/signals-core'
import { html } from 'lit/static-html.js'
import type { UserDatabaseDataSource } from './user-database-data-source'

// NOTION-PARITY 1 — a `relation` property type, built entirely from scratch:
// `@blocksuite/data-view` ships no relation/link property preset at all
// (confirmed against its published API — property types are just string
// identifiers with arbitrary config, extensible via a custom
// `PropertyMetaConfig`, same mechanism `propertyPresets`' own
// select/multi-select use, just without a shipped starting point). Structured
// the same way `multi-select` is (`propertyType(...).modelConfig(...)`, a
// `BaseCellRenderer` pair for view/edit, `.createPropertyMeta(...)`) since
// that's the closest existing shape (multiple chip values, editable picker).
//
// Cell value: `string[]` of target-database row ids, always an array
// regardless of cardinality (a `'one'` field is just capped at length 1) —
// keeps storage uniform instead of branching the value's own shape.
// Field data (`RelationPropertyData`): `{ targetDatabaseId?, cardinality? }`.
// Only `UserDatabaseDataSource` implements this — Teable/Payload already
// have (or don't need) their own link concepts, see the task's own scope.

export interface RelationPropertyData extends Record<string, unknown> {
  targetDatabaseId?: number
  cardinality?: 'one' | 'many'
  // NOTION-PARITY 7 — mirrors real Notion's "Show on [database]" toggle.
  // `twoWay: true` means a REAL field with id `mirrorFieldId` was created on
  // the target database (see `UserDatabaseDataSource.setRelationTwoWay`),
  // kept in sync on every write — not just the always-on, computed-at-read
  // "Linked from" panel section every relation already gets regardless of
  // this setting (see `getReverseLinks`).
  twoWay?: boolean
  mirrorFieldId?: string
}

export const relationPropertyType = propertyType('relation')

export const relationPropertyModelConfig = relationPropertyType.modelConfig<string[], RelationPropertyData>({
  name: 'Relation',
  type: () => t.array.instance(t.string.instance()),
  defaultData: () => ({ cardinality: 'many' }),
  formatValue: ({ value }) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []),
  isEmpty: ({ value }) => !value || value.length === 0,
  cellToString: ({ value, data, dataSource }) => {
    const ds = dataSource as UserDatabaseDataSource
    if (!Array.isArray(value) || !data.targetDatabaseId) return ''
    return value.map((id) => ds.getTargetRowLabel(data.targetDatabaseId!, id)).join(', ')
  },
  // Relation cells aren't meant to be typed/pasted as plain text (which row
  // would "Acme Corp, Beta Inc" even mean without a search+pick step?) — same
  // "not supported this way" posture as `TeableDataSource.propertyDuplicate`.
  cellFromString: ({ value }) => ({ value: [], data: { raw: value } }),
  cellToJson: ({ value }) => (Array.isArray(value) ? value : null),
  cellFromJson: ({ value }) => (Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined),
})

function fieldLabel(ds: UserDatabaseDataSource, targetDatabaseId: number, rowId: string) {
  return ds.getTargetRowLabel(targetDatabaseId, rowId)
}

/** Shared by both view/edit cells: renders the current linked rows as
 * clickable chips (opens the real row detail panel, per the task's own
 * "same UX as Teable's relation-click-to-detail-panel behavior"), plus any
 * *reverse* links computed at read time (see `UserDatabaseDataSource.getReverseLinks`). */
class RelationChips extends BaseCellRenderer<string[], RelationPropertyData> {
  protected get _dataSource() {
    return this.cell.view.manager.dataSource as UserDatabaseDataSource
  }

  protected get _targetId() {
    return this.property.data$.value.targetDatabaseId
  }

  override connectedCallback() {
    super.connectedCallback()
    const targetId = this._targetId
    if (targetId) void this._dataSource.loadTargetDatabase(targetId)
  }

  private _openRow(rowId: string, e: Event) {
    e.stopPropagation()
    const targetId = this._targetId
    if (!targetId) return
    void this._dataSource.openRelatedRow(targetId, rowId)
  }

  override render() {
    const targetId = this._targetId
    const ids = Array.isArray(this.value) ? this.value : []
    if (!targetId) {
      return html`<span style="color:var(--affine-text-disable-color);font-size:14px;">Click to choose a database…</span>`
    }
    // Reads `_dataSource.targetDatabaseCache$.value` so this re-renders once
    // `loadTargetDatabase`'s fetch resolves (`BaseCellRenderer` extends
    // `SignalWatcher`, so reading a signal's `.value` inside `render()` is
    // enough to subscribe — no manual event wiring needed).
    void this._dataSource.targetDatabaseCache$.value
    return html`
      <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
        ${ids.map(
          (id) => html`<span
            style="display:inline-flex;align-items:center;padding:1px 8px;border-radius:4px;background:var(--affine-hover-color);cursor:pointer;font-size:14px;"
            @click=${(e: Event) => this._openRow(id, e)}
          >${fieldLabel(this._dataSource, targetId, id)}</span>`,
        )}
      </div>
    `
  }
}

export class RelationCell extends RelationChips {}

export class RelationCellEditing extends RelationChips {
  private get _value(): string[] {
    return Array.isArray(this.value) ? this.value : []
  }

  private _pickTargetDatabase() {
    void this._dataSource.listDatabases().then((databases) => {
      const handler = popMenu(popupTargetFromElement(this), {
        options: {
          title: { text: 'Link to database' },
          search: { placeholder: 'Search databases…' },
          items: databases.map((d) =>
            menu.action({
              name: d.name,
              select: () => {
                this.property.dataUpdate((data) => ({ ...data, targetDatabaseId: d.id }))
                this._configureRelation(d.id)
              },
            }),
          ),
          onClose: () => this.selectCurrentCell(false),
        },
      })
      this._disposables.add(handler.close)
    })
  }

  /** NOTION-PARITY 7 — one-way/two-way toggle, shown right after picking a
   * target database (first-time setup) and reachable again later via the
   * "⚙" affordance next to an already-configured field's chips. Closing this
   * popup (click-away/Escape) chains straight into `_pickRows` so setup
   * flows as one motion the first time, without forcing a second click. */
  private _configureRelation(targetId: number) {
    let twoWay = this.property.data$.value.twoWay ?? false
    const handler = popMenu(popupTargetFromElement(this), {
      options: {
        title: { text: 'Relationship' },
        items: [
          menu.toggleSwitch({
            name: 'Two-way',
            on: twoWay,
            label: () => html`Show on linked database`,
            onChange: (on) => {
              twoWay = on
              void this._dataSource.setRelationTwoWay(this.property.id, on).catch((err) => {
                console.error('[relation] failed to toggle two-way sync', err)
              })
            },
          }),
        ],
        onClose: () => this._pickRows(targetId),
      },
    })
    this._disposables.add(handler.close)
  }

  private _pickRows(targetId: number) {
    void this._dataSource.loadTargetDatabase(targetId).then((entry) => {
      const cardinality = this.property.data$.value.cardinality ?? 'many'
      const selected = new Set(this._value)
      const rerenderChecked = (id: string) => computed(() => selected.has(id))
      const items =
        entry.records.length > 0
          ? entry.records.map((row) => {
              const label = fieldLabel(this._dataSource, targetId, row.id)
              if (cardinality === 'one') {
                return menu.action({
                  name: label,
                  isSelected: selected.has(row.id),
                  select: () => {
                    this.onChange([row.id])
                  },
                })
              }
              return menu.checkbox({
                name: label,
                checked: rerenderChecked(row.id),
                select: () => {
                  if (selected.has(row.id)) selected.delete(row.id)
                  else selected.add(row.id)
                  this.onChange([...selected])
                  return false
                },
              })
            })
          : [menu.action({ name: 'No rows in that database yet', select: () => {} })]
      const handler = popMenu(popupTargetFromElement(this), {
        options: {
          title: { text: 'Link rows' },
          search: { placeholder: 'Search rows…' },
          items,
          onClose: () => this.selectCurrentCell(false),
        },
      })
      this._disposables.add(handler.close)
    })
  }

  override firstUpdated() {
    const targetId = this._targetId
    if (targetId) this._pickRows(targetId)
    else this._pickTargetDatabase()
  }

  // Adds a "⚙" affordance (re-open `_configureRelation`) after the inherited
  // chip rendering, so an already-configured field's two-way setting stays
  // reachable without deleting and re-adding the property.
  override render() {
    const base = super.render()
    const targetId = this._targetId
    if (!targetId) return base
    return html`<div style="display:flex;align-items:center;gap:4px;">
      ${base}
      <span
        title="Relationship settings"
        style="cursor:pointer;color:var(--affine-icon-color);font-size:13px;"
        @click=${(e: Event) => {
          e.stopPropagation()
          this._configureRelation(targetId)
        }}
      >⚙</span>
    </div>`
  }
}

export const relationPropertyConfig = relationPropertyModelConfig.createPropertyMeta({
  cellRenderer: {
    view: createFromBaseCellRenderer(RelationCell),
    edit: createFromBaseCellRenderer(RelationCellEditing),
  },
})
