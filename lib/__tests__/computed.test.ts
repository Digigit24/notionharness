import { describe, expect, it } from 'vitest'

import {
  aggregate,
  aggregationsFor,
  buildDependencies,
  displayComputed,
  evaluateComputed,
  evaluationOrder,
  findCycle,
  keyOf,
  validateFormula,
  type DatabaseLike,
} from '@/lib/database/computed'
import { EMPTY, date, num, str } from '@/lib/database/values'

/**
 * R13-P2.3 — rollups across databases, and the graph that keeps them honest.
 *
 * The cases that matter are the composed ones: a formula over a rollup over a
 * relation, recomputed when a row in the OTHER database changes. That is the
 * whole feature, and it is where a naive implementation either recurses per
 * cell or quietly reads a stale value.
 */

/** Customers ← Invoices, the smallest fixture that exercises a real rollup. */
function fixture(): DatabaseLike[] {
  const invoices: DatabaseLike = {
    id: 2,
    properties: [
      { id: 'title', name: 'Name', type: 'text' },
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'paid', name: 'Paid', type: 'checkbox' },
    ],
    rows: [
      { id: 'i1', cells: { title: 'Jan', amount: 100, paid: true } },
      { id: 'i2', cells: { title: 'Feb', amount: 250, paid: false } },
      { id: 'i3', cells: { title: 'Mar', amount: null, paid: false } },
    ],
  }

  const customers: DatabaseLike = {
    id: 1,
    properties: [
      { id: 'title', name: 'Name', type: 'text' },
      { id: 'rel', name: 'Invoices', type: 'relation', options: { targetDatabaseId: 2 } },
      {
        id: 'total',
        name: 'Total',
        type: 'number',
        options: { computed: { kind: 'rollup', relationPropertyId: 'rel', targetPropertyId: 'amount', aggregation: 'sum' } },
      },
      {
        id: 'withTax',
        name: 'With tax',
        type: 'number',
        options: { computed: { kind: 'formula', expression: 'round(Total * 1.2, 2)' } },
      },
    ],
    rows: [
      { id: 'c1', cells: { title: 'Acme', rel: ['i1', 'i2', 'i3'] } },
      { id: 'c2', cells: { title: 'Nobody', rel: [] } },
    ],
  }

  return [customers, invoices]
}

describe('rollups', () => {
  it('sums a number through a relation', () => {
    const computed = evaluateComputed(fixture())
    expect(computed.get(keyOf(1, 'total'))?.get('c1')).toEqual(num(350))
  })

  it('sums to zero for a row with no links, rather than to empty', () => {
    // "The sum of no invoices" is a number people expect to see. The average
    // of no invoices is not — see the next test.
    const computed = evaluateComputed(fixture())
    expect(computed.get(keyOf(1, 'total'))?.get('c2')).toEqual(num(0))
  })

  it('averages only the values that exist', () => {
    const dbs = fixture()
    const total = dbs[0].properties.find((p) => p.id === 'total')!
    total.options!.computed = { kind: 'rollup', relationPropertyId: 'rel', targetPropertyId: 'amount', aggregation: 'average' }
    const computed = evaluateComputed(dbs)
    // 100 and 250 average to 175; the blank third invoice is skipped, not
    // counted as a zero that would drag it to ~117.
    expect(computed.get(keyOf(1, 'total'))?.get('c1')).toEqual(num(175))
  })

  it('distinguishes counting links from counting values', () => {
    const dbs = fixture()
    const total = dbs[0].properties.find((p) => p.id === 'total')!
    total.options!.computed = { kind: 'rollup', relationPropertyId: 'rel', targetPropertyId: 'amount', aggregation: 'count_all' }
    expect(evaluateComputed(dbs).get(keyOf(1, 'total'))?.get('c1')).toEqual(num(3))
    total.options!.computed = { kind: 'rollup', relationPropertyId: 'rel', targetPropertyId: 'amount', aggregation: 'count_values' }
    expect(evaluateComputed(dbs).get(keyOf(1, 'total'))?.get('c1')).toEqual(num(2))
  })

  it('ignores a link whose row was deleted instead of erroring', () => {
    const dbs = fixture()
    dbs[0].rows[0].cells.rel = ['i1', 'gone']
    const computed = evaluateComputed(dbs)
    expect(computed.get(keyOf(1, 'total'))?.get('c1')).toEqual(num(100))
  })

  it('says so when the target property has been deleted', () => {
    const dbs = fixture()
    dbs[1].properties = dbs[1].properties.filter((p) => p.id !== 'amount')
    const value = evaluateComputed(dbs).get(keyOf(1, 'total'))?.get('c1')
    expect(value?.kind).toBe('error')
    // Empty here would read as "no linked rows", which is a different and much
    // more misleading fact than "this rollup is broken".
    if (value?.kind === 'error') expect(value.code).toBe('not_computable')
  })
})

describe('a formula over a rollup', () => {
  it('evaluates in dependency order in one pass', () => {
    const computed = evaluateComputed(fixture())
    expect(computed.get(keyOf(1, 'withTax'))?.get('c1')).toEqual(num(420))
  })

  it('recomputes when a row in the OTHER database changes', () => {
    const dbs = fixture()
    dbs[1].rows[1].cells.amount = 400
    const computed = evaluateComputed(dbs)
    expect(computed.get(keyOf(1, 'total'))?.get('c1')).toEqual(num(500))
    expect(computed.get(keyOf(1, 'withTax'))?.get('c1')).toEqual(num(600))
  })

  it('orders the rollup before the formula that reads it', () => {
    const deps = buildDependencies(fixture())
    const { order } = evaluationOrder(deps)
    expect(order.indexOf(keyOf(1, 'total'))).toBeLessThan(order.indexOf(keyOf(1, 'withTax')))
  })

  it('spans databases in the graph, so a cross-database cycle is visible', () => {
    const deps = buildDependencies(fixture())
    expect(deps.get(keyOf(1, 'total'))?.has(keyOf(2, 'amount'))).toBe(true)
  })
})

describe('cycles', () => {
  it('finds a direct self-reference', () => {
    const dbs: DatabaseLike[] = [
      {
        id: 1,
        properties: [{ id: 'a', name: 'A', type: 'number', options: { computed: { kind: 'formula', expression: 'A + 1' } } }],
        rows: [{ id: 'r1', cells: {} }],
      },
    ]
    expect(findCycle(buildDependencies(dbs))).not.toBeNull()
  })

  it('finds a two-step cycle and names both properties', () => {
    const dbs: DatabaseLike[] = [
      {
        id: 1,
        properties: [
          { id: 'a', name: 'A', type: 'number', options: { computed: { kind: 'formula', expression: 'B + 1' } } },
          { id: 'b', name: 'B', type: 'number', options: { computed: { kind: 'formula', expression: 'A + 1' } } },
        ],
        rows: [{ id: 'r1', cells: {} }],
      },
    ]
    const cycle = findCycle(buildDependencies(dbs))
    expect(cycle).not.toBeNull()
    expect(cycle).toContain(keyOf(1, 'a'))
    expect(cycle).toContain(keyOf(1, 'b'))
  })

  it('renders a cycle error in the cell rather than hanging or dropping the property', () => {
    const dbs: DatabaseLike[] = [
      {
        id: 1,
        properties: [
          { id: 'a', name: 'A', type: 'number', options: { computed: { kind: 'formula', expression: 'B + 1' } } },
          { id: 'b', name: 'B', type: 'number', options: { computed: { kind: 'formula', expression: 'A + 1' } } },
        ],
        rows: [{ id: 'r1', cells: {} }],
      },
    ]
    const value = evaluateComputed(dbs).get(keyOf(1, 'a'))?.get('r1')
    expect(value?.kind).toBe('error')
    if (value?.kind === 'error') expect(value.code).toBe('cycle')
  })

  it('does not mistake a diamond for a cycle', () => {
    // A → B, A → C, B → D, C → D is not circular, and an implementation that
    // marks a node grey on a second visit rather than on the current path will
    // wrongly say it is.
    const dbs: DatabaseLike[] = [
      {
        id: 1,
        properties: [
          { id: 'd', name: 'D', type: 'number' },
          { id: 'b', name: 'B', type: 'number', options: { computed: { kind: 'formula', expression: 'D + 1' } } },
          { id: 'c', name: 'C', type: 'number', options: { computed: { kind: 'formula', expression: 'D + 2' } } },
          { id: 'a', name: 'A', type: 'number', options: { computed: { kind: 'formula', expression: 'B + C' } } },
        ],
        rows: [{ id: 'r1', cells: { d: 10 } }],
      },
    ]
    expect(findCycle(buildDependencies(dbs))).toBeNull()
    expect(evaluateComputed(dbs).get(keyOf(1, 'a'))?.get('r1')).toEqual(num(23))
  })
})

describe('aggregations in isolation', () => {
  it('handles an empty set without dividing by zero', () => {
    expect(aggregate([], 'average')).toEqual(EMPTY)
    expect(aggregate([], 'sum')).toEqual(num(0))
    expect(aggregate([], 'percent_empty')).toEqual(EMPTY)
  })

  it('computes a median for both parities', () => {
    expect(aggregate([num(1), num(3), num(2)], 'median')).toEqual(num(2))
    expect(aggregate([num(1), num(2), num(3), num(4)], 'median')).toEqual(num(2.5))
  })

  it('counts unique values by value, not by identity', () => {
    expect(aggregate([str('a'), str('a'), str('b')], 'count_unique')).toEqual(num(2))
  })

  it('returns dates for earliest and latest, not numbers', () => {
    const result = aggregate([date(2_000), date(1_000)], 'earliest')
    expect(result.kind).toBe('date')
  })

  it('offers only the aggregations that make sense for a type', () => {
    expect(aggregationsFor('number')).toContain('sum')
    expect(aggregationsFor('date')).toContain('earliest')
    expect(aggregationsFor('date')).not.toContain('sum')
    expect(aggregationsFor('text')).not.toContain('average')
  })
})

describe('the property editor surface', () => {
  it('reports a syntax error with a position, for the dialog', () => {
    expect(validateFormula('1 +')).not.toBeNull()
    expect(validateFormula('round(1.234, 2)')).toBeNull()
  })

  it('renders an error value as its message so a broken cell explains itself', () => {
    const dbs: DatabaseLike[] = [
      {
        id: 1,
        properties: [{ id: 'a', name: 'A', type: 'number', options: { computed: { kind: 'formula', expression: 'Nope + 1' } } }],
        rows: [{ id: 'r1', cells: {} }],
      },
    ]
    const value = evaluateComputed(dbs).get(keyOf(1, 'a'))?.get('r1')
    expect(displayComputed(value!)).toContain('Nope')
  })

  it('trims float noise without inventing a format', () => {
    expect(displayComputed(num(1 / 3))).toBe('0.333333')
    expect(displayComputed(num(4))).toBe('4')
  })
})
