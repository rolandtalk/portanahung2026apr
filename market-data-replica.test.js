import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isAuthorizedIngestRequest,
  validateIngestPayload,
} from './market-data-replica.js'

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: 'batch-001',
    generatedAt: '2026-09-12T12:00:00Z',
    prices: [],
    quotes: [],
    ...overrides,
  }
}

test('ingest authorization accepts only the configured bearer token', () => {
  assert.equal(isAuthorizedIngestRequest('Bearer secret-value', 'secret-value'), true)
  assert.equal(isAuthorizedIngestRequest('Bearer wrong-value', 'secret-value'), false)
  assert.equal(isAuthorizedIngestRequest(undefined, 'secret-value'), false)
  assert.equal(isAuthorizedIngestRequest('Bearer secret-value', undefined), false)
})

test('validates canonical prices, quotes, and an explicit empty portfolio', () => {
  const result = validateIngestPayload(payload({
    prices: [{
      symbol: 'aapl',
      sessionDate: '2026-09-11',
      close: 230,
      adjustedClose: 229,
      rawClose: 230,
      source: 'yfinance',
      fetchedAt: '2026-09-12T12:00:00Z',
    }],
    quotes: [{
      symbol: 'AAPL',
      sessionDate: '2026-09-11',
      price: 230,
      previousClose: 225,
      source: 'marketdata.app',
      updatedAt: '2026-09-11T20:00:00Z',
    }],
    portfolios: { FT: [] },
  }), 'batch-001')

  assert.equal(result.prices[0].symbol, 'AAPL')
  assert.equal(result.quotes[0].change, 5)
  assert.equal(result.quotes[0].changePct, (5 / 225) * 100)
  assert.deepEqual(result.portfolios.FT, [])
})

test('last duplicate price wins within a batch', () => {
  const result = validateIngestPayload(payload({
    prices: [
      {
        symbol: 'SPY', sessionDate: '2026-09-11', close: 650,
        source: 'yfinance', fetchedAt: '2026-09-12T11:00:00Z',
      },
      {
        symbol: 'SPY', sessionDate: '2026-09-11', close: 651,
        source: 'yfinance', fetchedAt: '2026-09-12T12:00:00Z',
      },
    ],
  }))

  assert.equal(result.prices.length, 1)
  assert.equal(result.prices[0].close, 651)
})

test('rejects a mismatched idempotency key and invalid prices', () => {
  assert.throws(
    () => validateIngestPayload(payload({
      prices: [{
        symbol: 'AAPL', sessionDate: '2026-09-11', close: 0,
        source: 'yfinance', fetchedAt: '2026-09-12T12:00:00Z',
      }],
    }), 'different-batch'),
    /Idempotency-Key must match batchId/
  )
  assert.throws(
    () => validateIngestPayload(payload({
      prices: [{
        symbol: 'AAPL', sessionDate: '2026-09-11', close: 0,
        source: 'yfinance', fetchedAt: '2026-09-12T12:00:00Z',
      }],
    })),
    /close must be a positive number/
  )
})

