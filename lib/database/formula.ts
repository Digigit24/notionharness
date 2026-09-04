/**
 * R13-P2.2 — the formula language.
 *
 * SMALL AND TOTAL, ON PURPOSE. No loops, no assignment, no I/O, no user
 * functions, no recursion. A formula is an expression over this row's
 * properties and it always terminates, which means a database with two
 * thousand formula cells cannot hang the browser and a malicious formula
 * cannot do anything at all. That is a security property as much as a
 * performance one, and it is why this is a hand-written parser rather than
 * anything that reaches `eval` or `new Function`.
 *
 * WHY NOT A LIBRARY. Every candidate either brings a general-purpose
 * evaluator (and with it the halting problem and an eval-shaped hole) or a
 * spreadsheet grid model that does not match a database of rows and named
 * properties. The grammar below is roughly 200 lines and can be read in one
 * sitting; that is cheaper than owning a dependency's semantics.
 *
 * GRAMMAR
 *
 *   expression  := ternary
 *   ternary     := or ( "?" expression ":" expression )?
 *   or          := and ( ("or" | "||") and )*
 *   and         := equality ( ("and" | "&&") equality )*
 *   equality    := comparison ( ("==" | "!=") comparison )*
 *   comparison  := additive ( ("<" | "<=" | ">" | ">=") additive )*
 *   additive    := multiplicative ( ("+" | "-") multiplicative )*
 *   multiplicative := unary ( ("*" | "/" | "%") unary )*
 *   unary       := ("-" | "not" | "!") unary | primary
 *   primary     := number | string | true | false | empty
 *                | prop("Name") | Name | function "(" args? ")" | "(" expression ")"
 *
 * A bare identifier is a PROPERTY REFERENCE, which is what people expect from
 * Notion. `prop("…")` exists as well because property names contain spaces.
 */
import {
  EMPTY,
  asBoolean,
  asNumber,
  asString,
  bool,
  date,
  err,
  firstError,
  isEmpty,
  isError,
  list,
  num,
  str,
  type DbValue,
} from './values'

// --- Tokens -----------------------------------------------------------------

type TokenType = 'number' | 'string' | 'identifier' | 'operator' | 'punct' | 'eof'

interface Token {
  type: TokenType
  value: string
  at: number
}

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':']

export class FormulaSyntaxError extends Error {
  readonly at: number
  constructor(message: string, at: number) {
    super(message)
    this.name = 'FormulaSyntaxError'
    this.at = at
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < source.length) {
    const ch = source[i]

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      let value = ''
      let j = i + 1
      while (j < source.length && source[j] !== quote) {
        // One escape, backslash, covering the quote and itself. Enough for a
        // label; anything more is a text field's job, not a formula's.
        if (source[j] === '\\' && j + 1 < source.length) {
          value += source[j + 1]
          j += 2
          continue
        }
        value += source[j]
        j += 1
      }
      if (j >= source.length) throw new FormulaSyntaxError('That text is missing its closing quote.', i)
      tokens.push({ type: 'string', value, at: i })
      i = j + 1
      continue
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1
      const text = source.slice(i, j)
      if ((text.match(/\./g) ?? []).length > 1) throw new FormulaSyntaxError(`"${text}" is not a number.`, i)
      tokens.push({ type: 'number', value: text, at: i })
      i = j
      continue
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      // Unicode letters and digits, so a property named "Coût" works.
      while (j < source.length && /[\p{L}\p{N}_]/u.test(source[j])) j += 1
      tokens.push({ type: 'identifier', value: source.slice(i, j), at: i })
      i = j
      continue
    }

    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ type: 'punct', value: ch, at: i })
      i += 1
      continue
    }

    const two = source.slice(i, i + 2)
    const op = OPERATORS.find((candidate) => candidate.length === 2 && candidate === two) ?? OPERATORS.find((candidate) => candidate.length === 1 && candidate === ch)
    if (op) {
      tokens.push({ type: 'operator', value: op, at: i })
      i += op.length
      continue
    }

    throw new FormulaSyntaxError(`"${ch}" does not mean anything here.`, i)
  }

  tokens.push({ type: 'eof', value: '', at: source.length })
  return tokens
}

// --- AST --------------------------------------------------------------------

export type Node =
  | { kind: 'literal'; value: DbValue }
  | { kind: 'prop'; name: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'unary'; op: string; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'ternary'; test: Node; then: Node; otherwise: Node }

/**
 * Parse once, evaluate per row.
 *
 * This split is the whole performance story of formulas: a table with two
 * thousand rows parses its formula ONCE and walks the tree two thousand times,
 * rather than re-tokenising a string per cell.
 */
export function parseFormula(source: string): Node {
  const tokens = tokenize(source)
  let pos = 0

  const peek = () => tokens[pos]
  const eat = () => tokens[pos++]
  /** Consumes the token it checks for. Named `expect` rather than `eatIf`
   * because it throws on a mismatch, but the consumption is the part that
   * matters at the call sites — an extra `eat()` after one of these runs the
   * cursor past the token the caller is about to read, which silently drops
   * the operator after a closing paren. */
  const expect = (value: string) => {
    const token = peek()
    if (token.value !== value) throw new FormulaSyntaxError(`Expected "${value}" here.`, token.at)
    return eat()
  }
  const matchOp = (...values: string[]) => {
    const token = peek()
    if ((token.type === 'operator' || token.type === 'identifier') && values.includes(token.value)) {
      eat()
      return token.value
    }
    return null
  }

  function expression(): Node {
    return ternary()
  }

  function ternary(): Node {
    const test = orExpr()
    if (matchOp('?')) {
      const then = expression()
      expect(':')
      const otherwise = expression()
      return { kind: 'ternary', test, then, otherwise }
    }
    return test
  }

  function orExpr(): Node {
    let left = andExpr()
    // Both spellings parse to one node: `||` and `or` are the same operator,
    // and carrying the spelling into the AST would mean the evaluator had to
    // know about it too.
    while (matchOp('or', '||')) left = { kind: 'binary', op: 'or', left, right: andExpr() }
    return left
  }

  function andExpr(): Node {
    let left = equality()
    while (matchOp('and', '&&')) left = { kind: 'binary', op: 'and', left, right: equality() }
    return left
  }

  function equality(): Node {
    let left = comparison()
    let op: string | null
    while ((op = matchOp('==', '!='))) left = { kind: 'binary', op, left, right: comparison() }
    return left
  }

  function comparison(): Node {
    let left = additive()
    let op: string | null
    while ((op = matchOp('<', '<=', '>', '>='))) left = { kind: 'binary', op, left, right: additive() }
    return left
  }

  function additive(): Node {
    let left = multiplicative()
    let op: string | null
    while ((op = matchOp('+', '-'))) left = { kind: 'binary', op, left, right: multiplicative() }
    return left
  }

  function multiplicative(): Node {
    let left = unary()
    let op: string | null
    while ((op = matchOp('*', '/', '%'))) left = { kind: 'binary', op, left, right: unary() }
    return left
  }

  function unary(): Node {
    const op = matchOp('-', '!', 'not')
    if (op) return { kind: 'unary', op: op === 'not' ? '!' : op, operand: unary() }
    return primary()
  }

  function primary(): Node {
    const token = peek()

    if (token.type === 'number') {
      eat()
      return { kind: 'literal', value: num(Number(token.value)) }
    }
    if (token.type === 'string') {
      eat()
      return { kind: 'literal', value: str(token.value) }
    }
    if (token.value === '(') {
      eat()
      const inner = expression()
      expect(')')
      return inner
    }
    if (token.type === 'identifier') {
      eat()
      const lower = token.value.toLowerCase()
      if (lower === 'true') return { kind: 'literal', value: bool(true) }
      if (lower === 'false') return { kind: 'literal', value: bool(false) }
      if (lower === 'empty') return { kind: 'literal', value: EMPTY }

      if (peek().value === '(') {
        eat()
        const args: Node[] = []
        if (peek().value !== ')') {
          args.push(expression())
          while (peek().value === ',') {
            eat()
            args.push(expression())
          }
        }
        expect(')')
        // `prop("Name")` is a property reference written the long way, so it
        // becomes the same node a bare identifier does. Everything else is a
        // function call.
        if (lower === 'prop') {
          const only = args[0]
          if (args.length === 1 && only.kind === 'literal' && only.value.kind === 'string') {
            return { kind: 'prop', name: only.value.value }
          }
          throw new FormulaSyntaxError('prop() takes one property name in quotes.', token.at)
        }
        return { kind: 'call', name: lower, args }
      }

      return { kind: 'prop', name: token.value }
    }

    throw new FormulaSyntaxError(
      token.type === 'eof' ? 'The formula ends before it is finished.' : `"${token.value}" cannot start a value.`,
      token.at,
    )
  }

  const tree = expression()
  if (peek().type !== 'eof') throw new FormulaSyntaxError(`"${peek().value}" is unexpected here.`, peek().at)
  return tree
}

/** Every property this formula reads. The dependency graph is built from
 * this, so a formula that references a deleted property is caught when the
 * formula is SAVED rather than when a cell is drawn. */
export function referencedProperties(node: Node, into: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case 'prop':
      into.add(node.name)
      break
    case 'call':
      node.args.forEach((arg) => referencedProperties(arg, into))
      break
    case 'unary':
      referencedProperties(node.operand, into)
      break
    case 'binary':
      referencedProperties(node.left, into)
      referencedProperties(node.right, into)
      break
    case 'ternary':
      referencedProperties(node.test, into)
      referencedProperties(node.then, into)
      referencedProperties(node.otherwise, into)
      break
    case 'literal':
      break
  }
  return into
}

// --- Evaluation -------------------------------------------------------------

export interface FormulaContext {
  /** This row's values, BY PROPERTY NAME — names, because that is what the
   * author wrote. The caller maps ids to names once per table. */
  get: (name: string) => DbValue | undefined
}

export function evaluateFormula(node: Node, ctx: FormulaContext): DbValue {
  switch (node.kind) {
    case 'literal':
      return node.value

    case 'prop': {
      const value = ctx.get(node.name)
      // An unknown property is an error rather than empty: silently treating a
      // typo as blank is how a formula reads zero forever and nobody notices.
      return value === undefined ? err('unknown_property', `There is no property called "${node.name}".`) : value
    }

    case 'unary': {
      const operand = evaluateFormula(node.operand, ctx)
      if (isError(operand)) return operand
      if (node.op === '-') {
        const n = asNumber(operand)
        if (n === null) return EMPTY
        if (typeof n !== 'number') return n
        return num(-n)
      }
      const b = asBoolean(operand)
      return typeof b === 'boolean' ? bool(!b) : b
    }

    case 'ternary': {
      const test = asBoolean(evaluateFormula(node.test, ctx))
      if (typeof test !== 'boolean') return test
      // Only the taken branch is evaluated, so `if(x != 0, 100/x, 0)` is safe.
      return evaluateFormula(test ? node.then : node.otherwise, ctx)
    }

    case 'binary':
      return evaluateBinary(node, ctx)

    case 'call':
      return evaluateCall(node, ctx)
  }
}

function evaluateBinary(node: Extract<Node, { kind: 'binary' }>, ctx: FormulaContext): DbValue {
  // Short-circuit before evaluating the right side, so `x != 0 and 10/x > 1`
  // never divides by zero.
  if (node.op === 'and' || node.op === 'or') {
    const left = asBoolean(evaluateFormula(node.left, ctx))
    if (typeof left !== 'boolean') return left
    if (node.op === 'and' && !left) return bool(false)
    if (node.op === 'or' && left) return bool(true)
    const right = asBoolean(evaluateFormula(node.right, ctx))
    return typeof right === 'boolean' ? bool(right) : right
  }

  const left = evaluateFormula(node.left, ctx)
  const right = evaluateFormula(node.right, ctx)
  const failed = firstError([left, right])
  if (failed) return failed

  if (node.op === '==' || node.op === '!=') {
    const equal = valuesEqual(left, right)
    return bool(node.op === '==' ? equal : !equal)
  }

  // `+` is addition for numbers and concatenation when either side is text —
  // the one overload worth having, because "Name + ' (' + Status + ')'" is the
  // most common formula anyone writes.
  if (node.op === '+' && (left.kind === 'string' || right.kind === 'string')) {
    return str(asString(left) + asString(right))
  }

  const a = asNumber(left)
  const b = asNumber(right)
  if (typeof a === 'object' && a !== null) return a
  if (typeof b === 'object' && b !== null) return b

  // Empty behaves as zero for + and -, and makes the whole expression empty
  // for the others: "price * quantity" with no quantity is not zero, it is
  // unknown, and reporting zero there is a silent wrong answer.
  const bothPresent = a !== null && b !== null
  const x = a ?? 0
  const y = b ?? 0

  switch (node.op) {
    case '+':
      return a === null && b === null ? EMPTY : num(x + y)
    case '-':
      return a === null && b === null ? EMPTY : num(x - y)
    case '*':
      return bothPresent ? num(x * y) : EMPTY
    case '/':
      if (!bothPresent) return EMPTY
      if (y === 0) return err('divide_by_zero', 'Cannot divide by zero.')
      return num(x / y)
    case '%':
      if (!bothPresent) return EMPTY
      if (y === 0) return err('divide_by_zero', 'Cannot take a remainder by zero.')
      return num(x % y)
    case '<':
      return bothPresent ? bool(x < y) : EMPTY
    case '<=':
      return bothPresent ? bool(x <= y) : EMPTY
    case '>':
      return bothPresent ? bool(x > y) : EMPTY
    case '>=':
      return bothPresent ? bool(x >= y) : EMPTY
    default:
      return err('unknown_function', `"${node.op}" is not an operator.`)
  }
}

function valuesEqual(left: DbValue, right: DbValue): boolean {
  if (isEmpty(left) && isEmpty(right)) return true
  if (left.kind === 'list' || right.kind === 'list') {
    const a = left.kind === 'list' ? left.value : [left]
    const b = right.kind === 'list' ? right.value : [right]
    return a.length === b.length && a.every((item, i) => valuesEqual(item, b[i]))
  }
  if (left.kind === 'string' || right.kind === 'string') return asString(left) === asString(right)
  const a = asNumber(left)
  const b = asNumber(right)
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return asString(left) === asString(right)
}

type Fn = (args: DbValue[]) => DbValue

const DAY_MS = 86_400_000

const FUNCTIONS: Record<string, Fn> = {
  // --- logic
  if: (args) => {
    if (args.length !== 3) return err('bad_argument', 'if() takes a test and two results.')
    const test = asBoolean(args[0])
    if (typeof test !== 'boolean') return test
    return test ? args[1] : args[2]
  },
  // Notion's name for "the first thing that is not empty", and the reason
  // empty is a distinct value in this system.
  ifempty: (args) => (args.length === 2 ? (isEmpty(args[0]) ? args[1] : args[0]) : err('bad_argument', 'ifempty() takes two values.')),
  isempty: (args) => (args.length === 1 ? bool(isEmpty(args[0])) : err('bad_argument', 'isempty() takes one value.')),
  not: (args) => {
    const b = asBoolean(args[0] ?? EMPTY)
    return typeof b === 'boolean' ? bool(!b) : b
  },

  // --- numbers
  abs: numeric1(Math.abs),
  round: (args) => {
    const value = asNumber(args[0] ?? EMPTY)
    if (value === null) return EMPTY
    if (typeof value !== 'number') return value
    const places = args.length > 1 ? asNumber(args[1]) : 0
    if (typeof places === 'object' && places !== null) return places
    const factor = 10 ** Math.trunc((places as number) ?? 0)
    return num(Math.round(value * factor) / factor)
  },
  floor: numeric1(Math.floor),
  ceil: numeric1(Math.ceil),
  sqrt: numeric1((n) => (n < 0 ? NaN : Math.sqrt(n))),
  min: reduceNumbers((a, b) => Math.min(a, b)),
  max: reduceNumbers((a, b) => Math.max(a, b)),
  sum: reduceNumbers((a, b) => a + b, 0),
  // Averages skip empties rather than counting them as zero. This is the
  // single most consequential definition in the file: the other choice silently
  // deflates every average in a table with a blank in it.
  average: (args) => {
    const numbers = flattenNumbers(args)
    if (Array.isArray(numbers)) {
      return numbers.length === 0 ? EMPTY : num(numbers.reduce((a, b) => a + b, 0) / numbers.length)
    }
    return numbers
  },

  // --- text
  concat: (args) => str(args.map(asString).join('')),
  join: (args) => {
    if (args.length === 0) return EMPTY
    const [separator, ...rest] = args
    const parts = rest.flatMap((value) => (value.kind === 'list' ? value.value : [value])).filter((v) => !isEmpty(v))
    return str(parts.map(asString).join(asString(separator)))
  },
  length: (args) => {
    const value = args[0] ?? EMPTY
    if (value.kind === 'list') return num(value.value.length)
    return num(asString(value).length)
  },
  lower: (args) => str(asString(args[0] ?? EMPTY).toLowerCase()),
  upper: (args) => str(asString(args[0] ?? EMPTY).toUpperCase()),
  contains: (args) =>
    args.length === 2 ? bool(asString(args[0]).includes(asString(args[1]))) : err('bad_argument', 'contains() takes two values.'),
  replace: (args) =>
    args.length === 3
      ? str(asString(args[0]).split(asString(args[1])).join(asString(args[2])))
      : err('bad_argument', 'replace() takes three values.'),
  slice: (args) => {
    const text = asString(args[0] ?? EMPTY)
    const from = asNumber(args[1] ?? num(0))
    const to = args.length > 2 ? asNumber(args[2]) : null
    if (typeof from === 'object' && from !== null) return from
    if (typeof to === 'object' && to !== null) return to
    return str(text.slice((from as number) ?? 0, to === null ? undefined : (to as number)))
  },
  format: (args) => str(asString(args[0] ?? EMPTY)),

  // --- dates
  // `now()` is deliberately NOT here. A formula whose value depends on the
  // clock cannot be cached, cannot be compared between a client preview and a
  // server write, and makes every row in the table dirty on every read. Notion
  // has it and pays exactly that cost. If it is ever added, it must be as an
  // explicitly non-cached property type, not as a function that quietly makes
  // every formula non-deterministic.
  dateadd: (args) => {
    const base = asNumber(args[0] ?? EMPTY)
    const days = asNumber(args[1] ?? EMPTY)
    if (base === null || days === null) return EMPTY
    if (typeof base === 'object') return base
    if (typeof days === 'object') return days
    return date((base as number) + (days as number) * DAY_MS)
  },
  datebetween: (args) => {
    const a = asNumber(args[0] ?? EMPTY)
    const b = asNumber(args[1] ?? EMPTY)
    if (a === null || b === null) return EMPTY
    if (typeof a === 'object') return a
    if (typeof b === 'object') return b
    return num(Math.round(((a as number) - (b as number)) / DAY_MS))
  },
  year: datePart((d) => d.getUTCFullYear()),
  month: datePart((d) => d.getUTCMonth() + 1),
  day: datePart((d) => d.getUTCDate()),

  // --- lists
  count: (args) => {
    const value = args[0] ?? EMPTY
    if (value.kind === 'list') return num(value.value.filter((item) => !isEmpty(item)).length)
    return num(isEmpty(value) ? 0 : 1)
  },
  first: (args) => {
    const value = args[0] ?? EMPTY
    return value.kind === 'list' ? value.value[0] ?? EMPTY : value
  },
  last: (args) => {
    const value = args[0] ?? EMPTY
    return value.kind === 'list' ? value.value[value.value.length - 1] ?? EMPTY : value
  },
  unique: (args) => {
    const value = args[0] ?? EMPTY
    if (value.kind !== 'list') return value
    const seen = new Set<string>()
    const out: DbValue[] = []
    for (const item of value.value) {
      const key = `${item.kind}:${asString(item)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return list(out)
  },
}

function numeric1(fn: (n: number) => number): Fn {
  return (args) => {
    const value = asNumber(args[0] ?? EMPTY)
    if (value === null) return EMPTY
    if (typeof value !== 'number') return value
    return num(fn(value))
  }
}

function datePart(fn: (d: Date) => number): Fn {
  return (args) => {
    const value = asNumber(args[0] ?? EMPTY)
    if (value === null) return EMPTY
    if (typeof value !== 'number') return value
    return num(fn(new Date(value)))
  }
}

/** Numbers out of any mix of scalars and lists, empties dropped. Returns an
 * error value instead if anything in there was not a number. */
function flattenNumbers(args: DbValue[]): number[] | DbValue {
  const out: number[] = []
  const walk = (value: DbValue): DbValue | null => {
    if (isError(value)) return value
    if (value.kind === 'list') {
      for (const item of value.value) {
        const failed = walk(item)
        if (failed) return failed
      }
      return null
    }
    const n = asNumber(value)
    if (n === null) return null
    if (typeof n === 'object') return n
    out.push(n)
    return null
  }
  for (const arg of args) {
    const failed = walk(arg)
    if (failed) return failed
  }
  return out
}

function reduceNumbers(fn: (a: number, b: number) => number, seed?: number): Fn {
  return (args) => {
    const numbers = flattenNumbers(args)
    if (!Array.isArray(numbers)) return numbers
    if (numbers.length === 0) return seed === undefined ? EMPTY : num(seed)
    return num(numbers.reduce(fn))
  }
}

function evaluateCall(node: Extract<Node, { kind: 'call' }>, ctx: FormulaContext): DbValue {
  const fn = FUNCTIONS[node.name]
  if (!fn) return err('unknown_function', `There is no function called "${node.name}".`)

  // `if` evaluates lazily so a guarded division is actually guarded. Every
  // other function takes settled arguments.
  if (node.name === 'if') {
    if (node.args.length !== 3) return err('bad_argument', 'if() takes a test and two results.')
    const test = asBoolean(evaluateFormula(node.args[0], ctx))
    if (typeof test !== 'boolean') return test
    return evaluateFormula(test ? node.args[1] : node.args[2], ctx)
  }

  const args = node.args.map((arg) => evaluateFormula(arg, ctx))
  const failed = firstError(args)
  if (failed) return failed
  return fn(args)
}

/** Every function name, for an editor's autocomplete. */
export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS).sort()
