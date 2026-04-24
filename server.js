import express from 'express'
import cors from 'cors'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { google } from 'googleapis'

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

// Google Sheets write client (service account)
let sheetsClient = null
try {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64
  if (b64) {
    const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
    sheetsClient = google.sheets({ version: 'v4', auth })
    console.log('Google Sheets write client: ✓ initialized')
  } else {
    console.warn('Google Sheets write client: ✗ GOOGLE_SERVICE_ACCOUNT_B64 not set')
  }
} catch (err) {
  console.error('Google Sheets write client init failed:', err.message)
}

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Serve built frontend from dist/
const distPath = join(process.cwd(), 'dist')
app.use(express.static(distPath))

/**
 * GET /api/quotes?symbols=AAPL,TSLA,GOOG
 * Returns real-time quote data from marketdata.app
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

  if (!MARKETDATA_TOKEN) {
    return res.status(500).json({ error: 'MARKETDATA_TOKEN not configured' })
  }

  try {
    const results = await Promise.allSettled(
      symbols.map(symbol =>
        fetch(`${MARKETDATA_BASE}/stocks/quotes/${symbol}/`, {
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

    res.json({ quotes, retrievedAt })
  } catch (err) {
    console.error('Quote fetch error:', err)
    res.status(500).json({ error: 'Failed to fetch quotes', detail: err.message })
  }
})

const SHEET_ID = '1XsHYx1Ifb-y2jX2mssDCB7ICW4YnhEsjWiDi3F3UIdE'

/**
 * GET /api/sheet/:tab
 * Fetches SMBL, SHARES, COST from a Google Sheets tab (public sheet, CSV export).
 */
app.get('/api/sheet/:tab', async (req, res) => {
  const tab = req.params.tab.toUpperCase()
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
    res.json({ tab, holdings })
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
  if (!sheetsClient) return res.json({ entries: [] })
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
    res.json({ entries })
  } catch {
    res.json({ entries: [] })
  }
})

/**
 * POST /api/history
 * Appends or replaces today's snapshot row in the HISTORY sheet tab.
 * Body: { date, time, summary, CUB, PSC, DBS, FT }
 */
app.post('/api/history', async (req, res) => {
  if (!sheetsClient) return res.status(503).json({ error: 'Sheets not configured' })
  const { date, time, summary, CUB, PSC, DBS, FT } = req.body

  try {
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
    res.json({ ok: true })
  } catch (err) {
    console.error('History write error:', err.message)
    res.status(500).json({ error: err.message })
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
    res.json({ ok: true, tab, count: holdings.length })
  } catch (err) {
    console.error('Sheet write error:', err.message)
    res.status(500).json({ error: 'Failed to write to sheet', detail: err.message })
  }
})

// Catch-all: serve index.html for React client-side routing
app.get('*', (_req, res) => {
  res.sendFile(join(process.cwd(), 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`)
  console.log(`Using marketdata.app token: ${MARKETDATA_TOKEN ? '✓ loaded' : '✗ MISSING'}`)
})
