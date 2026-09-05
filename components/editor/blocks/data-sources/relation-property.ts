import { popMenu, popupTargetFromElement, menu, type PopupTarget } from '@/lib/blocksuite-affine-components'
import { BaseCellRenderer, createFromBaseCellRenderer, propertyType, t } from '@/lib/blocksuite-data-view'
import { computed, type ReadonlySignal } from '@preact/signals-core'
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

/**
 * The minimal slice of a BlockSuite `Property` these config-openers need —
 * not imported from `@blocksuite/data-view` because `Property<Value, Data>`
 * isn't part of that package's public export surface (see the identical
 * comment in `computed-property.ts`, which hit the same gap first).
 */
interface PropertyHandle<Data extends Record<string, unknown>> {
  readonly id: string
  readonly data$: ReadonlySignal<Data>
  dataUpdate(updater: (data: Data) => Partial<Data>): void
}

/**
 * NOTION-PARITY/property-popup — same motivation as `computed-property.ts`'s
 * `ConfigHost`: BlockSuite's property-type picker only ever calls
 * `property.typeSet?.('relation')`, with no follow-up, so picking Relation
 * from the header dropdown left a column with no target database and no
 * visible way to set one short of clicking a cell. `openRelationConfig`
 * below reuses `_pickTargetDatabase`/`_configureRelation`'s exact popups —
 * pulled out to take an explicit `anchor`/`onClose` — from BOTH the cell's
 * `firstUpdated()` and `UserDatabaseDataSource.propertyTypeSet`. Deliberately
 * NOT reused for `_pickRows`: that step assigns row ids to one specific
 * cell's value, which only makes sense once a row is in play — the
 * header-triggered flow stops at the column-level half (target database +
 * two-way), which is the actual "configuration."
 */
interface RelationConfigHost {
  dataSource: UserDatabaseDataSource
  property: PropertyHandle<RelationPropertyData>
  anchor: PopupTarget
  onClose: () => void
  track?: (close: () => void) => void
}

function openRelationTargetDatabasePicker(host: RelationConfigHost, afterConfigured: (targetId: number) => void) {
  const { dataSource, property, anchor, onClose, track } = host
  void dataSource.listDatabases().then((databases) => {
    const handler = popMenu(anchor, {
      options: {
        title: { text: 'Link to database' },
        search: { placeholder: 'Search databases…' },
        items: databases.map((d) =>
          menu.action({
            name: d.name,
            select: () => {
              property.dataUpdate((data) => ({ ...data, targetDatabaseId: d.id }))
              openRelationTypeConfig(host, d.id, afterConfigured)
            },
          }),
        ),
        onClose,
      },
    })
    track?.(handler.close)
  })
}

/** NOTION-PARITY 7 — one-way/two-way toggle, shown right after picking a
 * target database (first-time setup) and reachable again later via the
 * "⚙" affordance next to an already-configured field's chips (or, now, right
 * after picking Relation as the type). `afterConfigured` is what differs by
 * caller: a cell chains into `_pickRows` (assign THIS row's links); the
 * header-triggered flow just finishes. */
function openRelationTypeConfig(host: RelationConfigHost, targetId: number, afterConfigured: (targetId: number) => void) {
  const { dataSource, property, anchor, track } = host
  let twoWay = property.data$.value.twoWay ?? false
  const handler = popMenu(anchor, {
    options: {
      title: { text: 'Relationship' },
      items: [
        menu.toggleSwitch({
          name: 'Two-way',
          on: twoWay,
          label: () => html`Show on linked database`,
          onChange: (on) => {
            twoWay = on
            void dataSource.setRelationTwoWay(property.id, on).catch((err) => {
              console.error('[relation] failed to toggle two-way sync', err)
            })
          },
        }),
      ],
      onClose: () => afterConfigured(targetId),
    },
  })
  track?.(handler.close)
}

/** Entry point for `UserDatabaseDataSource.propertyTypeSet` — see
 * `RelationConfigHost`'s comment on why this stops short of `_pickRows`. */
export function openRelationConfig(host: RelationConfigHost) {
  const targetId = host.property.data$.value.targetDatabaseId
  if (targetId) openRelationTypeConfig(host, targetId, () => host.onClose())
  else openRelationTargetDatabasePicker(host, () => host.onClose())
}

export class RelationCellEditing extends RelationChips {
  private get _value(): string[] {
    return Array.isArray(this.value) ? this.value : []
  }

  private _host(): RelationConfigHost {
    return {
      dataSource: this._dataSource,
      property: this.property,
      anchor: popupTargetFromElement(this),
      onClose: () => this.selectCurrentCell(false),
      track: (close) => this._disposables.add(close),
    }
  }

  private _pickTargetDatabase() {
    openRelationTargetDatabasePicker(this._host(), (targetId) => this._pickRows(targetId))
  }

  private _configureRelation(targetId: number) {
    openRelationTypeConfig(this._host(), targetId, (id) => this._pickRows(id))
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
