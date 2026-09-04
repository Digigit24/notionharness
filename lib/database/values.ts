/**
 * R13-P2 — the value model computed properties are defined over.
 *
 * A formula in a database is not arithmetic over JavaScript values. A cell can
 * be empty, and an empty cell is NOT zero and NOT the empty string: `sum` over
 * a column of three numbers and two blanks divides by three in Notion and by
 * five in a naive implementation, and the difference is a wrong invoice. So
 * emptiness is a first-class value here, and every operator is defined for it.
 *
 * The second thing this file exists for is TOTALITY. A formula must never
 * throw, because a thrown formula in one cell of a two-thousand-row table
 * takes the table with it. Division by zero, a date minus a string, a
 * reference to a property that was deleted — each produces an ERROR VALUE that
 * renders in its own cell and propagates predictably, exactly like a
 * spreadsheet. Nothing in this module throws for bad data; it throws only for
 * a bug in itself.
 */

export type DbValue =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: number }
  /** A relation, a multi-select, a rollup that returns many — anything that is
   * several values at once. Kept as a list rather than flattened, because
   * `count` and `sum` need to tell "one zero" from "nothing". */
  | { kind: 'list'; value: DbValue[] }
  | { kind: 'error'; code: FormulaErrorCode; message: string }

export type FormulaErrorCode =
  | 'unknown_property'
  | 'type_mismatch'
  | 'divide_by_zero'
  | 'bad_argument'
  | 'unknown_function'
  | 'cycle'
  | 'not_computable'

export const EMPTY: DbValue = { kind: 'empty' }

export function num(value: number): DbValue {
  // NaN and Infinity are how a bad arithmetic result escapes a numeric type
  // system unnoticed. Caught here, once, rather than at every call site.
  if (!Number.isFinite(value)) return err('bad_argument', 'That calculation has no numeric result.')
  return { kind: 'number', value }
}
export function str(value: string): DbValue {
  return { kind: 'string', value }
}
export function bool(value: boolean): DbValue {
  return { kind: 'boolean', value }
}
export function date(value: number): DbValue {
  return Number.isFinite(value) ? { kind: 'date', value } : err('bad_argument', 'That is not a date.')
}
export function list(value: DbValue[]): DbValue {
  return { kind: 'list', value }
}
export function err(code: FormulaErrorCode, message: string): DbValue {
  return { kind: 'error', code, message }
}

export function isError(value: DbValue): value is Extract<DbValue, { kind: 'error' }> {
  return value.kind === 'error'
}

export function isEmpty(value: DbValue): boolean {
  if (value.kind === 'empty') return true
  if (value.kind === 'string') return value.value.length === 0
  if (value.kind === 'list') return value.value.length === 0
  return false
}

/**
 * The first error in a set of operands, or null.
 *
 * Errors propagate: any operator applied to an error yields that error, so a
 * broken reference deep inside an expression surfaces as itself rather than as
 * a confusing type mismatch three levels up.
 */
export function firstError(values: DbValue[]): DbValue | null {
  for (const value of values) if (isError(value)) return value
  return null
}

/**
 * Coerce for arithmetic.
 *
 * Empty becomes NOTHING, not zero — the caller decides what nothing means for
 * its operator, because that answer differs: `1 + empty` is 1 in Notion, while
 * `average` over a column skips empties entirely rather than counting them.
 */
export function asNumber(value: DbValue): number | null | DbValue {
  switch (value.kind) {
    case 'number':
      return value.value
    case 'boolean':
      return value.value ? 1 : 0
    case 'date':
      return value.value
    case 'empty':
      return null
    case 'string': {
      if (value.value.trim() === '') return null
      const parsed = Number(value.value)
      return Number.isFinite(parsed) ? parsed : err('type_mismatch', `"${value.value}" is not a number.`)
    }
    case 'list':
      return err('type_mismatch', 'A list cannot be used as a single number.')
    case 'error':
      return value
  }
}

/** Coerce for display and string functions. An empty renders as "" — the one
 * place emptiness and the empty string are allowed to meet. */
export function asString(value: DbValue): string {
  switch (value.kind) {
    case 'string':
      return value.value
    case 'number':
      return String(value.value)
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'date':
      return new Date(value.value).toISOString()
    case 'empty':
      return ''
    case 'list':
      return value.value.map(asString).join(', ')
    case 'error':
      return value.message
  }
}

/**
 * Truthiness, Notion's way rather than JavaScript's.
 *
 * `0` is FALSE and an empty string is FALSE, as in JavaScript, but an empty
 * cell is also false and a non-empty list is true. The dangerous case JS gets
 * wrong for this domain is `[]`, which is truthy there and must not be here:
 * "if this row has any linked tasks" is the single most common condition
 * people write.
 */
export function asBoolean(value: DbValue): boolean | DbValue {
  switch (value.kind) {
    case 'boolean':
      return value.value
    case 'number':
      return value.value !== 0
    case 'string':
      return value.value.length > 0
    case 'date':
      return true
    case 'empty':
      return false
    case 'list':
      return value.value.length > 0
    case 'error':
      return value
  }
}

/**
 * Read a stored cell into the value model.
 *
 * `database-rows.cells` is a flat `fieldId -> value` json map written by
 * several generations of this product, so this has to be forgiving: a date may
 * be a number or an ISO string, a checkbox may be a boolean or the string
 * "true", a relation may be an array of ids or a single id. Being strict here
 * would mean a migration; being forgiving costs one switch.
 */
export function fromCell(raw: unknown, type: string): DbValue {
  if (raw === null || raw === undefined) return EMPTY

  switch (type) {
    case 'number':
    case 'progress':
      return typeof raw === 'number' ? num(raw) : coerceStoredNumber(raw)
    case 'checkbox':
      if (typeof raw === 'boolean') return bool(raw)
      if (raw === 'true') return bool(true)
      if (raw === 'false') return bool(false)
      return EMPTY
    case 'date':
      if (typeof raw === 'number') return date(raw)
      if (typeof raw === 'string') {
        const parsed = Date.parse(raw)
        return Number.isNaN(parsed) ? EMPTY : date(parsed)
      }
      // BlockSuite's date cell has historically stored `{ value }` objects.
      if (typeof raw === 'object' && raw !== null && 'value' in raw) return fromCell((raw as { value: unknown }).value, 'date')
      return EMPTY
    case 'multi-select':
    case 'relation':
      if (Array.isArray(raw)) return list(raw.map((item) => fromCell(item, 'text')))
      // A single id where a list was expected is a list of one, not an error:
      // cardinality 'one' relations really do store a bare id.
      return list([fromCell(raw, 'text')])
    default:
      if (typeof raw === 'string') return raw.length === 0 ? EMPTY : str(raw)
      if (typeof raw === 'number') return num(raw)
      if (typeof raw === 'boolean') return bool(raw)
      if (Array.isArray(raw)) return list(raw.map((item) => fromCell(item, 'text')))
      // An object cell — a Teable link, a rich value. Rendered rather than
      // errored: a formula over it will fail with a type mismatch, which is a
      // better message than "unreadable cell".
      return str(JSON.stringify(raw))
  }
}

function coerceStoredNumber(raw: unknown): DbValue {
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return num(Number(raw))
  return EMPTY
}

/** Back to something `cells` can hold. Errors are stored as a tagged object so
 * a reader that is not this module can still tell an error from a string. */
export function toCell(value: DbValue): unknown {
  switch (value.kind) {
    case 'empty':
      return null
    case 'number':
    case 'string':
    case 'boolean':
      return value.value
    case 'date':
      return value.value
    case 'list':
      return value.value.map(toCell)
    case 'error':
      return { __formulaError: value.code, message: value.message }
  }
}
