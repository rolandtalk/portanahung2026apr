import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateHoldingsBySymbol,
  calculateGrowthAggregate,
  calculateHoldingGrowth,
  normalizeCompletedCandles,
} from './server-analysis.js'

test('aggregates duplicate symbols across portfolios', () => {
  const result = aggregateHoldingsBySymbol({
    CUB: [{ symbol: ' aapl ', shares: 10 }, { symbol: 'MSFT', shares: 2 }],
    FT: [{ symbol: 'Aapl', shares: 5 }],
  })

  assert.deepEqual(result, [
    { symbol: 'AAPL', shares: 15 },
    { symbol: 'MSFT', shares: 2 },
  ])
})

test('drops an unfinished New York trading-day candle', () => {
  const raw = {
    c: [100, 102],
    t: [
      Date.parse('2026-09-10T04:00:00Z') / 1000,
      Date.parse('2026-09-11T04:00:00Z') / 1000,
    ],
  }
  const beforeClose = normalizeCompletedCandles(raw, new Date('2026-09-11T14:00:00Z'))
  const afterClose = normalizeCompletedCandles(raw, new Date('2026-09-11T20:25:00Z'))

  assert.equal(beforeClose.length, 1)
  assert.equal(beforeClose[0].date, '2026-09-10')
  assert.equal(afterClose.length, 2)
})

test('calculates share-weighted growth for each trading-session period', () => {
  const candles = Array.from({ length: 61 }, (_, index) => ({
    timestamp: index,
    date: `day-${index + 1}`,
    close: 101 + index,
  }))
  const row = calculateHoldingGrowth({ symbol: 'TEST', shares: 10 }, candles)

  assert.equal(row.lastClose, 161)
  assert.equal(row.marketValue, 1610)
  assert.equal(row.growth[1].baselineClose, 160)
  assert.equal(row.growth[1].valueChange, 10)
  assert.equal(row.growth[60].baselineClose, 101)
  assert.equal(row.growth[60].valueChange, 600)
})

test('totals dollar growth and computes a baseline-value-weighted percentage', () => {
  const rows = [
    calculateHoldingGrowth(
      { symbol: 'AAA', shares: 2 },
      [{ date: 'old', close: 10 }, { date: 'new', close: 12 }]
    ),
    calculateHoldingGrowth(
      { symbol: 'BBB', shares: 1 },
      [{ date: 'old', close: 20 }, { date: 'new', close: 18 }]
    ),
  ]
  const aggregate = calculateGrowthAggregate(rows)

  assert.equal(aggregate.marketValue, 42)
  assert.equal(aggregate.growth[1].valueChange, 2)
  assert.equal(aggregate.growth[1].pct, 5)
})

test('requires exact canonical session dates for comparable totals', () => {
  const canonical = [
    { date: '2026-09-09', close: 1 },
    { date: '2026-09-10', close: 1 },
  ]
  const halted = [{ date: '2026-09-09', close: 10 }]
  const row = calculateHoldingGrowth({ symbol: 'HALT', shares: 2 }, halted, canonical)

  assert.equal(row.marketValue, null)
  assert.equal(row.growth[1], null)
})
