import { popMenu, popupTargetFromElement, menu, type PopupTarget } from '@/lib/blocksuite-affine-components'
import { BaseCellRenderer, createFromBaseCellRenderer, propertyType, t } from '@/lib/blocksuite-data-view'
import type { ReadonlySignal } from '@preact/signals-core'
import { html } from 'lit/static-html.js'
import {
  aggregationsFor,
  displayComputed,
  validateFormula,
  type RollupAggregation,
} from '@/lib/database/computed'
import { FORMULA_FUNCTIONS } from '@/lib/database/formula'
import type { UserDatabaseDataSource } from './user-database-data-source'

/**
 * R13-P2 — `formula` and `rollup` as real property types.
 *
 * THE THING THAT MAKES THESE DIFFERENT FROM EVERY OTHER PROPERTY. A text cell
 * stores what you typed. A formula cell stores NOTHING: its value is derived
 * from the rest of the row, and what the property stores is the EXPRESSION.
 * So the editor here edits the definition, never the value, and the cell is
 * read-only by construction rather than by a disabled flag someone can forget.
 *
 * Evaluation itself lives in `lib/database/` — no BlockSuite, no DOM, 47 tests
 * — and the data source calls it. This file is only the surface: show the
 * computed value, and let someone define how it is computed. Putting the
 * evaluator behind a cell renderer would have made it untestable and would
 * have tied the semantics of a formula to the framework rendering it.
 *
 * The renderers follow `relation-property.ts` exactly (`propertyType(...)
 * .modelConfig(...)`, a `BaseCellRenderer` pair, `.createPropertyMeta(...)`),
 * because that file already proved the shape against this version of
 * `@blocksuite/data-view`, which ships no computed-property preset.
 */

export interface FormulaPropertyData extends Record<string, unknown> {
  expression?: string
}

export interface RollupPropertyData extends Record<string, unknown> {
  relationPropertyId?: string
  targetPropertyId?: string
  aggregation?: RollupAggregation
}

/**
 * What a computed cell carries.
 *
 * The data source hands over the already-evaluated value, and an error
 * arrives as a tagged object rather than as a string, so a broken formula can
 * be rendered as a failure instead of as text that happens to read like one.
 */
export interface ComputedCellValue {
  display: string
  error?: string
}

function readComputed(value: unknown): ComputedCellValue {
  if (value && typeof value === 'object' && '__formulaError' in value) {
    const message = String((value as { message?: unknown }).message ?? 'This value cannot be computed.')
    return { display: message, error: message }
  }
  if (value === null || value === undefined) return { display: '' }
  if (Array.isArray(value)) return { display: value.map((item) => String(item ?? '')).join(', ') }
  return { display: String(value) }
}

// --- formula ----------------------------------------------------------------

export const formulaPropertyType = propertyType('formula')

export const formulaPropertyModelConfig = formulaPropertyType.modelConfig<unknown, FormulaPropertyData>({
  name: 'Formula',
  type: () => t.string.instance(),
  defaultData: () => ({ expression: '' }),
  formatValue: ({ value }) => value,
  isEmpty: ({ value }) => readComputed(value).display.length === 0,
  cellToString: ({ value }) => readComputed(value).display,
  // A formula cell cannot be typed into or pasted over — its value is not its
  // own. Same "not supported this way" posture `relation` takes for the same
  // reason.
  cellFromString: () => ({ value: null }),
  cellToJson: ({ value }) => readComputed(value).display,
  cellFromJson: () => undefined,
})

/**
 * The minimal slice of a BlockSuite `Property` these config-openers need.
 * Not imported from `@blocksuite/data-view` because `Property<Value, Data>`
 * itself isn't part of that package's public export surface — only
 * `SingleView`'s `propertyGet(): Property` return type is (checked against
 * `dist/core/view-manager/index.d.ts`, which re-exports `single-view.js` and
 * `view-manager.js` but never `property.js`) — so there is nothing to
 * `export *` through the `lib/blocksuite-*` wrapper by name. Modeling just
 * what's actually used here avoids depending on an unexported type at all.
 */
interface PropertyHandle<Data extends Record<string, unknown>> {
  readonly id: string
  readonly name$: ReadonlySignal<string>
  readonly data$: ReadonlySignal<Data>
  dataUpdate(updater: (data: Data) => Partial<Data>): void
}

/**
 * NOTION-PARITY/property-popup — WHY every config-opener below takes this
 * shape instead of being a private method on the cell renderer classes (the
 * shape `_openEditor`/`_pickRelation` etc. originally had): BlockSuite's own
 * property-type picker (`@blocksuite/data-view`'s `core/common/property-
 * menu.js`) calls `property.typeSet?.(type)` and nothing else — no lifecycle
 * hook fires after a property becomes `formula`/`rollup`, so a user picking
 * one of these types from the header dropdown had no way to discover that
 * clicking into an actual CELL is what opens the real editor. The fix is to
 * open the SAME editor immediately after the type is set — but that moment
 * happens in `UserDatabaseDataSource.propertyTypeSet` (see that file), which
 * has a property id and a data source, never a mounted cell/`BaseCellRenderer`
 * to call `popupTargetFromElement(this)` or `this.selectCurrentCell(...)`
 * on. Pulling the popup-building logic out into plain functions taking an
 * explicit `anchor`/`onClose` lets BOTH callers — the cell's own
 * `firstUpdated()` (anchored to the cell, closing back into cell-selection)
 * and the data source's post-typeSet hook (anchored to the column header,
 * closing into nothing) — share one implementation, per the task's own
 * requirement to reuse this UI rather than rewrite it.
 */
interface ConfigHost<Data extends Record<string, unknown>> {
  dataSource: UserDatabaseDataSource
  property: PropertyHandle<Data>
  anchor: PopupTarget
  onClose: () => void
  /**
   * Lets a cell-rendered caller register each popup's `close` with its own
   * `_disposables` (so the popup force-closes if the cell unmounts mid-flow,
   * the original behavior) without this module depending on `BaseCellRenderer`
   * at all. Defaults to a no-op for the header-anchored, no-cell caller — its
   * popups still self-close on outside click/Escape either way.
   */
  track?: (close: () => void) => void
}

class ComputedCellBase<Data extends Record<string, unknown>> extends BaseCellRenderer<unknown, Data> {
  protected get _dataSource() {
    return this.cell.view.manager.dataSource as UserDatabaseDataSource
  }

  protected renderComputed(placeholder: string) {
    const computed = readComputed(this.value)
    if (computed.error) {
      return html`<span
        title=${computed.error}
        style="font-size:14px;color:var(--affine-error-color, #eb4335);display:inline-flex;align-items:center;gap:4px;"
        >⚠ ${computed.error}</span
      >`
    }
    if (computed.display.length === 0) {
      return html`<span style="color:var(--affine-text-disable-color);font-size:14px;">${placeholder}</span>`
    }
    return html`<span style="font-size:14px;">${computed.display}</span>`
  }
}

export class FormulaCell extends ComputedCellBase<FormulaPropertyData> {
  override render() {
    const expression = this.property.data$.value.expression ?? ''
    return this.renderComputed(expression.trim() === '' ? 'Click to write a formula…' : '')
  }
}

/**
 * The editor is a popup over the property, not an inline text box.
 *
 * A formula belongs to the COLUMN: editing it in one cell changes every row,
 * and an inline editor that looks like a cell edit would make that look like
 * a per-row change. The popup names the column and lists the properties and
 * functions available, because "what can I reference" is the first question
 * anyone writing one has. Reused both by `FormulaCellEditing.firstUpdated()`
 * (a cell was clicked) and, now, by `UserDatabaseDataSource.propertyTypeSet`
 * (the type was JUST changed to Formula) — see `ConfigHost`'s comment above.
 */
export function openFormulaConfig(host: ConfigHost<FormulaPropertyData>): () => void {
  const { dataSource, property, anchor, onClose, track } = host
  const properties = dataSource.properties$.value
    .map((id) => dataSource.propertyNameGet(id))
    .filter((name) => name && name !== property.name$.value)

  const input = document.createElement('input')
  input.value = property.data$.value.expression ?? ''
  input.placeholder = 'e.g. round(Price * Quantity, 2)'
  input.style.cssText =
    'width:100%;padding:6px 8px;border:1px solid var(--affine-border-color);border-radius:6px;font-size:13px;font-family:monospace;'

  const error = document.createElement('div')
  error.style.cssText = 'font-size:11px;color:var(--affine-error-color, #eb4335);min-height:14px;margin-top:4px;'

  const hint = document.createElement('div')
  hint.style.cssText =
    'font-size:11px;color:var(--affine-text-secondary-color);margin-top:6px;line-height:1.5;max-width:360px;'
  hint.textContent =
    (properties.length > 0 ? `Properties: ${properties.join(', ')}. ` : '') +
    `Functions: ${FORMULA_FUNCTIONS.slice(0, 12).join(', ')}…`

  const commit = () => {
    const expression = input.value
    // Refused HERE, before the write, so a broken formula never reaches
    // every row in the table as an error cell.
    const failure = expression.trim() === '' ? null : validateFormula(expression)
    if (failure) {
      error.textContent = failure.message
      return false
    }
    // No invalidation call: the data source derives computed cells with
    // `computed()` over the fields signal this write lands in, so the table
    // updates itself.
    property.dataUpdate((data) => ({ ...data, expression }))
    return true
  }

  input.addEventListener('input', () => {
    const failure = input.value.trim() === '' ? null : validateFormula(input.value)
    error.textContent = failure ? failure.message : ''
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.stopPropagation()
      if (commit()) handler.close()
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      handler.close()
    }
  })

  const container = document.createElement('div')
  container.style.cssText = 'padding:8px;min-width:320px;'
  container.append(input, error, hint)

  const handler = popMenu(anchor, {
    options: {
      title: { text: `Formula — ${property.name$.value}` },
      items: [menu.group({ name: '', items: [] })],
      onClose: () => {
        commit()
        onClose()
      },
    },
  })
  // The menu primitive has no free-form content slot, so the input is
  // attached to the popup element itself. Deliberate and small: building a
  // second popup implementation to avoid it would be a much larger surface
  // than one appendChild. `querySelectorAll(...).at(-1)` rather than
  // `querySelector` (the original, single-caller version of this function):
  // the header-triggered caller opens this popup right after BlockSuite's
  // own type-picker submenu closes, and grabbing whichever `affine-menu`
  // happens to be *first* in the document would risk attaching the input to
  // a stale, unrelated one instead of the one `popMenu` just created.
  queueMicrotask(() => {
    const popups = document.querySelectorAll('affine-menu, [data-menu-root]')
    const popup = popups[popups.length - 1]
    popup?.appendChild(container)
    input.focus()
    input.select()
  })
  track?.(handler.close)
  return handler.close
}

export class FormulaCellEditing extends ComputedCellBase<FormulaPropertyData> {
  override firstUpdated() {
    openFormulaConfig({
      dataSource: this._dataSource,
      property: this.property,
      anchor: popupTargetFromElement(this),
      onClose: () => this.selectCurrentCell(false),
      track: (close) => this._disposables.add(close),
    })
  }

  override render() {
    return this.renderComputed('Writing a formula…')
  }
}

export const formulaPropertyConfig = formulaPropertyModelConfig.createPropertyMeta({
  cellRenderer: {
    view: createFromBaseCellRenderer(FormulaCell),
    edit: createFromBaseCellRenderer(FormulaCellEditing),
  },
})

// --- rollup -----------------------------------------------------------------

export const rollupPropertyType = propertyType('rollup')

export const rollupPropertyModelConfig = rollupPropertyType.modelConfig<unknown, RollupPropertyData>({
  name: 'Rollup',
  type: () => t.string.instance(),
  defaultData: () => ({ aggregation: 'count_values' as RollupAggregation }),
  formatValue: ({ value }) => value,
  isEmpty: ({ value }) => readComputed(value).display.length === 0,
  cellToString: ({ value }) => readComputed(value).display,
  cellFromString: () => ({ value: null }),
  cellToJson: ({ value }) => readComputed(value).display,
  cellFromJson: () => undefined,
})

export class RollupCell extends ComputedCellBase<RollupPropertyData> {
  override render() {
    const data = this.property.data$.value
    const configured = data.relationPropertyId && data.targetPropertyId
    return this.renderComputed(configured ? '' : 'Click to choose what to roll up…')
  }
}

/**
 * Three questions in order: through which relation, which property over
 * there, and how to combine it.
 *
 * Asked as three menus rather than one dialog because each answer narrows
 * the next — the target properties depend on the relation, and the
 * aggregations depend on the target property's type. Offering "average" for
 * a checkbox is how a rollup editor teaches people it does not understand
 * their data. Each step takes the same `host` all the way through the chain
 * (rather than re-deriving `anchor`/`onClose` per step) so a header-anchored
 * call stays anchored to that same header through all three questions.
 */
function openRollupRelationPicker(host: ConfigHost<RollupPropertyData>) {
  const { dataSource, property, anchor, onClose, track } = host
  const relations = dataSource.relationProperties()
  if (relations.length === 0) {
    const handler = popMenu(anchor, {
      options: {
        title: { text: 'No relations yet' },
        items: [
          menu.action({
            name: 'A rollup reads through a relation — add a relation property first.',
            select: () => undefined,
          }),
        ],
        onClose,
      },
    })
    track?.(handler.close)
    return
  }

  const handler = popMenu(anchor, {
    options: {
      title: { text: 'Roll up through' },
      items: relations.map((relation) =>
        menu.action({
          name: relation.name,
          select: () => {
            property.dataUpdate((data) => ({
              ...data,
              relationPropertyId: relation.id,
              // A relation change invalidates both later answers; keeping
              // them would silently point the rollup at a property in a
              // database it no longer reads.
              targetPropertyId: undefined,
            }))
            queueMicrotask(() => openRollupTargetPropertyPicker(host, relation.id))
          },
        }),
      ),
      onClose,
    },
  })
  track?.(handler.close)
}

function openRollupTargetPropertyPicker(host: ConfigHost<RollupPropertyData>, relationPropertyId: string) {
  const { dataSource, property, anchor, onClose, track } = host
  void dataSource.targetPropertiesFor(relationPropertyId).then((properties) => {
    if (properties.length === 0) return
    const handler = popMenu(anchor, {
      options: {
        title: { text: 'Roll up which property' },
        search: { placeholder: 'Search properties…' },
        items: properties.map((prop) =>
          menu.action({
            name: prop.name,
            select: () => {
              property.dataUpdate((data) => ({ ...data, targetPropertyId: prop.id }))
              queueMicrotask(() => openRollupAggregationPicker(host, prop.type))
            },
          }),
        ),
        onClose,
      },
    })
    track?.(handler.close)
  })
}

function openRollupAggregationPicker(host: ConfigHost<RollupPropertyData>, targetType: string) {
  const { property, anchor, onClose, track } = host
  const handler = popMenu(anchor, {
    options: {
      title: { text: 'Calculate' },
      items: aggregationsFor(targetType).map((aggregation) =>
        menu.action({
          name: AGGREGATION_LABELS[aggregation],
          select: () => {
            property.dataUpdate((data) => ({ ...data, aggregation }))
          },
        }),
      ),
      onClose,
    },
  })
  track?.(handler.close)
}

/**
 * Entry point shared by `RollupCellEditing.firstUpdated()` and, now,
 * `UserDatabaseDataSource.propertyTypeSet` — see `ConfigHost`'s comment.
 * Re-entering a configured rollup goes straight to the last question, which
 * is the one people come back to change.
 */
export function openRollupConfig(host: ConfigHost<RollupPropertyData>) {
  const data = host.property.data$.value
  if (data.relationPropertyId && data.targetPropertyId) {
    void host.dataSource.targetPropertiesFor(data.relationPropertyId).then((properties) => {
      const target = properties.find((prop) => prop.id === data.targetPropertyId)
      openRollupAggregationPicker(host, target?.type ?? 'text')
    })
    return
  }
  openRollupRelationPicker(host)
}

export class RollupCellEditing extends ComputedCellBase<RollupPropertyData> {
  override firstUpdated() {
    openRollupConfig({
      dataSource: this._dataSource,
      property: this.property,
      anchor: popupTargetFromElement(this),
      onClose: () => this.selectCurrentCell(false),
      track: (close) => this._disposables.add(close),
    })
  }

  override render() {
    return this.renderComputed('Choosing…')
  }
}

export const AGGREGATION_LABELS: Record<RollupAggregation, string> = {
  show_original: 'Show original',
  count_all: 'Count all',
  count_values: 'Count values',
  count_unique: 'Count unique values',
  count_empty: 'Count empty',
  count_not_empty: 'Count not empty',
  percent_empty: 'Percent empty',
  percent_not_empty: 'Percent not empty',
  sum: 'Sum',
  average: 'Average',
  median: 'Median',
  min: 'Min',
  max: 'Max',
  range: 'Range',
  earliest: 'Earliest date',
  latest: 'Latest date',
}

export const rollupPropertyConfig = rollupPropertyModelConfig.createPropertyMeta({
  cellRenderer: {
    view: createFromBaseCellRenderer(RollupCell),
    edit: createFromBaseCellRenderer(RollupCellEditing),
  },
})

export { displayComputed }
