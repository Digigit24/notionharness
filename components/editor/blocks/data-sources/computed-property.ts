import { popMenu, popupTargetFromElement, menu } from '@/lib/blocksuite-affine-components'
import { BaseCellRenderer, createFromBaseCellRenderer, propertyType, t } from '@/lib/blocksuite-data-view'
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

export class FormulaCellEditing extends ComputedCellBase<FormulaPropertyData> {
  /**
   * The editor is a popup over the property, not an inline text box.
   *
   * A formula belongs to the COLUMN: editing it in one cell changes every row,
   * and an inline editor that looks like a cell edit would make that look like
   * a per-row change. The popup names the column and lists the properties and
   * functions available, because "what can I reference" is the first question
   * anyone writing one has.
   */
  private _openEditor() {
    const properties = this._dataSource
      .properties$.value.map((id) => this._dataSource.propertyNameGet(id))
      .filter((name) => name && name !== this.property.name$.value)

    const input = document.createElement('input')
    input.value = this.property.data$.value.expression ?? ''
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
      this.property.dataUpdate((data) => ({ ...data, expression }))
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

    const handler = popMenu(popupTargetFromElement(this), {
      options: {
        title: { text: `Formula — ${this.property.name$.value}` },
        items: [menu.group({ name: '', items: [] })],
        onClose: () => {
          commit()
          this.selectCurrentCell(false)
        },
      },
    })
    // The menu primitive has no free-form content slot, so the input is
    // attached to the popup element itself. Deliberate and small: building a
    // second popup implementation to avoid it would be a much larger surface
    // than one appendChild.
    queueMicrotask(() => {
      const popup = document.querySelector('affine-menu, [data-menu-root]')
      popup?.appendChild(container)
      input.focus()
      input.select()
    })
    this._disposables.add(handler.close)
  }

  override firstUpdated() {
    this._openEditor()
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

export class RollupCellEditing extends ComputedCellBase<RollupPropertyData> {
  /**
   * Three questions in order: through which relation, which property over
   * there, and how to combine it.
   *
   * Asked as three menus rather than one dialog because each answer narrows
   * the next — the target properties depend on the relation, and the
   * aggregations depend on the target property's type. Offering "average" for
   * a checkbox is how a rollup editor teaches people it does not understand
   * their data.
   */
  private _pickRelation() {
    const source = this._dataSource
    const relations = source.relationProperties()
    if (relations.length === 0) {
      const handler = popMenu(popupTargetFromElement(this), {
        options: {
          title: { text: 'No relations yet' },
          items: [
            menu.action({
              name: 'A rollup reads through a relation — add a relation property first.',
              select: () => undefined,
            }),
          ],
          onClose: () => this.selectCurrentCell(false),
        },
      })
      this._disposables.add(handler.close)
      return
    }

    const handler = popMenu(popupTargetFromElement(this), {
      options: {
        title: { text: 'Roll up through' },
        items: relations.map((relation) =>
          menu.action({
            name: relation.name,
            select: () => {
              this.property.dataUpdate((data) => ({
                ...data,
                relationPropertyId: relation.id,
                // A relation change invalidates both later answers; keeping
                // them would silently point the rollup at a property in a
                // database it no longer reads.
                targetPropertyId: undefined,
              }))
              queueMicrotask(() => this._pickTargetProperty(relation.id))
            },
          }),
        ),
        onClose: () => this.selectCurrentCell(false),
      },
    })
    this._disposables.add(handler.close)
  }

  private _pickTargetProperty(relationPropertyId: string) {
    const source = this._dataSource
    void source.targetPropertiesFor(relationPropertyId).then((properties) => {
      if (properties.length === 0) return
      const handler = popMenu(popupTargetFromElement(this), {
        options: {
          title: { text: 'Roll up which property' },
          search: { placeholder: 'Search properties…' },
          items: properties.map((property) =>
            menu.action({
              name: property.name,
              select: () => {
                this.property.dataUpdate((data) => ({ ...data, targetPropertyId: property.id }))
                queueMicrotask(() => this._pickAggregation(property.type))
              },
            }),
          ),
          onClose: () => this.selectCurrentCell(false),
        },
      })
      this._disposables.add(handler.close)
    })
  }

  private _pickAggregation(targetType: string) {
    const handler = popMenu(popupTargetFromElement(this), {
      options: {
        title: { text: 'Calculate' },
        items: aggregationsFor(targetType).map((aggregation) =>
          menu.action({
            name: AGGREGATION_LABELS[aggregation],
            select: () => {
              this.property.dataUpdate((data) => ({ ...data, aggregation }))
            },
          }),
        ),
        onClose: () => this.selectCurrentCell(false),
      },
    })
    this._disposables.add(handler.close)
  }

  override firstUpdated() {
    const data = this.property.data$.value
    // Re-entering a configured rollup goes straight to the last question,
    // which is the one people come back to change.
    if (data.relationPropertyId && data.targetPropertyId) {
      void this._dataSource.targetPropertiesFor(data.relationPropertyId).then((properties) => {
        const target = properties.find((property) => property.id === data.targetPropertyId)
        this._pickAggregation(target?.type ?? 'text')
      })
      return
    }
    this._pickRelation()
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
