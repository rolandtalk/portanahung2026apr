import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRegularSessionQuotes,
  aggregateHoldingsBySymbol,
  calculateGrowthAggregate,
  calculateHoldingGrowth,
  normalizeCompletedCandles,
  normalizeRegularSessionQuotes,
} from './server-analysis.js'

function makeHistoricalPayload() {
  const holdings = [
    calculateHoldingGrowth(
      { symbol: 'AAA', shares: 2 },
      [{ date: '2026-09-09', close: 10 }, { date: '2026-09-10', close: 12 }]
    ),
    calculateHoldingGrowth(
      { symbol: 'BBB', shares: 1 },
      [{ date: '2026-09-09', close: 20 }, { date: '2026-09-10', close: 18 }]
    ),
  ]
  return {
    periods: [1, 3, 10, 20, 60],
    asOf: '2026-09-10',
    baselineDates: { 1: '2026-09-09' },
    holdings,
    aggregate: calculateGrowthAggregate(holdings),
    errors: [],
    retrievedAt: '2026-09-11T14:00:00.000Z',
    cached: false,
  }
}

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

test('normalizes regular-session quotes with an Eastern session date', () => {
  const quotes = normalizeRegularSessionQuotes({
    symbol: ['AAA'],
    last: [15],
    change: [3],
    changepct: [0.25],
    updated: [Date.parse('2026-09-11T16:00:00Z') / 1000],
  })

  assert.deepEqual(quotes.AAA, {
    symbol: 'AAA',
    price: 15,
    change: 3,
    pct: 25,
    updated: Date.parse('2026-09-11T16:00:00Z') / 1000,
    sessionDate: '2026-09-11',
  })
})

test('uses one canonical current session and excludes missing quotes from 1D totals', () => {
  const payload = makeHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 15, change: 3, pct: 25, sessionDate: '2026-09-11' },
  }, '2026-09-11', '2026-09-11T16:00:00.000Z')

  assert.equal(result.oneDay.source, 'regular-session-quote')
  assert.equal(result.oneDay.baselineDate, '2026-09-10')
  assert.equal(result.holdings[0].marketValue, 30)
  assert.equal(result.holdings[0].growth[1].valueChange, 6)
  assert.equal(result.holdings[0].growth[1].baselineDate, '2026-09-10')
  assert.equal(result.holdings[1].marketValue, null)
  assert.equal(result.holdings[1].growth[1], null)
  assert.equal(result.aggregate.marketValue, 30)
  assert.equal(result.aggregate.growth[1].valueChange, 6)
  assert.equal(result.aggregate.growth[1].includedSymbols, 1)
  assert.equal(result.aggregate.growth[1].missingSymbols, 1)
  assert.deepEqual(result.quoteErrors.map(error => error.symbol), ['BBB'])
})

test('uses the prior candle date as baseline when the quote is the latest close', () => {
  const payload = makeHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 12, change: 2, pct: 20, sessionDate: '2026-09-10' },
    BBB: { price: 18, change: -2, pct: -10, sessionDate: '2026-09-10' },
  }, '2026-09-10', '2026-09-10T20:01:00.000Z')

  assert.equal(result.oneDay.baselineDate, '2026-09-09')
  assert.equal(result.holdings[0].growth[1].baselineDate, '2026-09-09')
  assert.equal(result.aggregate.growth[1].valueChange, 2)
  assert.equal(result.aggregate.growth[1].includedSymbols, 2)
})

test('keeps same-session completed closes when an individual quote is missing', () => {
  const payload = makeHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 12, change: 2, pct: 20, sessionDate: '2026-09-10' },
  }, '2026-09-10', '2026-09-10T20:01:00.000Z')

  assert.equal(result.holdings[1].asOf, '2026-09-10')
  assert.equal(result.holdings[1].marketValue, 18)
  assert.equal(result.holdings[1].growth[1].valueChange, -2)
  assert.equal(result.aggregate.marketValue, 42)
  assert.equal(result.aggregate.growth[1].valueChange, 2)
  assert.equal(result.aggregate.growth[1].includedSymbols, 2)
  assert.equal(result.aggregate.growth[1].missingSymbols, 0)
  assert.deepEqual(result.quoteErrors.map(error => error.symbol), ['BBB'])
})

test('falls back wholly to completed closes when quotes trail candle history', () => {
  const payload = makeHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 10, change: 1, pct: 11.11, sessionDate: '2026-09-09' },
  }, '2026-09-09', '2026-09-09T20:01:00.000Z')

  assert.equal(result.oneDay.source, 'completed-closes')
  assert.equal(result.oneDay.missingSymbols, 0)
  assert.equal(result.aggregate.growth[1].valueChange, 2)
  assert.deepEqual(result.holdings, payload.holdings)
})
