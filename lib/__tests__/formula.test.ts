import { describe, expect, it } from 'vitest'

import { FormulaSyntaxError, evaluateFormula, parseFormula, referencedProperties } from '@/lib/database/formula'
import { EMPTY, asString, bool, date, fromCell, list, num, str, type DbValue } from '@/lib/database/values'

/**
 * R13-P2.2 — the formula language, tested where it actually goes wrong.
 *
 * Not "does 1+1 work". The cases here are the ones that separate a formula
 * engine from a calculator: empty is not zero, a broken reference must not
 * take the table down, a guarded division must actually be guarded, and every
 * error must arrive as a value rather than as a thrown exception.
 */
function run(source: string, row: Record<string, DbValue> = {}): DbValue {
  return evaluateFormula(parseFormula(source), { get: (name) => row[name] })
}

describe('parsing', () => {
  it('parses a parenthesised expression without swallowing the next token', () => {
    // The bug this test was written for: `expect(')')` consumed the paren and
    // the call site then consumed one more token, so `(1 + 2) * 3` silently
    // lost its multiplication.
    expect(run('(1 + 2) * 3')).toEqual(num(9))
  })

  it('parses a ternary without swallowing the next token', () => {
    expect(run('true ? 1 : 2')).toEqual(num(1))
    expect(run('false ? 1 : 2')).toEqual(num(2))
  })

  it('respects precedence', () => {
    expect(run('1 + 2 * 3')).toEqual(num(7))
    expect(run('2 * 3 + 1')).toEqual(num(7))
    expect(run('1 + 2 < 4 and 1 == 1')).toEqual(bool(true))
  })

  it('reads a bare identifier as a property, and prop() as the same thing', () => {
    const row = { Price: num(10), 'Unit cost': num(4) }
    expect(run('Price', row)).toEqual(num(10))
    expect(run('prop("Unit cost")', row)).toEqual(num(4))
    expect(run('Price - prop("Unit cost")', row)).toEqual(num(6))
  })

  it('refuses malformed input with a position', () => {
    expect(() => parseFormula('1 +')).toThrow(FormulaSyntaxError)
    expect(() => parseFormula('"unterminated')).toThrow(FormulaSyntaxError)
    expect(() => parseFormula('1 @ 2')).toThrow(FormulaSyntaxError)
  })

  it('lists the properties a formula depends on', () => {
    const refs = referencedProperties(parseFormula('if(Done, Price * Qty, prop("Fallback"))'))
    expect([...refs].sort()).toEqual(['Done', 'Fallback', 'Price', 'Qty'])
  })
})

describe('empty is not zero', () => {
  it('makes a product of an unknown quantity unknown, not zero', () => {
    // The wrong answer here is 0, and it is wrong in the most dangerous way:
    // it looks like a real number and it is off by the whole line item.
    expect(run('Price * Qty', { Price: num(10), Qty: EMPTY })).toEqual(EMPTY)
  })

  it('but treats empty as zero for addition, so a running total still works', () => {
    expect(run('A + B', { A: num(10), B: EMPTY })).toEqual(num(10))
    expect(run('A + B', { A: EMPTY, B: EMPTY })).toEqual(EMPTY)
  })

  it('skips empties when averaging rather than counting them', () => {
    const row = { Scores: list([num(3), EMPTY, num(5)]) }
    expect(run('average(Scores)', row)).toEqual(num(4))
  })

  it('counts only non-empty entries', () => {
    expect(run('count(Tags)', { Tags: list([str('a'), EMPTY, str('b')]) })).toEqual(num(2))
    expect(run('count(Nothing)', { Nothing: EMPTY })).toEqual(num(0))
  })

  it('treats an empty list as false, unlike JavaScript', () => {
    expect(run('Links ? 1 : 0', { Links: list([]) })).toEqual(num(0))
    expect(run('Links ? 1 : 0', { Links: list([str('x')]) })).toEqual(num(1))
  })
})

describe('errors are values, never exceptions', () => {
  it('names an unknown property instead of reading it as blank', () => {
    const result = run('Missing + 1')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.code).toBe('unknown_property')
  })

  it('reports division by zero in the cell', () => {
    const result = run('1 / 0')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.code).toBe('divide_by_zero')
  })

  it('propagates the first error rather than a confused type mismatch above it', () => {
    const result = run('(Missing * 2) + 5')
    if (result.kind === 'error') expect(result.code).toBe('unknown_property')
    else throw new Error('expected an error value')
  })

  it('does not evaluate the branch it did not take, so a guard really guards', () => {
    expect(run('if(Qty != 0, Total / Qty, 0)', { Qty: num(0), Total: num(10) })).toEqual(num(0))
    expect(run('Qty != 0 and Total / Qty > 1', { Qty: num(0), Total: num(10) })).toEqual(bool(false))
  })

  it('names an unknown function', () => {
    const result = run('frobnicate(1)')
    if (result.kind === 'error') expect(result.code).toBe('unknown_function')
    else throw new Error('expected an error value')
  })

  it('never throws for bad data, only for bad syntax', () => {
    const row = { Text: str('hello'), When: date(0) }
    for (const source of ['Text * 2', 'When - Text', 'sqrt(0 - 1)', 'round(Text)', 'length(When)']) {
      expect(() => run(source, row)).not.toThrow()
    }
  })
})

describe('text and dates', () => {
  it('concatenates when either side is text', () => {
    expect(run('Name + " (" + Status + ")"', { Name: str('Parser'), Status: str('done') })).toEqual(str('Parser (done)'))
  })

  it('counts whole days between dates', () => {
    const a = date(Date.UTC(2026, 0, 10))
    const b = date(Date.UTC(2026, 0, 1))
    expect(run('datebetween(A, B)', { A: a, B: b })).toEqual(num(9))
  })

  it('adds days to a date and keeps it a date', () => {
    const result = run('dateadd(A, 3)', { A: date(Date.UTC(2026, 0, 1)) })
    expect(result.kind).toBe('date')
    expect(asString(result)).toContain('2026-01-04')
  })

  it('joins a list with a separator, dropping empties', () => {
    expect(run('join(", ", Tags)', { Tags: list([str('a'), EMPTY, str('b')]) })).toEqual(str('a, b'))
  })
})

describe('reading stored cells', () => {
  it('accepts the several shapes this product has stored dates as', () => {
    expect(fromCell(0, 'date')).toEqual(date(0))
    expect(fromCell('2026-01-01T00:00:00.000Z', 'date')).toEqual(date(Date.UTC(2026, 0, 1)))
    expect(fromCell({ value: 0 }, 'date')).toEqual(date(0))
    expect(fromCell(null, 'date')).toEqual(EMPTY)
  })

  it('reads a single relation id as a list of one', () => {
    expect(fromCell('row-1', 'relation')).toEqual(list([str('row-1')]))
    expect(fromCell(['row-1', 'row-2'], 'relation')).toEqual(list([str('row-1'), str('row-2')]))
  })

  it('reads a checkbox stored either way', () => {
    expect(fromCell(true, 'checkbox')).toEqual(bool(true))
    expect(fromCell('false', 'checkbox')).toEqual(bool(false))
    expect(fromCell(null, 'checkbox')).toEqual(EMPTY)
  })

  it('treats an empty string as empty, not as text', () => {
    expect(fromCell('', 'text')).toEqual(EMPTY)
  })
})
