import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYSIS_PERIODS,
  applyRegularSessionQuotes,
  aggregateHoldingsBySymbol,
  calculateGrowthAggregate,
  calculateHoldingGrowth,
  normalizeCompletedCandles,
  normalizeRegularSessionQuotes,
} from './server-analysis.js'

function makeHistoricalPayload() {
  const canonicalCandles = [
    { date: '2026-09-09', close: 10 },
    { date: '2026-09-10', close: 12 },
  ]
  const holdings = [
    calculateHoldingGrowth(
      { symbol: 'AAA', shares: 2 },
      canonicalCandles
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
    nextSessionBaselineDates: { 1: '2026-09-10' },
    canonicalSymbol: 'AAA',
    canonicalLastClose: 12,
    expectedNextSessionDate: '2026-09-11',
    holdings,
    aggregate: calculateGrowthAggregate(holdings),
    errors: [],
    retrievedAt: '2026-09-11T14:00:00.000Z',
    cached: false,
  }
}

function makeLongHistoricalPayload() {
  const canonicalCandles = Array.from({ length: 61 }, (_, index) => ({
    timestamp: index,
    date: `session-${String(index + 1).padStart(3, '0')}`,
    close: 101 + index,
  }))
  const secondCandles = canonicalCandles.map(candle => ({
    ...candle,
    close: candle.close + 100,
  }))
  const holdings = [
    calculateHoldingGrowth({ symbol: 'AAA', shares: 2 }, canonicalCandles, canonicalCandles),
    calculateHoldingGrowth({ symbol: 'BBB', shares: 1 }, secondCandles, canonicalCandles),
  ]

  return {
    periods: ANALYSIS_PERIODS,
    asOf: 'session-061',
    baselineDates: Object.fromEntries(
      ANALYSIS_PERIODS.map(period => [period, canonicalCandles.at(-1 - period)?.date || null])
    ),
    nextSessionBaselineDates: Object.fromEntries(
      ANALYSIS_PERIODS.map(period => [period, canonicalCandles.at(-period)?.date || null])
    ),
    canonicalSymbol: 'AAA',
    canonicalLastClose: 161,
    expectedNextSessionDate: null,
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
  assert.equal(row.currentSessionBaselines[3].baselineClose, 158)
  assert.equal(row.currentSessionBaselines[60].baselineClose, 101)
  assert.equal(row.nextSessionBaselines[1].baselineClose, 161)
  assert.equal(row.nextSessionBaselines[3].baselineClose, 159)
  assert.equal(row.nextSessionBaselines[60].baselineClose, 102)
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

test('keeps a regular-session price when quote change is unavailable', () => {
  const quotes = normalizeRegularSessionQuotes({
    symbol: ['AAA'],
    last: [15],
    change: [null],
    changepct: [null],
    updated: [Date.parse('2026-09-11T16:00:00Z') / 1000],
  })

  assert.equal(quotes.AAA.price, 15)
  assert.equal(quotes.AAA.change, null)
  assert.equal(quotes.AAA.pct, null)
  assert.equal(quotes.AAA.sessionDate, '2026-09-11')
})

test('uses one canonical current session and excludes missing quotes from all periods', () => {
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
  assert.equal(result.holdings[1].growth[60], null)
  assert.equal(result.aggregate.marketValue, 30)
  assert.equal(result.aggregate.growth[1].valueChange, 6)
  assert.equal(result.aggregate.growth[1].includedSymbols, 1)
  assert.equal(result.aggregate.growth[1].missingSymbols, 1)
  assert.deepEqual(result.quoteErrors.map(error => error.symbol), ['BBB'])
})

test('uses the latest quote as endpoint for every period in the next session', () => {
  const payload = makeLongHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 166, change: 5, pct: 3.11, sessionDate: 'session-062' },
    BBB: { price: 266, change: 4, pct: 1.53, sessionDate: 'session-062' },
  }, 'session-062', '2026-09-11T16:00:00.000Z')

  assert.equal(result.asOf, 'session-062')
  assert.equal(result.analysisEndpoint.source, 'regular-session-quote')
  assert.equal(result.baselineDates[3], 'session-059')
  assert.equal(result.baselineDates[60], 'session-002')
  assert.equal(result.holdings[0].growth[3].baselineClose, 159)
  assert.equal(result.holdings[0].growth[3].valueChange, 14)
  assert.equal(result.holdings[0].growth[60].baselineClose, 102)
  assert.equal(result.holdings[0].growth[60].valueChange, 128)
  assert.equal(result.holdings[1].growth[1].baselineClose, 262)
  assert.equal(result.holdings[1].growth[1].valueChange, 4)
  assert.equal(result.aggregate.growth[1].valueChange, 14)
  assert.equal(result.aggregate.growth[3].valueChange, 21)
  assert.ok(Math.abs(result.aggregate.growth[3].pct - (21 / 577) * 100) < 1e-10)
  assert.equal(result.aggregate.growth[60].valueChange, 192)
  assert.equal(result.aggregate.growth[60].includedSymbols, 2)
})

test('keeps Val while excluding only periods without enough history', () => {
  const payload = makeLongHistoricalPayload()
  const canonicalCandles = Array.from({ length: 61 }, (_, index) => ({
    timestamp: index,
    date: `session-${String(index + 1).padStart(3, '0')}`,
    close: 101 + index,
  }))
  const shortHistory = canonicalCandles.slice(-5).map(candle => ({
    ...candle,
    close: candle.close + 200,
  }))
  payload.holdings.push(
    calculateHoldingGrowth({ symbol: 'CCC', shares: 1 }, shortHistory, canonicalCandles)
  )
  payload.aggregate = calculateGrowthAggregate(payload.holdings)

  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 166, change: 5, pct: 3.11, sessionDate: 'session-062' },
    BBB: { price: 266, change: 5, pct: 1.92, sessionDate: 'session-062' },
    CCC: { price: 366, change: 5, pct: 1.39, sessionDate: 'session-062' },
  }, 'session-062', '2026-09-11T16:00:00.000Z')

  assert.equal(result.holdings[2].marketValue, 366)
  assert.equal(result.holdings[2].growth[3].valueChange, 7)
  assert.equal(result.holdings[2].growth[10], null)
  assert.equal(result.aggregate.marketValueIncludedSymbols, 3)
  assert.equal(result.aggregate.growth[3].includedSymbols, 3)
  assert.equal(result.aggregate.growth[10].includedSymbols, 2)
})

test('keeps all completed-close periods for a missing same-session quote', () => {
  const payload = makeLongHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 161, change: 1, pct: 0.63, sessionDate: 'session-061' },
  }, 'session-061', '2026-09-11T20:01:00.000Z')

  assert.equal(result.holdings[1].asOf, 'session-061')
  assert.equal(result.holdings[1].growth[3].valueChange, 3)
  assert.equal(result.holdings[1].growth[60].valueChange, 60)
  assert.equal(result.aggregate.growth[3].valueChange, 9)
  assert.equal(result.aggregate.growth[60].includedSymbols, 2)
})

test('uses exact older baselines when a same-session quote replaces a missing latest candle', () => {
  const payload = makeLongHistoricalPayload()
  const canonicalCandles = Array.from({ length: 61 }, (_, index) => ({
    timestamp: index,
    date: `session-${String(index + 1).padStart(3, '0')}`,
    close: 101 + index,
  }))
  const historyWithoutLatest = canonicalCandles.slice(0, -1).map(candle => ({
    ...candle,
    close: candle.close + 200,
  }))
  const holding = calculateHoldingGrowth(
    { symbol: 'CCC', shares: 1 },
    historyWithoutLatest,
    canonicalCandles
  )
  payload.holdings = [holding]
  payload.aggregate = calculateGrowthAggregate(payload.holdings)

  const result = applyRegularSessionQuotes(payload, {
    CCC: { price: 361, change: 1, pct: 0.28, sessionDate: 'session-061' },
  }, 'session-061', '2026-09-11T20:01:00.000Z')

  assert.equal(result.holdings[0].marketValue, 361)
  assert.equal(result.holdings[0].growth[1].baselineDate, 'session-060')
  assert.equal(result.holdings[0].growth[3].baselineDate, 'session-058')
  assert.equal(result.holdings[0].growth[3].valueChange, 3)
  assert.equal(result.holdings[0].growth[60].baselineDate, 'session-001')
})

test('does not label an older previous close as the canonical 1D baseline', () => {
  const canonicalCandles = [
    { date: 'session-001', close: 8 },
    { date: 'session-002', close: 9 },
    { date: 'session-003', close: 10 },
  ]
  const sparseCandles = [canonicalCandles[0], canonicalCandles[2]]
  const holding = calculateHoldingGrowth(
    { symbol: 'HALT', shares: 2 },
    sparseCandles,
    canonicalCandles
  )
  const payload = {
    periods: ANALYSIS_PERIODS,
    asOf: 'session-003',
    baselineDates: { 1: 'session-002' },
    nextSessionBaselineDates: { 1: 'session-003' },
    canonicalSymbol: 'HALT',
    canonicalLastClose: 10,
    expectedNextSessionDate: null,
    holdings: [holding],
    aggregate: calculateGrowthAggregate([holding]),
    errors: [],
  }
  const result = applyRegularSessionQuotes(payload, {
    HALT: { price: 10, change: 2, pct: 25, sessionDate: 'session-003' },
  }, 'session-003', '2026-09-11T20:01:00.000Z')

  assert.equal(result.holdings[0].marketValue, 20)
  assert.equal(result.holdings[0].growth[1], null)
  assert.equal(result.aggregate.growth[1].includedSymbols, 0)
  assert.equal(result.aggregate.growth[1].missingSymbols, 1)
})

test('falls back when a newer quote cannot be aligned to the next completed session', () => {
  const payload = makeLongHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 170, change: 1, pct: 0.59, sessionDate: 'session-062' },
    BBB: { price: 270, change: 1, pct: 0.37, sessionDate: 'session-062' },
  }, 'session-062', '2026-09-11T16:00:00.000Z')

  assert.equal(result.oneDay.source, 'completed-closes')
  assert.equal(result.analysisEndpoint.source, 'completed-closes')
  assert.equal(result.asOf, 'session-061')
  assert.equal(result.holdings[0].growth[3].valueChange, 6)
})

test('falls back when an observed next candle belongs to a different session', () => {
  const payload = makeLongHistoricalPayload()
  payload.expectedNextSessionDate = 'session-063'
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 166, change: 5, pct: 3.11, sessionDate: 'session-062' },
    BBB: { price: 266, change: 5, pct: 1.92, sessionDate: 'session-062' },
  }, 'session-062', '2026-09-11T16:00:00.000Z')

  assert.equal(result.analysisEndpoint.source, 'completed-closes')
  assert.equal(result.asOf, 'session-061')
})

test('falls back when the continuity quote belongs to another session', () => {
  const payload = makeLongHistoricalPayload()
  const result = applyRegularSessionQuotes(payload, {
    AAA: { price: 166, change: 5, pct: 3.11, sessionDate: 'session-061' },
    BBB: { price: 266, change: 5, pct: 1.92, sessionDate: 'session-062' },
  }, 'session-062', '2026-09-11T16:00:00.000Z')

  assert.equal(result.analysisEndpoint.source, 'completed-closes')
  assert.equal(result.asOf, 'session-061')
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
