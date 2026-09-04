/**
 * R13-P2.3 — rollups, and the dependency graph that makes them safe.
 *
 * A rollup reads THROUGH a relation: "the sum of `Amount` on every Invoice
 * linked to this Customer". That makes it the first thing in this product
 * whose value depends on rows in a different table, which is why the graph
 * below spans databases rather than living inside one.
 *
 * TWO DECISIONS, BOTH TAKEN AGAINST D0.
 *
 * **Cycles are refused when a property is SAVED, not discovered when a cell is
 * drawn.** A formula referencing a rollup referencing a formula that
 * references it back is not a rendering bug to catch with a depth limit — it
 * is a schema the user did not mean to write, and the moment to say so is
 * while they are still looking at the dialog. `wouldCycle()` answers that in
 * the property editor, before the write.
 *
 * **Evaluation is ordered once, not resolved per cell.** `evaluationOrder()`
 * topologically sorts the computed properties so a table with a formula over a
 * rollup over a relation is one pass over the rows, not a recursive resolve per
 * cell with a memo table. Recursion here would be the read-time N+1 D0 forbids,
 * dressed up as a cache.
 */
import { parseFormula, referencedProperties, evaluateFormula, type Node } from './formula'
import {
  EMPTY,
  asNumber,
  asString,
  err,
  fromCell,
  isEmpty,
  isError,
  list,
  num,
  str,
  type DbValue,
} from './values'

export type RollupAggregation =
  | 'show_original'
  | 'count_all'
  | 'count_values'
  | 'count_unique'
  | 'count_empty'
  | 'count_not_empty'
  | 'percent_empty'
  | 'percent_not_empty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'earliest'
  | 'latest'

export interface FormulaSpec {
  kind: 'formula'
  /** The source as the author typed it. Kept verbatim so the editor shows
   * back what was written, and re-parsed once per table, never per row. */
  expression: string
}

export interface RollupSpec {
  kind: 'rollup'
  /** A property on THIS database whose type is `relation`. */
  relationPropertyId: string
  /** A property on the database that relation points at. */
  targetPropertyId: string
  aggregation: RollupAggregation
}

export type ComputedSpec = FormulaSpec | RollupSpec

/** The subset of a property this module needs. Deliberately structural rather
 * than importing `GenericField`: this runs on the server too, where the
 * BlockSuite types are not available and must not be dragged in. */
export interface PropertyLike {
  id: string
  name: string
  type: string
  options?: {
    targetDatabaseId?: number
    computed?: ComputedSpec
  }
}

export interface RowLike {
  id: string
  cells: Record<string, unknown>
}

/** One database's schema and rows, as this module sees it. */
export interface DatabaseLike {
  id: number
  properties: PropertyLike[]
  rows: RowLike[]
}

export function computedSpecOf(property: PropertyLike): ComputedSpec | null {
  return property.options?.computed ?? null
}

// --- The graph --------------------------------------------------------------

/** A node is one property in one database. */
export type GraphKey = string

export function keyOf(databaseId: number, propertyId: string): GraphKey {
  return `${databaseId}:${propertyId}`
}

/**
 * Every edge "this property is read by that property".
 *
 * Built from the schemas alone — no rows are touched — so it is cheap enough
 * to rebuild whenever a property changes, which is exactly when it must be
 * rebuilt.
 */
export function buildDependencies(databases: DatabaseLike[]): Map<GraphKey, Set<GraphKey>> {
  const byId = new Map<number, DatabaseLike>(databases.map((db) => [db.id, db]))
  const deps = new Map<GraphKey, Set<GraphKey>>()

  for (const db of databases) {
    const byName = new Map(db.properties.map((p) => [p.name, p]))
    for (const property of db.properties) {
      const spec = computedSpecOf(property)
      if (!spec) continue
      const self = keyOf(db.id, property.id)
      const into = deps.get(self) ?? new Set<GraphKey>()
      deps.set(self, into)

      if (spec.kind === 'formula') {
        let parsed: Node
        try {
          parsed = parseFormula(spec.expression)
        } catch {
          // A formula that does not parse depends on nothing. It will render
          // its syntax error in every cell, which is the honest outcome, and
          // it must not stop the rest of the table being ordered.
          continue
        }
        for (const name of referencedProperties(parsed)) {
          const target = byName.get(name)
          if (target) into.add(keyOf(db.id, target.id))
        }
        continue
      }

      // A rollup depends on its own relation property AND on the target
      // property in the other database. The second edge is the one that makes
      // this graph span databases, and the one that makes a cross-database
      // cycle possible at all.
      into.add(keyOf(db.id, spec.relationPropertyId))
      const relation = db.properties.find((p) => p.id === spec.relationPropertyId)
      const targetDbId = relation?.options?.targetDatabaseId
      if (targetDbId != null && byId.has(targetDbId)) {
        into.add(keyOf(targetDbId, spec.targetPropertyId))
      }
    }
  }

  return deps
}

/**
 * Would adding this dependency close a loop?
 *
 * Called by the property editor BEFORE the write, with the edge the user is
 * about to create. Returns the cycle it found, so the refusal can name the
 * properties involved rather than saying "circular reference".
 */
export function findCycle(deps: Map<GraphKey, Set<GraphKey>>): GraphKey[] | null {
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const colour = new Map<GraphKey, number>()
  const stack: GraphKey[] = []

  const visit = (node: GraphKey): GraphKey[] | null => {
    colour.set(node, GREY)
    stack.push(node)
    for (const next of deps.get(node) ?? []) {
      const state = colour.get(next) ?? WHITE
      // Grey means "on the current path", which is the definition of a cycle.
      // Black means "finished, and it did not lead back here".
      if (state === GREY) return [...stack.slice(stack.indexOf(next)), next]
      if (state === WHITE) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    colour.set(node, BLACK)
    return null
  }

  for (const node of deps.keys()) {
    if ((colour.get(node) ?? WHITE) === WHITE) {
      const found = visit(node)
      if (found) return found
    }
  }
  return null
}

/**
 * The order to evaluate computed properties in.
 *
 * Anything caught in a cycle is returned separately rather than dropped: those
 * cells must render a cycle error, and a caller that silently omitted them
 * would leave stale values on screen instead.
 */
export function evaluationOrder(deps: Map<GraphKey, Set<GraphKey>>): { order: GraphKey[]; cyclic: Set<GraphKey> } {
  const order: GraphKey[] = []
  const done = new Set<GraphKey>()
  const inProgress = new Set<GraphKey>()
  const cyclic = new Set<GraphKey>()

  const visit = (node: GraphKey) => {
    if (done.has(node) || cyclic.has(node)) return
    if (inProgress.has(node)) {
      cyclic.add(node)
      return
    }
    inProgress.add(node)
    for (const next of deps.get(node) ?? []) visit(next)
    inProgress.delete(node)
    if (cyclic.has(node)) return
    // Only computed properties are ordered; a plain column is already a value.
    if (deps.has(node)) order.push(node)
    done.add(node)
  }

  for (const node of deps.keys()) visit(node)
  return { order, cyclic }
}

// --- Evaluation -------------------------------------------------------------

/**
 * Compute every computed cell across a set of databases.
 *
 * One pass in dependency order, mutating a value map keyed by row. The result
 * is what a caller writes back into `cells` (server side) or hands to the
 * table for display (client side) — deliberately the same function in both
 * places, because a preview that disagrees with the stored value is worse than
 * no preview.
 */
export function evaluateComputed(databases: DatabaseLike[]): Map<GraphKey, Map<string, DbValue>> {
  const byId = new Map<number, DatabaseLike>(databases.map((db) => [db.id, db]))
  const deps = buildDependencies(databases)
  const { order, cyclic } = evaluationOrder(deps)

  /** databaseId:propertyId -> rowId -> value. Plain cells are read lazily from
   * the row; only computed ones land here. */
  const computed = new Map<GraphKey, Map<string, DbValue>>()

  const cycleError = err('cycle', 'This property depends on itself, directly or through another property.')
  for (const key of cyclic) {
    const [dbId] = key.split(':')
    const db = byId.get(Number(dbId))
    const perRow = new Map<string, DbValue>()
    for (const row of db?.rows ?? []) perRow.set(row.id, cycleError)
    computed.set(key, perRow)
  }

  const valueOf = (databaseId: number, property: PropertyLike, row: RowLike): DbValue => {
    const key = keyOf(databaseId, property.id)
    const already = computed.get(key)?.get(row.id)
    if (already) return already
    return fromCell(row.cells[property.id], property.type)
  }

  for (const key of order) {
    const [dbIdRaw, propertyId] = key.split(':')
    const db = byId.get(Number(dbIdRaw))
    if (!db) continue
    const property = db.properties.find((p) => p.id === propertyId)
    const spec = property ? computedSpecOf(property) : null
    if (!property || !spec) continue

    const perRow = new Map<string, DbValue>()
    computed.set(key, perRow)

    if (spec.kind === 'formula') {
      let parsed: Node | null = null
      let syntaxError: DbValue | null = null
      try {
        parsed = parseFormula(spec.expression)
      } catch (error) {
        syntaxError = err('bad_argument', error instanceof Error ? error.message : 'That formula cannot be read.')
      }
      const byName = new Map(db.properties.map((p) => [p.name, p]))
      for (const row of db.rows) {
        if (syntaxError || !parsed) {
          perRow.set(row.id, syntaxError ?? EMPTY)
          continue
        }
        perRow.set(
          row.id,
          evaluateFormula(parsed, {
            get: (name) => {
              const target = byName.get(name)
              return target ? valueOf(db.id, target, row) : undefined
            },
          }),
        )
      }
      continue
    }

    // --- rollup
    const relation = db.properties.find((p) => p.id === spec.relationPropertyId)
    const targetDbId = relation?.options?.targetDatabaseId
    const targetDb = targetDbId == null ? undefined : byId.get(targetDbId)
    const targetProperty = targetDb?.properties.find((p) => p.id === spec.targetPropertyId)

    if (!relation || !targetDb || !targetProperty) {
      // A rollup whose relation or target was deleted says so in the cell.
      // Rendering empty would look like "no linked rows", which is a different
      // and much more misleading fact.
      const broken = err(
        'not_computable',
        !relation
          ? 'This rollup points at a relation that no longer exists.'
          : !targetDb
            ? 'This rollup points at a database that is no longer linked.'
            : 'This rollup points at a property that no longer exists.',
      )
      for (const row of db.rows) perRow.set(row.id, broken)
      continue
    }

    const targetRowsById = new Map(targetDb.rows.map((r) => [r.id, r]))
    for (const row of db.rows) {
      const linked = fromCell(row.cells[relation.id], 'relation')
      const ids = linked.kind === 'list' ? linked.value.map(asString).filter((id) => id.length > 0) : []
      const values = ids.map((id) => {
        const targetRow = targetRowsById.get(id)
        // A link to a row that has been deleted contributes nothing rather
        // than an error: the relation is stale, not the rollup.
        return targetRow ? valueOf(targetDb.id, targetProperty, targetRow) : EMPTY
      })
      perRow.set(row.id, aggregate(values, spec.aggregation))
    }
  }

  return computed
}

/**
 * The aggregations, with the empty-handling written down.
 *
 * `count_all` counts LINKS, including ones whose target cell is blank;
 * `count_values` counts non-empty values. Notion draws the same distinction
 * and it is the one people get wrong when they build this themselves.
 */
export function aggregate(values: DbValue[], aggregation: RollupAggregation): DbValue {
  const failed = values.find(isError)
  if (failed) return failed

  const present = values.filter((value) => !isEmpty(value))
  const numbers = present
    .map(asNumber)
    .filter((n): n is number => typeof n === 'number')

  switch (aggregation) {
    case 'show_original':
      return list(values)
    case 'count_all':
      return num(values.length)
    case 'count_values':
      return num(present.length)
    case 'count_unique':
      return num(new Set(present.map((value) => `${value.kind}:${asString(value)}`)).size)
    case 'count_empty':
      return num(values.length - present.length)
    case 'count_not_empty':
      return num(present.length)
    case 'percent_empty':
      return values.length === 0 ? EMPTY : num(((values.length - present.length) / values.length) * 100)
    case 'percent_not_empty':
      return values.length === 0 ? EMPTY : num((present.length / values.length) * 100)
    case 'sum':
      // Zero, not empty: "the sum of no invoices" is a number people expect to
      // see, unlike "the average of no invoices", which is not.
      return num(numbers.reduce((a, b) => a + b, 0))
    case 'average':
      return numbers.length === 0 ? EMPTY : num(numbers.reduce((a, b) => a + b, 0) / numbers.length)
    case 'median': {
      if (numbers.length === 0) return EMPTY
      const sorted = [...numbers].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return num(sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle])
    }
    case 'min':
      return numbers.length === 0 ? EMPTY : num(Math.min(...numbers))
    case 'max':
      return numbers.length === 0 ? EMPTY : num(Math.max(...numbers))
    case 'range':
      return numbers.length === 0 ? EMPTY : num(Math.max(...numbers) - Math.min(...numbers))
    case 'earliest':
      return numbers.length === 0 ? EMPTY : { kind: 'date', value: Math.min(...numbers) }
    case 'latest':
      return numbers.length === 0 ? EMPTY : { kind: 'date', value: Math.max(...numbers) }
    default:
      return err('bad_argument', `"${String(aggregation)}" is not an aggregation.`)
  }
}

/** The aggregations that make sense for a target property of a given type —
 * what the rollup editor offers, so nobody is invited to average a checkbox. */
export function aggregationsFor(targetType: string): RollupAggregation[] {
  const universal: RollupAggregation[] = [
    'show_original',
    'count_all',
    'count_values',
    'count_unique',
    'count_empty',
    'count_not_empty',
    'percent_empty',
    'percent_not_empty',
  ]
  if (targetType === 'number' || targetType === 'progress') {
    return [...universal, 'sum', 'average', 'median', 'min', 'max', 'range']
  }
  if (targetType === 'date') return [...universal, 'earliest', 'latest', 'range']
  if (targetType === 'checkbox') return [...universal]
  return universal
}

/** Render a computed value for a cell. Errors render as their message, so a
 * broken formula explains itself where it broke. */
export function displayComputed(value: DbValue): string {
  if (value.kind === 'error') return value.message
  if (value.kind === 'number') {
    // Trim the float noise that division produces without pretending to know
    // the property's format — that is the number property's own concern.
    return Number.isInteger(value.value) ? String(value.value) : String(Math.round(value.value * 1e6) / 1e6)
  }
  return asString(value)
}

/** Exported for the property editor: a formula's syntax error, or null. */
export function validateFormula(expression: string): { at: number; message: string } | null {
  try {
    parseFormula(expression)
    return null
  } catch (error) {
    if (error && typeof error === 'object' && 'at' in error) {
      const detail = error as { at?: unknown; message?: unknown }
      return { at: Number(detail.at ?? 0), message: String(detail.message ?? 'That formula cannot be read.') }
    }
    return { at: 0, message: error instanceof Error ? error.message : 'That formula cannot be read.' }
  }
}

/** Kept for callers that only need a scalar preview of one value. */
export function previewValue(value: DbValue): string {
  return isEmpty(value) ? '' : displayComputed(value)
}

/** Re-exported so a consumer needs one import for the whole feature. */
export { str as dbString, num as dbNumber }
