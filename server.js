import express from 'express'
import cors from 'cors'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { google } from 'googleapis'
import cron from 'node-cron'
import {
  createMarketDataReplica,
  isAuthorizedIngestRequest,
  REPLICA_PORTFOLIOS,
} from './market-data-replica.js'
import {
  ANALYSIS_PERIODS,
  applyRegularSessionQuotes,
  aggregateHoldingsBySymbol,
  buildAssetValueCharts,
  calculateGrowthAggregate,
  calculateHoldingGrowth,
  normalizeCompletedCandles,
  normalizeDailyCandles,
  normalizeRegularSessionQuotes,
} from './server-analysis.js'

// Load .env manually (no dotenv dependency needed)
try {
  const envPath = resolve(process.cwd(), '.env')
  const envContent = readFileSync(envPath, 'utf8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim()
  }
} catch { /* .env not found, rely on system env */ }

const MARKETDATA_TOKEN = process.env.MARKETDATA_TOKEN
const MARKETDATA_BASE = 'https://api.marketdata.app/v1'
const RAILWAY_INGEST_TOKEN = process.env.RAILWAY_INGEST_TOKEN
const marketDataReplica = createMarketDataReplica({
  connectionString: process.env.DATABASE_URL,
})
const requestedReplicaMode = String(
  process.env.MARKET_DATA_READ_MODE || (marketDataReplica.configured ? 'prefer-replica' : 'upstream-only')
).toLowerCase()
const REPLICA_READ_MODE = ['prefer-replica', 'replica-only', 'upstream-only'].includes(requestedReplicaMode)
  ? requestedReplicaMode
  : 'prefer-replica'

function replicaReadsEnabled() {
  return marketDataReplica.configured && REPLICA_READ_MODE !== 'upstream-only'
}

function replicaRequired() {
  return REPLICA_READ_MODE === 'replica-only'
}

// Google Sheets write client (service account)
let sheetsClient = null
let sheetsInitError = null
try {
  let credentials = null

  // Try individual env vars first (GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  if (clientEmail && privateKey) {
    credentials = { type: 'service_account', client_email: clientEmail, private_key: privateKey }
    console.log('Google Sheets: using GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY')
  }

  // Fallback: decode GOOGLE_SERVICE_ACCOUNT_B64 from env
  if (!credentials && process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    try {
      const json = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
      credentials = JSON.parse(json)
      console.log('Google Sheets: using GOOGLE_SERVICE_ACCOUNT_B64')
    } catch (e) {
      console.warn('GOOGLE_SERVICE_ACCOUNT_B64 parse failed:', e.message)
    }
  }

  if (credentials) {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
    sheetsClient = google.sheets({ version: 'v4', auth })
    console.log('Google Sheets write client: ✓ initialized')
  } else {
    console.warn('Google Sheets write client: ✗ no credentials found (set GOOGLE_SERVICE_ACCOUNT_B64 or GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY)')
  }
} catch (err) {
  sheetsInitError = err.message
  console.error('Google Sheets write client init failed:', err.message)
}

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json({ limit: '5mb' }))

// Serve built frontend from dist/
const distPath = join(process.cwd(), 'dist')
app.use(express.static(distPath))

/**
 * POST /api/ingest/market-data
 * Authenticated Mac collector -> Railway PostgreSQL replication endpoint.
 * The batch ID is also the idempotency key, so a collector may safely retry.
 */
app.post('/api/ingest/market-data', async (req, res) => {
  if (!marketDataReplica.configured) {
    return res.status(503).json({ error: 'DATABASE_URL not configured' })
  }
  if (!RAILWAY_INGEST_TOKEN) {
    return res.status(503).json({ error: 'RAILWAY_INGEST_TOKEN not configured' })
  }
  if (!isAuthorizedIngestRequest(req.get('authorization'), RAILWAY_INGEST_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const result = await marketDataReplica.ingest(req.body, {
      idempotencyKey: req.get('Idempotency-Key') || undefined,
    })
    invalidateHoldingsGrowthCache()
    const payload = result.payload
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      duplicate: result.duplicate,
      batchId: payload.batchId,
      accepted: {
        prices: payload.prices.length,
        quotes: payload.quotes.length,
        portfolios: Object.fromEntries(
          Object.entries(payload.portfolios || {}).map(([key, rows]) => [key, rows.length])
        ),
      },
    })
  } catch (err) {
    const status = Number(err.statusCode) || 500
    if (status >= 500) console.error('Market data ingest failed:', err.message)
    res.status(status).json({
      error: status === 400 ? err.message : 'Market data ingest failed',
      ...(status >= 500 ? { detail: err.message } : {}),
    })
  }
})

/**
 * GET /api/replica/status
 * Operational metadata only; never exposes the database URL or ingest token.
 */
app.get('/api/replica/status', async (_req, res) => {
  try {
    const status = await marketDataReplica.status()
    res.set('Cache-Control', 'no-store').json({
      ...status,
      readMode: REPLICA_READ_MODE,
    })
  } catch (err) {
    res.status(503).json({
      configured: marketDataReplica.configured,
      ready: false,
      readMode: REPLICA_READ_MODE,
      error: 'Market data replica unavailable',
      detail: err.message,
    })
  }
})

function publicReplicaQuotes(symbols, result) {
  return Object.fromEntries(symbols.map(symbol => {
    const quote = result.quotes[symbol]
    return [symbol, quote ? {
      symbol,
      price: quote.price,
      dayChangePct: quote.pct,
      dayChange: quote.change,
    } : {
      symbol,
      price: null,
      dayChangePct: null,
      dayChange: null,
      error: true,
    }]
  }))
}

/**
 * GET /api/quotes?symbols=AAPL,TSLA,GOOG
 * Reads the latest collector snapshot from PostgreSQL. `prefer-replica` uses
 * Marketdata.app only as a bootstrap fallback before the first quote ingest.
 */
app.get('/api/quotes', async (req, res) => {
  const raw = req.query.symbols
  if (!raw) {
    return res.status(400).json({ error: 'symbols query param required' })
  }

  const symbols = String(raw)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)

  if (symbols.length === 0) {
    return res.status(400).json({ error: 'No valid symbols provided' })
  }
  if (symbols.length > 500) {
    return res.status(400).json({ error: 'At most 500 symbols may be requested' })
  }

  if (replicaReadsEnabled()) {
    try {
      const replica = await marketDataReplica.getQuotes(symbols)
      if (replica.ready) {
        const retrievedAt = replica.state?.generatedAt || Object.values(replica.quotes)
          .map(quote => quote.fetchedAt)
          .filter(Boolean)
          .sort()
          .at(-1) || null
        return res.json({
          quotes: publicReplicaQuotes(symbols, replica),
          retrievedAt,
          source: 'railway-postgres',
          stale: replica.missingSymbols.length > 0,
          missingSymbols: replica.missingSymbols,
        })
      }
      if (replicaRequired()) {
        return res.status(503).json({ error: 'Quote replica has not been seeded' })
      }
    } catch (err) {
      console.error('Quote replica read failed:', err.message)
      if (replicaRequired()) {
        return res.status(503).json({ error: 'Quote replica unavailable', detail: err.message })
      }
    }
  } else if (replicaRequired()) {
    return res.status(503).json({ error: 'DATABASE_URL not configured' })
  }

  if (!MARKETDATA_TOKEN) {
    return res.status(500).json({ error: 'MARKETDATA_TOKEN not configured' })
  }

  try {
    const results = await Promise.allSettled(
      symbols.map(symbol =>
        fetch(`${MARKETDATA_BASE}/stocks/quotes/${symbol}/?extended=false`, {
          headers: {
            Authorization: `Bearer ${MARKETDATA_TOKEN}`,
            Accept: 'application/json',
          },
        }).then(r => r.json())
      )
    )

    const quotes = {}
    results.forEach((result, i) => {
      const symbol = symbols[i]
      if (result.status === 'fulfilled') {
        const data = result.value
        // marketdata.app returns arrays even for single symbols
        if (data.s === 'ok' && data.last?.[0] != null) {
          quotes[symbol] = {
            symbol,
            price: data.last[0],
            dayChangePct: data.changepct?.[0] != null ? data.changepct[0] * 100 : null, // convert 0.019 → 1.9
            dayChange: data.change?.[0] ?? null,
          }
        } else {
          console.warn(`Bad response for ${symbol}:`, JSON.stringify(data))
          quotes[symbol] = { symbol, price: null, dayChangePct: null, dayChange: null, error: true }
        }
      } else {
        console.warn(`Failed to fetch ${symbol}:`, result.reason?.message)
        quotes[symbol] = { symbol, price: null, dayChangePct: null, dayChange: null, error: true }
      }
    })

    const retrievedAt = new Date().toLocaleString('en-US', {
      month: 'short', day: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    })

    res.json({ quotes, retrievedAt, source: 'marketdata-bootstrap', stale: false })
  } catch (err) {
    console.error('Quote fetch error:', err)
    res.status(500).json({ error: 'Failed to fetch quotes', detail: err.message })
  }
})

/**
 * GET /api/portfolios
 * Returns every replicated holding joined to its latest quote in one Railway
 * request. This is the browser startup/focus path; it never contacts Google or
 * a market-data provider.
 */
app.get('/api/portfolios', async (_req, res) => {
  if (!replicaReadsEnabled()) {
    return res.status(503).json({ error: 'Railway portfolio replica is not enabled' })
  }

  try {
    const holdingsResult = await marketDataReplica.getPortfolios(REPLICA_PORTFOLIOS)
    if (!holdingsResult.ready) {
      return res.status(503).json({
        error: 'Holdings replica has not been seeded',
        missingPortfolios: holdingsResult.missingPortfolios,
      })
    }

    const symbols = [...new Set(
      Object.values(holdingsResult.portfolios).flat().map(holding => holding.symbol)
    )]
    const quoteResult = await marketDataReplica.getQuotes(symbols)
    const portfolios = Object.fromEntries(REPLICA_PORTFOLIOS.map(portfolio => [
      portfolio,
      holdingsResult.portfolios[portfolio].map(holding => {
        const quote = quoteResult.quotes[holding.symbol]
        return {
          ...holding,
          price: quote?.price ?? null,
          dayChange: quote?.pct ?? null,
          quoteSource: quote?.source ?? null,
          quoteUpdatedAt: quote?.providerUpdatedAt || quote?.fetchedAt || null,
        }
      }),
    ]))
    const holdingRetrievedAt = Object.values(holdingsResult.states)
      .map(state => state.generatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null

    res.json({
      portfolios,
      retrievedAt: quoteResult.state?.generatedAt || holdingRetrievedAt,
      source: 'railway-postgres',
      stale: quoteResult.missingSymbols.length > 0,
      missingSymbols: quoteResult.missingSymbols,
    })
  } catch (err) {
    console.error('Portfolio replica read failed:', err.message)
    res.status(503).json({ error: 'Portfolio replica unavailable', detail: err.message })
  }
})

const SHEET_ID = '1XsHYx1Ifb-y2jX2mssDCB7ICW4YnhEsjWiDi3F3UIdE'
const PORTFOLIO_KEYS = [...REPLICA_PORTFOLIOS]

/**
 * GET /api/sheet/:tab
 * Fetches SMBL, SHARES, COST from a Google Sheets tab (public sheet, CSV export).
 */
app.get('/api/sheet/:tab', async (req, res) => {
  const tab = req.params.tab.toUpperCase()
  if (!PORTFOLIO_KEYS.includes(tab)) {
    return res.status(404).json({ error: 'Unknown portfolio tab' })
  }

  if (replicaReadsEnabled()) {
    try {
      const replica = await marketDataReplica.getPortfolios([tab])
      if (replica.ready) {
        return res.json({
          tab,
          holdings: replica.portfolios[tab],
          source: 'railway-postgres',
          retrievedAt: replica.states[tab]?.generatedAt || null,
        })
      }
      if (replicaRequired()) {
        return res.status(503).json({ error: `${tab} holdings replica has not been seeded` })
      }
    } catch (err) {
      console.error(`Holdings replica read failed for ${tab}:`, err.message)
      if (replicaRequired()) {
        return res.status(503).json({ error: 'Holdings replica unavailable', detail: err.message })
      }
    }
  }

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    })
    if (!response.ok) {
      return res.status(502).json({ error: `Sheet fetch failed: ${response.status}` })
    }
    const csv = await response.text()
    // gviz returns quoted CSV: "SMBL","SHARES","COST"
    const lines = csv.trim().split('\n').filter(Boolean)
    if (lines.length < 2) return res.json({ holdings: [] })

    const holdings = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, '').trim())
      const symbol = cols[0]?.toUpperCase()
      const shares = parseFloat(cols[1])
      const cost   = parseFloat(cols[2])
      if (symbol && !isNaN(shares) && !isNaN(cost)) {
        holdings.push({ symbol, shares, cost })
      }
    }
    console.log(`Sheet ${tab}: ${holdings.length} holdings, first: ${holdings[0]?.symbol}`)
    res.json({ tab, holdings, source: 'google-sheets-bootstrap' })
  } catch (err) {
    console.error('Sheet fetch error:', err)
    res.status(500).json({ error: 'Failed to fetch sheet', detail: err.message })
  }
})

/**
 * GET /api/history
 * Reads all snapshot rows from the HISTORY sheet tab (newest first).
 */
app.get('/api/history', async (req, res) => {
  if (replicaReadsEnabled()) {
    try {
      const replica = await marketDataReplica.getHistory()
      if (replica.ready) {
        return res.json({
          entries: replica.entries,
          source: 'railway-postgres',
          retrievedAt: replica.state?.generatedAt || null,
        })
      }
      // In strict mode an empty, not-yet-seeded history is still a valid 200
      // response and never falls through to Google.
      if (replicaRequired()) {
        return res.json({ entries: [], source: 'railway-postgres', stale: true })
      }
    } catch (err) {
      console.error('History replica read failed:', err.message)
      if (replicaRequired()) {
        return res.status(503).json({ error: 'History replica unavailable', detail: err.message })
      }
    }
  }
  if (!sheetsClient) return res.json({ entries: [], source: 'unavailable' })
  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'HISTORY!A2:G',
    })
    const rows = response.data.values || []
    const entries = rows
      .map(row => ({
        date:    row[0] || '',
        time:    row[1] || '',
        summary: parseFloat(row[2]) || 0,
        CUB:     parseFloat(row[3]) || 0,
        PSC:     parseFloat(row[4]) || 0,
        DBS:     parseFloat(row[5]) || 0,
        FT:      parseFloat(row[6]) || 0,
      }))
      .filter(e => e.date)
      .reverse() // newest first
    if (marketDataReplica.configured) {
      await marketDataReplica.replaceHistory(entries).catch(error => {
        console.warn('History bootstrap into replica failed:', error.message)
      })
    }
    res.json({ entries, source: 'google-sheets-bootstrap' })
  } catch {
    res.json({ entries: [], source: 'google-sheets-bootstrap' })
  }
})

/**
 * DELETE /api/history
 * Clears all snapshot rows from the HISTORY sheet (keeps header).
 */
app.delete('/api/history', async (_req, res) => {
  if (!sheetsClient && !marketDataReplica.configured) {
    return res.status(503).json({ error: 'History storage not configured' })
  }
  try {
    const replicaUpdated = marketDataReplica.configured
      ? await marketDataReplica.clearHistory()
      : false
    let sheetUpdated = false
    if (sheetsClient) {
      await sheetsClient.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: 'HISTORY!A2:G',
      })
      sheetUpdated = true
    }
    console.log('History: cleared all rows')
    res.json({ ok: true, replicaUpdated, sheetUpdated })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/history
 * Appends or replaces today's snapshot row in the HISTORY sheet tab.
 * Body: { date, time, summary, CUB, PSC, DBS, FT }
 */
app.post('/api/history', async (req, res) => {
  const { date, time, summary, CUB, PSC, DBS, FT } = req.body
  if (!sheetsClient && !marketDataReplica.configured) {
    return res.status(503).json({ error: 'History storage not configured' })
  }

  try {
    const snapshot = { date, time, summary, CUB, PSC, DBS, FT }
    const replicaUpdated = marketDataReplica.configured
      ? await marketDataReplica.upsertHistory(snapshot)
      : false
    if (!sheetsClient) {
      return res.json({ ok: true, replicaUpdated, sheetUpdated: false })
    }

    // Ensure HISTORY sheet exists with a header
    let headerExists = true
    try {
      await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SHEET_ID, range: 'HISTORY!A1',
      })
    } catch {
      headerExists = false
    }
    if (!headerExists) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'HISTORY' } } }] },
      }).catch(() => {}) // sheet may already exist but be empty
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'HISTORY!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [['DATE', 'TIME', 'SUMMARY', 'CUB', 'PSC', 'DBS', 'FT']] },
      })
    }

    // Find if today already has a row
    const existing = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'HISTORY!A2:A',
    }).catch(() => ({ data: { values: [] } }))
    const dates = (existing.data.values || []).map(r => r[0])
    const todayIdx = dates.indexOf(date)
    const newRow = [date, time, summary, CUB, PSC, DBS, FT]

    if (todayIdx >= 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `HISTORY!A${todayIdx + 2}`,
        valueInputOption: 'RAW',
        requestBody: { values: [newRow] },
      })
    } else {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'HISTORY!A2',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [newRow] },
      })
    }

    console.log(`History: saved snapshot for ${date}`)
    res.json({ ok: true, replicaUpdated, sheetUpdated: true })
  } catch (err) {
    console.error('History write error:', err.message)
    res.status(Number(err.statusCode) || 500).json({ error: err.message })
  }
})

/**
 * POST /api/sheet/:tab
 * Writes holdings back to the Google Sheet tab (replaces all rows after header).
 * Body: { holdings: [{ symbol, shares, cost }] }
 */
app.post('/api/sheet/:tab', async (req, res) => {
  if (!sheetsClient) {
    return res.status(503).json({ error: 'Google Sheets write client not configured' })
  }
  const tab = req.params.tab.toUpperCase()
  if (!PORTFOLIO_KEYS.includes(tab)) {
    return res.status(404).json({ error: 'Unknown portfolio tab' })
  }
  const { holdings } = req.body
  if (!Array.isArray(holdings)) {
    return res.status(400).json({ error: 'holdings array required' })
  }

  try {
    // Clear everything below the header row
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A2:Z`,
    })

    if (holdings.length > 0) {
      const rows = holdings.map(h => [h.symbol, h.shares, h.cost])
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A2`,
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      })
    }

    console.log(`Sheet ${tab}: wrote ${holdings.length} holdings`)
    let replicaUpdated = false
    if (marketDataReplica.configured) {
      try {
        replicaUpdated = await marketDataReplica.replacePortfolio(tab, holdings)
        invalidateHoldingsGrowthCache()
      } catch (replicaError) {
        console.error(`Sheet ${tab}: Google write succeeded but replica update failed:`, replicaError.message)
        return res.status(500).json({
          error: 'Google Sheet updated, but Railway replica update failed',
          detail: replicaError.message,
          sheetUpdated: true,
          replicaUpdated: false,
        })
      }
    }
    res.json({ ok: true, tab, count: holdings.length, replicaUpdated })
  } catch (err) {
    console.error('Sheet write error:', err.message)
    res.status(500).json({ error: 'Failed to write to sheet', detail: err.message })
  }
})

/**
 * GET /api/env-check
 * Shows whether key env vars are present (never reveals actual values).
 */
app.get('/api/env-check', (_req, res) => {
  const BUILD_VER = 'v6-railway-replica'
  const email  = process.env.GOOGLE_CLIENT_EMAIL  || ''
  const key    = process.env.GOOGLE_PRIVATE_KEY    || ''
  const token  = process.env.MARKETDATA_TOKEN      || ''
  const b64    = process.env.GOOGLE_SERVICE_ACCOUNT_B64 || ''
  const databaseUrl = process.env.DATABASE_URL || ''
  const ingestToken = process.env.RAILWAY_INGEST_TOKEN || ''

  let b64Valid = false
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8')
      const parsed = JSON.parse(decoded)
      b64Valid = Boolean(parsed?.client_email && parsed?.private_key)
    } catch { /* malformed credential; expose only the boolean result */ }
  }

  res.json({
    GOOGLE_SERVICE_ACCOUNT_B64: { configured: Boolean(b64), valid: b64Valid },
    GOOGLE_CLIENT_EMAIL:  { configured: Boolean(email) },
    GOOGLE_PRIVATE_KEY:   { configured: Boolean(key) },
    MARKETDATA_TOKEN:     { configured: Boolean(token) },
    DATABASE_URL:         { configured: Boolean(databaseUrl) },
    RAILWAY_INGEST_TOKEN: { configured: Boolean(ingestToken) },
    MARKET_DATA_READ_MODE: REPLICA_READ_MODE,
    marketDataReplicaConfigured: marketDataReplica.configured,
    sheetsClientReady:    !!sheetsClient,
    sheetsInitFailed:     Boolean(sheetsInitError),
    NODE_ENV:             process.env.NODE_ENV || '(not set)',
    BUILD_VER,
  })
})

// ─── Daily Snapshot Logic ────────────────────────────────────────────────────

/**
 * Reads holdings from a Google Sheet tab (same CSV logic as GET /api/sheet/:tab).
 */
async function fetchHoldingsFromSheet(tab, signal) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
    signal,
  })
  if (!res.ok) throw new Error(`Sheet fetch failed for ${tab}: ${res.status}`)
  const csv = await res.text()
  const lines = csv.trim().split('\n').filter(Boolean)
  const holdings = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, '').trim())
    const symbol = cols[0]?.toUpperCase()
    const shares = parseFloat(cols[1])
    if (symbol && !isNaN(shares)) holdings.push({ symbol, shares })
  }
  return holdings
}

async function loadAllPortfolioHoldings() {
  if (replicaReadsEnabled()) {
    try {
      const replica = await marketDataReplica.getPortfolios(PORTFOLIO_KEYS)
      if (replica.ready) {
        return {
          portfolios: replica.portfolios,
          source: 'railway-postgres',
          version: PORTFOLIO_KEYS
            .map(key => replica.states[key]?.generatedAt || '')
            .sort()
            .at(-1) || '',
        }
      }
      if (replicaRequired()) {
        throw Object.assign(
          new Error(`Holdings replica missing: ${replica.missingPortfolios.join(', ')}`),
          { statusCode: 503 }
        )
      }
    } catch (error) {
      if (replicaRequired() || error.statusCode === 503) throw error
      console.warn('Holdings replica unavailable; using Google bootstrap:', error.message)
    }
  } else if (replicaRequired()) {
    throw Object.assign(new Error('DATABASE_URL not configured'), { statusCode: 503 })
  }

  const sheetController = new AbortController()
  const sheetTimeout = setTimeout(() => sheetController.abort(), 10000)
  try {
    const entries = await Promise.all(
      PORTFOLIO_KEYS.map(async key => [key, await fetchHoldingsFromSheet(key, sheetController.signal)])
    )
    return {
      portfolios: Object.fromEntries(entries),
      source: 'google-sheets-bootstrap',
      version: '',
    }
  } finally {
    clearTimeout(sheetTimeout)
  }
}

const GROWTH_CACHE_MS = 15 * 60 * 1000
let holdingsGrowthCache = { key: '', expiresAt: 0, payload: null }
const holdingsGrowthInFlight = new Map()

function invalidateHoldingsGrowthCache() {
  holdingsGrowthCache = { key: '', expiresAt: 0, payload: null }
  holdingsGrowthInFlight.clear()
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function fetchDailyCandles(symbol, parentSignal) {
  const url = `${MARKETDATA_BASE}/stocks/candles/D/${encodeURIComponent(symbol)}/?countback=62&to=today&adjustsplits=true&adjustdividends=false`
  let lastError = null

  for (let attempt = 0; attempt < 2; attempt++) {
    if (parentSignal?.aborted) throw new Error('Analysis request timed out')
    const controller = new AbortController()
    const abortFromParent = () => controller.abort()
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${MARKETDATA_TOKEN}`, Accept: 'application/json' },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.s === 'ok' && Array.isArray(data.c) && Array.isArray(data.t)) {
        return data
      }

      const error = new Error(data.errmsg || `Marketdata.app returned ${response.status}`)
      error.retryable = response.status === 429 || response.status >= 500
      throw error
    } catch (error) {
      lastError = error
      const retryable = !parentSignal?.aborted && (
        error.name === 'AbortError' || error.name === 'TypeError' || error.retryable
      )
      if (attempt === 0 && retryable) {
        await new Promise(resolveWait => setTimeout(resolveWait, 350))
        continue
      }
      break
    } finally {
      clearTimeout(timeout)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }

  throw lastError || new Error('Price history request failed')
}

async function fetchRegularSessionQuotes(symbols) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  const uniqueSymbols = [...new Set(['SPY', 'QQQ', ...symbols])]
  const url = `${MARKETDATA_BASE}/stocks/quotes/?symbols=${encodeURIComponent(uniqueSymbols.join(','))}&extended=false`

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MARKETDATA_TOKEN}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.s !== 'ok') {
      throw new Error(data.errmsg || `Marketdata.app returned ${response.status}`)
    }

    const quotes = normalizeRegularSessionQuotes(data)
    const canonicalSessionDate = quotes.SPY?.sessionDate || Object.values(quotes)
      .map(quote => quote.sessionDate)
      .filter(Boolean)
      .sort()
      .at(-1) || null
    return {
      quotes,
      canonicalSessionDate,
      retrievedAt: new Date().toISOString(),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function assembleHoldingsGrowthPayload({
  aggregated,
  histories,
  rawHistories = histories,
  fetchErrors = new Map(),
  retrievedAt = new Date().toISOString(),
  dataSource,
}) {
  const successfulHistories = [...histories.entries()]
    .filter(([, candles]) => candles.length > 0)
    .sort(([, a], [, b]) => b.length - a.length)
  const canonicalEntry = histories.get('SPY')?.length
    ? ['SPY', histories.get('SPY')]
    : successfulHistories[0] || [null, []]
  const [canonicalSymbol, canonicalCandles] = canonicalEntry
  const rawCanonicalCandles = canonicalSymbol
    ? rawHistories.get(canonicalSymbol) || []
    : []
  const canonicalLatest = canonicalCandles.at(-1) || null
  const rawCanonicalLatest = rawCanonicalCandles.at(-1) || null
  const expectedNextSessionDate = rawCanonicalLatest?.date > canonicalLatest?.date
    ? rawCanonicalLatest.date
    : null
  const errors = []
  const chartDates = canonicalCandles.map(candle => candle.date)
  const alignCloses = candles => {
    const byDate = new Map(candles.map(candle => [candle.date, candle.close]))
    return chartDates.map(date => byDate.get(date) ?? null)
  }
  const holdings = aggregated.map(holding => {
    const message = fetchErrors.get(holding.symbol)
    if (message) errors.push({ symbol: holding.symbol, message })
    const row = calculateHoldingGrowth(
      holding,
      histories.get(holding.symbol) || [],
      canonicalCandles
    )
    const withChartCloses = {
      ...row,
      chartCloses: alignCloses(histories.get(holding.symbol) || []),
    }
    return message ? { ...withChartCloses, error: message } : withChartCloses
  })

  return {
    periods: ANALYSIS_PERIODS,
    asOf: canonicalLatest?.date || null,
    baselineDates: Object.fromEntries(
      ANALYSIS_PERIODS.map(period => [period, canonicalCandles.at(-1 - period)?.date || null])
    ),
    nextSessionBaselineDates: Object.fromEntries(
      ANALYSIS_PERIODS.map(period => [period, canonicalCandles.at(-period)?.date || null])
    ),
    canonicalSymbol,
    canonicalLastClose: canonicalLatest?.close ?? null,
    expectedNextSessionDate,
    chartDates,
    benchmarkCloses: {
      SPY: alignCloses(histories.get('SPY') || []),
      QQQ: alignCloses(histories.get('QQQ') || []),
    },
    holdings,
    aggregate: calculateGrowthAggregate(holdings),
    errors,
    retrievedAt,
    cached: false,
    dataSource,
  }
}

async function buildUpstreamHoldingsGrowthPayload(aggregated) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 35000)

  try {
    const historySymbols = [...new Set(['SPY', 'QQQ', ...aggregated.map(holding => holding.symbol)])]
    const fetched = await mapWithConcurrency(
      historySymbols,
      12,
      symbol => fetchDailyCandles(symbol, controller.signal)
    )
    const histories = new Map()
    const rawHistories = new Map()
    const fetchErrors = new Map()

    historySymbols.forEach((symbol, index) => {
      const result = fetched[index]
      if (result.status === 'fulfilled') {
        rawHistories.set(symbol, normalizeDailyCandles(result.value))
        histories.set(symbol, normalizeCompletedCandles(result.value))
      } else {
        fetchErrors.set(symbol, result.reason?.message || 'Price history unavailable')
      }
    })

    return assembleHoldingsGrowthPayload({
      aggregated,
      histories,
      rawHistories,
      fetchErrors,
      retrievedAt: new Date().toISOString(),
      dataSource: 'marketdata-bootstrap',
    })
  } finally {
    clearTimeout(deadline)
  }
}

async function buildReplicaHoldingsGrowthPayload(aggregated) {
  const historySymbols = [...new Set(['SPY', 'QQQ', ...aggregated.map(holding => holding.symbol)])]
  const result = await marketDataReplica.getDailyCandles(historySymbols, 62)
  if (!result.ready) return null
  const fetchErrors = new Map(
    result.missingSymbols.map(symbol => [symbol, 'Price history unavailable in Railway replica'])
  )
  return assembleHoldingsGrowthPayload({
    aggregated,
    histories: result.histories,
    fetchErrors,
    retrievedAt: result.state?.generatedAt || new Date().toISOString(),
    dataSource: 'railway-postgres',
  })
}

async function loadRegularSessionQuotes(symbols) {
  const uniqueSymbols = [...new Set(['SPY', 'QQQ', ...symbols])]
  if (replicaReadsEnabled()) {
    try {
      const result = await marketDataReplica.getQuotes(uniqueSymbols)
      if (result.ready) {
        const canonicalSessionDate = result.quotes.SPY?.sessionDate || Object.values(result.quotes)
          .map(quote => quote.sessionDate)
          .filter(Boolean)
          .sort()
          .at(-1) || null
        return {
          value: {
            quotes: result.quotes,
            canonicalSessionDate,
            retrievedAt: result.state?.generatedAt || null,
          },
          error: result.missingSymbols.length > 0
            ? new Error(`Quote replica missing ${result.missingSymbols.length} symbol(s)`)
            : null,
          source: 'railway-postgres',
        }
      }
      if (replicaRequired()) {
        return { value: null, error: new Error('Quote replica has not been seeded'), source: 'railway-postgres' }
      }
    } catch (error) {
      if (replicaRequired()) return { value: null, error, source: 'railway-postgres' }
      console.warn('Quote replica unavailable; using Marketdata bootstrap:', error.message)
    }
  }

  if (!MARKETDATA_TOKEN) {
    return { value: null, error: new Error('MARKETDATA_TOKEN not configured'), source: null }
  }
  return fetchRegularSessionQuotes(symbols).then(
    value => ({ value, error: null, source: 'marketdata-bootstrap' }),
    error => ({ value: null, error, source: 'marketdata-bootstrap' })
  )
}

/**
 * GET /api/holdings/growth
 * Aggregates shares across every portfolio and calculates regular-session
 * growth over the previous 1, 3, 10, 20 and 60 trading sessions.
 */
app.get('/api/holdings/growth', async (_req, res) => {
  try {
    const holdingsSnapshot = await loadAllPortfolioHoldings()
    const aggregated = aggregateHoldingsBySymbol(holdingsSnapshot.portfolios)
    const symbols = aggregated.map(holding => holding.symbol)
    const quoteOutcomePromise = loadRegularSessionQuotes(symbols)

    let historicalBuilder = null
    let historicalSource = 'marketdata-bootstrap'
    let priceVersion = ''
    if (replicaReadsEnabled()) {
      try {
        const priceState = await marketDataReplica.getDatasetState('prices')
        if (priceState) {
          historicalBuilder = () => buildReplicaHoldingsGrowthPayload(aggregated)
          historicalSource = 'railway-postgres'
          priceVersion = priceState.generatedAt
        } else if (replicaRequired()) {
          throw Object.assign(new Error('Price history replica has not been seeded'), { statusCode: 503 })
        }
      } catch (error) {
        if (replicaRequired() || error.statusCode === 503) throw error
        console.warn('Price replica unavailable; using Marketdata bootstrap:', error.message)
      }
    } else if (replicaRequired()) {
      throw Object.assign(new Error('DATABASE_URL not configured'), { statusCode: 503 })
    }

    if (!historicalBuilder) {
      if (!MARKETDATA_TOKEN) {
        throw Object.assign(new Error('MARKETDATA_TOKEN not configured and price replica is not seeded'), {
          statusCode: 503,
        })
      }
      historicalBuilder = () => buildUpstreamHoldingsGrowthPayload(aggregated)
    }

    const cacheKey = [
      historicalSource,
      priceVersion,
      holdingsSnapshot.source,
      holdingsSnapshot.version,
      ...aggregated.map(holding => `${holding.symbol}:${holding.shares}`),
    ].join('|')

    let historicalPayload
    let cacheHit = false

    if (
      holdingsGrowthCache.payload &&
      holdingsGrowthCache.key === cacheKey &&
      holdingsGrowthCache.expiresAt > Date.now()
    ) {
      historicalPayload = holdingsGrowthCache.payload
      cacheHit = true
    } else {
      if (!holdingsGrowthInFlight.has(cacheKey)) {
        const pending = historicalBuilder()
          .finally(() => holdingsGrowthInFlight.delete(cacheKey))
        holdingsGrowthInFlight.set(cacheKey, pending)
      }

      historicalPayload = await holdingsGrowthInFlight.get(cacheKey)
      if (!historicalPayload) {
        throw Object.assign(new Error('Price history replica has not been seeded'), { statusCode: 503 })
      }
      holdingsGrowthCache = {
        key: cacheKey,
        expiresAt: Date.now() + GROWTH_CACHE_MS,
        payload: historicalPayload,
      }
    }

    const quoteOutcome = await quoteOutcomePromise
    if (quoteOutcome.error) {
      console.warn('Regular-session quote overlay failed:', quoteOutcome.error.message)
    }
    const payload = quoteOutcome.value
      ? applyRegularSessionQuotes(
          historicalPayload,
          quoteOutcome.value.quotes,
          quoteOutcome.value.canonicalSessionDate,
          quoteOutcome.value.retrievedAt
        )
      : applyRegularSessionQuotes(historicalPayload, {}, null, null)

    const avc = buildAssetValueCharts(payload, quoteOutcome.value?.quotes || {})
    const publicHoldings = payload.holdings.map(holding => {
      const {
        chartCloses,
        currentSessionBaselines,
        nextSessionBaselines,
        ...publicHolding
      } = holding
      return publicHolding
    })
    const {
      chartDates,
      benchmarkCloses,
      canonicalSymbol,
      canonicalLastClose,
      expectedNextSessionDate,
      nextSessionBaselineDates,
      ...publicPayload
    } = payload

    res.json({
      ...publicPayload,
      holdings: publicHoldings,
      avc,
      cached: cacheHit,
      quoteError: quoteOutcome.error?.message || null,
      holdingsSource: holdingsSnapshot.source,
      quoteSource: quoteOutcome.source,
    })
  } catch (err) {
    console.error('Holdings growth error:', err.message)
    res.status(Number(err.statusCode) || 500).json({
      error: 'Failed to calculate holdings growth',
      detail: err.message,
    })
  }
})

/**
 * Fetches live prices from marketdata.app for an array of symbols.
 * Returns { SYMBOL: price } map.
 */
async function fetchLivePrices(symbols) {
  if (!MARKETDATA_TOKEN || symbols.length === 0) return {}
  const results = await Promise.allSettled(
    symbols.map(symbol =>
      fetch(`${MARKETDATA_BASE}/stocks/quotes/${symbol}/?extended=false`, {
        headers: { Authorization: `Bearer ${MARKETDATA_TOKEN}`, Accept: 'application/json' },
      }).then(r => r.json()).then(data => ({ symbol, price: data.s === 'ok' ? data.last?.[0] : null }))
    )
  )
  const prices = {}
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.price != null) {
      prices[r.value.symbol] = r.value.price
    }
  }
  return prices
}

async function loadSnapshotPrices(symbols) {
  if (replicaReadsEnabled()) {
    try {
      const replica = await marketDataReplica.getQuotes(symbols)
      if (replica.ready) {
        return Object.fromEntries(
          Object.entries(replica.quotes).map(([symbol, quote]) => [symbol, quote.price])
        )
      }
      if (replicaRequired()) {
        throw new Error('Quote replica has not been seeded')
      }
    } catch (error) {
      if (replicaRequired()) throw error
      console.warn('Snapshot quote replica unavailable; using Marketdata bootstrap:', error.message)
    }
  }
  return fetchLivePrices(symbols)
}

/**
 * Main daily snapshot function — fetches all portfolios, gets live prices,
 * calculates market values, and writes to the HISTORY sheet.
 */
async function runDailySnapshot() {
  console.log('Daily snapshot: starting…')
  try {
    // 1. Load replicated holdings (Google is bootstrap-only until first sync).
    const holdingsSnapshot = await loadAllPortfolioHoldings()
    const allHoldings = holdingsSnapshot.portfolios

    // 2. Read the latest collector quotes from PostgreSQL.
    const allSymbols = [...new Set(Object.values(allHoldings).flat().map(h => h.symbol))]
    const prices = await loadSnapshotPrices(allSymbols)

    // 3. Calculate market values
    const mv = {}
    let total = 0
    for (const key of PORTFOLIO_KEYS) {
      mv[key] = Math.round(allHoldings[key].reduce((sum, h) => sum + h.shares * (prices[h.symbol] || 0), 0))
      total += mv[key]
    }

    // 4. Build date/time strings in Taiwan timezone
    const now = new Date()
    const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) // "2026-04-25"
    const timeStr = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: true })

    // 5. PostgreSQL is the serving copy; Google remains a backup write.
    if (marketDataReplica.configured) {
      await marketDataReplica.upsertHistory({
        date: dateStr,
        time: timeStr,
        summary: total,
        CUB: mv.CUB,
        PSC: mv.PSC,
        DBS: mv.DBS,
        FT: mv.FT,
      })
    }
    if (!sheetsClient) {
      if (!marketDataReplica.configured) throw new Error('History storage not configured')
      console.log(`Daily snapshot: ✓ saved to Railway replica for ${dateStr} ${timeStr}`)
      return
    }

    // Ensure header exists
    try { await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'HISTORY!A1' }) }
    catch {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: 'HISTORY!A1', valueInputOption: 'RAW',
        requestBody: { values: [['DATE', 'TIME', 'SUMMARY', 'CUB', 'PSC', 'DBS', 'FT']] },
      })
    }

    // Find/replace today's row
    const existing = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'HISTORY!A2:A',
    }).catch(() => ({ data: { values: [] } }))
    const dates = (existing.data.values || []).map(r => r[0])
    const todayIdx = dates.indexOf(dateStr)
    const newRow = [dateStr, timeStr, total, mv.CUB, mv.PSC, mv.DBS, mv.FT]

    if (todayIdx >= 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `HISTORY!A${todayIdx + 2}`,
        valueInputOption: 'RAW', requestBody: { values: [newRow] },
      })
    } else {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: 'HISTORY!A2',
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [newRow] },
      })
    }

    console.log(`Daily snapshot: ✓ saved for ${dateStr} ${timeStr} — Total: $${total.toLocaleString()} (CUB:${mv.CUB} PSC:${mv.PSC} DBS:${mv.DBS} FT:${mv.FT})`)
  } catch (err) {
    console.error('Daily snapshot failed:', err.message)
  }
}

/**
 * POST /api/snapshot/run
 * Manual trigger for the daily snapshot (for testing).
 */
app.post('/api/snapshot/run', async (req, res) => {
  if (!RAILWAY_INGEST_TOKEN) {
    return res.status(503).json({ error: 'Manual snapshot authentication is not configured' })
  }
  if (!isAuthorizedIngestRequest(req.get('authorization'), RAILWAY_INGEST_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    await runDailySnapshot()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/*', (_req, res) => {
  res.status(404).json({ error: 'API route not found' })
})

// Catch-all: serve index.html for React client-side routing. Keep this after
// every API route so unknown app paths, but never API endpoints, receive HTML.
app.get('*', (_req, res) => {
  res.sendFile(join(process.cwd(), 'dist', 'index.html'))
})

// Schedule: 6:00 AM Taiwan time (Asia/Taipei), Monday–Friday
cron.schedule('0 6 * * 1-5', runDailySnapshot, { timezone: 'Asia/Taipei' })
console.log('Daily snapshot cron: scheduled at 06:00 Asia/Taipei, Mon–Fri')

if (marketDataReplica.configured) {
  marketDataReplica.init().catch(error => {
    console.error('Market data replica initialization failed:', error.message)
  })
}

app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`)
  console.log(`Using marketdata.app token: ${MARKETDATA_TOKEN ? '✓ loaded' : '✗ MISSING'}`)
  console.log(`Market data replica: ${marketDataReplica.configured ? `✓ ${REPLICA_READ_MODE}` : '✗ DATABASE_URL missing'}`)
  const keys = Object.keys(process.env).sort()
  console.log(`ENV KEYS (${keys.length} total):`, keys.join(', '))
})
