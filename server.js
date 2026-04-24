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
    const json = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    credentials = JSON.parse(json)
    console.log('Google Sheets: using GOOGLE_SERVICE_ACCOUNT_B64')
  }

  // Last resort: use bundled credentials (personal portfolio app)
  if (!credentials) {
    const BUNDLED_B64 = 'ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsCiAgInByb2plY3RfaWQiOiAiZ2VuLWxhbmctY2xpZW50LTA1MzMyOTE1MTMiLAogICJwcml2YXRlX2tleV9pZCI6ICJhNzA3NDUzMGU0YmIxODhiMDIzZmU0Mjg1YzQzY2ZmYWQ0YTNhODE3IiwKICAicHJpdmF0ZV9rZXkiOiAiLS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tXG5NSUlFdkFJQkFEQU5CZ2txaGtpRzl3MEJBUUVGQUFTQ0JLWXdnZ1NpQWdFQUFvSUJBUURxa2dlakRxYmZhODVXXG5LTjF3bCtUbmcxRzg0OVEvK2kySDlwRytic2RZMXgvd0VKU1Q4d2JGZWdlUWNUZ21WSmluUVh3NUVYNHU1QS9QXG5hSjd6T0c0VnYwcnd5bE9NU1czODhrcjhObncveTJBTmF5OWR6Z3k2WFJJN2xkMXJ0QTRmMW53NjE1RzhBOHBoXG5Za3F4Wmh5L3h1bGFWUlNlTkNIclAxNml6RldsV0xyMVV5K2ljOEE1Kzk4UVRKSGpQdEpnazhpYm1HckxtaWJJXG5tby93ZXFqd2JNb1dUTkY2d0tYdDBQako4bk9hYjA2ajUvV1lUM0NVd2FRVEJTNXl3aG9Dc2ZlWCtWQmkrKzVyXG5MbEpENm9NMElkUzF5cmRzbkd5V3ZlZmdXeEpKdHBNRmdsa25yUTUvTG9UU2JJTXJndHRVNXg2NmdLMmU3TEJiXG5IR3R6UW8yZEFnTUJBQUVDZ2dFQUIveVIzTVk4cUo2bVZaT3FEOUdlei90Y1hlM21XelAxbXN1T0hWdGdrRkNpXG5XSlNJMUUxcTFuQWJmbUYyUWdQWUlvUHpIRzc3MzlHZkROcE1qNXlvcERjR3hlZTFwUlNsWnpkczZ5dzgyalV6XG4rL2dXeTJLUXJMVzgzYStBaVRRVUtzL2wvMFJ5Zll5WHRudm1HSmk3Z2I2SkdLekY2djhLMnB0N2Q4bW10ZnJ4XG41NHp5d3duRDBNUWJDU0RHYWc4RndZVkVISkE0R3p1WXR5eWxPbmlHcEhhdkhybWZoTmdzV1RhRmo5ZFpkWEJJXG5HMnV5RWVub254eS8rNWFpTER4MlFKQVNRVWUzdkxuODBMZHRya0xCNXE3V0wvSHZhaG4wNGRyMCtDRUV6bnhIXG5PdGlUdndEMStidDR4amlKTElpN1Z1NFJybHFLbktlSmV3ano3eWRHaHdLQmdRRDJrZkRhMEtWVFRsc0JSNnNoXG5SU1RjL1FoMTc5cVNrMHlaaVJGeU1MN3dvQTM4RmtlMEg5UlRnYXF6Ri80NzlHbDd3anczSmVQRGthTGRCRWRMXG5OR3MrZXZqU3BidGVEWUJlKzRJM1hCbUwwZndlRTJwN0c5UzBTUm0wSFFYMU5BQ292VGxlSUlYWVdta1BIY0RCXG5BWE43aU5vdlNjKzJKUTVyN2RPUHNnQ1RUd0tCZ1FEemlwc05xSjNLcjliY2xZcWtobWVqRjh2ckJhWS9zSm8vXG5BdjYxbytWR3ZGUTRtcm9Dd1VuUW5BU29XMU9LUG9ZK0M0THI0UU5sM2M5L01ZWEJuamRkeXc1aldXSnIzaWtBXG4wNXBxeHp3TzFTMmdGV25teWZjc2ordkN4ZGEyRkMxMGNaaWFaazA0WlpxM2lXdnVkQnVkREltV0FCeklMR1EyXG40eUsvUnhuRlV3S0JnQmh5aS9FR012NDVqS2hwMUx2dHdTUHdLc0NXMFpNcTY3TmxkY2Rlc2UvbHpyMHA4RjRaXG5zZEc5ejVFR1ZmelgxUVdpVXBvZE5hSVVkSk41Y3lBdnlGcGZrd0EvMG40VzFKMldUbWp5eHMyb09sazVENXU1XG5QTFBMYzdMNkZiY2tPdFNBUG9ub3E1eXlDaXluaEk4ZWQ3Yk44T1F6YTFiaUFiWU4xS1l3dmdIZEFvR0FTRDZZXG5xbCtYbDFXOEppbFNQR1lHZmxJRDBzOFZOeFY3WEMvV1FTbkNUTTUzS1dkMHdIWjRJQ0w0R3Iwa3RnREFMODJZXG5ZOEtYRUhQUkpza1pCWXVhbnY4cVlIeFdmdXNqUExTSXZSNG5DYnRoVW5pbnRxZTQ1QVk1aU1qSlhhLzBuL05HXG5zcDZnVDVlTVl0K29IYzlobFovdmZJakNBUHR5S3ZvTUI3UGV5RE1DZ1lBZ1dxZ2d5Y0t5cEZ4VU93TXZ1aFVyXG4rS2lXNTR6MW5PTjRCZzAwVjZRVTNJajVUbFBHUEhVQ0VBNVdwcFgxVVdzK1R3MkNXMktERXc3bXl1TURvUEpWXG5IVkErK3VjYTN1emQrQTlmSDJ2aFRNeVNlNzFKaUszdnlyUzNMb1B5YXhpQWxCZFRIOGNYUlYyMDFDY3NZNC9wXG44WTEwTmtwa25kYjFtRzlKNk9NbEJBPT1cbi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS1cbiIsCiAgImNsaWVudF9lbWFpbCI6ICJwb3J0YW5haHVuZzIwMjZhcHJAZ2VuLWxhbmctY2xpZW50LTA1MzMyOTE1MTMuaWFtLmdzZXJ2aWNlYWNjb3VudC5jb20iLAogICJjbGllbnRfaWQiOiAiMTEyNjkzMjQxMjQ0MDgyODYzNDk4IiwKICAiYXV0aF91cmkiOiAiaHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tL28vb2F1dGgyL2F1dGgiLAogICJ0b2tlbl91cmkiOiAiaHR0cHM6Ly9vYXV0aDIuZ29vZ2xlYXBpcy5jb20vdG9rZW4iLAogICJhdXRoX3Byb3ZpZGVyX3g1MDlfY2VydF91cmwiOiAiaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vb2F1dGgyL3YxL2NlcnRzIiwKICAiY2xpZW50X3g1MDlfY2VydF91cmwiOiAiaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vcm9ib3QvdjEvbWV0YWRhdGEveDUwOS9wb3J0YW5haHVuZzIwMjZhcHIlNDBnZW4tbGFuZy1jbGllbnQtMDUzMzI5MTUxMy5pYW0uZ3NlcnZpY2VhY2NvdW50LmNvbSIsCiAgInVuaXZlcnNlX2RvbWFpbiI6ICJnb29nbGVhcGlzLmNvbSIKfQo='
    const json = Buffer.from(BUNDLED_B64, 'base64').toString('utf8')
    credentials = JSON.parse(json)
    console.log('Google Sheets: using bundled credentials')
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

/**
 * GET /api/env-check
 * Shows whether key env vars are present (never reveals actual values).
 */
app.get('/api/env-check', (_req, res) => {
  const BUILD_VER = 'v5-bundled'
  const email  = process.env.GOOGLE_CLIENT_EMAIL  || ''
  const key    = process.env.GOOGLE_PRIVATE_KEY    || ''
  const token  = process.env.MARKETDATA_TOKEN      || ''
  const b64    = process.env.GOOGLE_SERVICE_ACCOUNT_B64 || ''

  let b64Status = '✗ MISSING'
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8')
      const parsed  = JSON.parse(decoded)
      b64Status = `✓ set & valid JSON (${b64.length} b64 chars, email: ${parsed.client_email})`
    } catch (e) {
      b64Status = `✗ set (${b64.length} b64 chars) but JSON parse failed: ${e.message}`
    }
  }

  res.json({
    GOOGLE_SERVICE_ACCOUNT_B64: b64Status,
    GOOGLE_CLIENT_EMAIL:  email  ? `✓ set (${email.length} chars, starts: ${email.slice(0,12)}…)` : '✗ MISSING',
    GOOGLE_PRIVATE_KEY:   key    ? `✓ set (${key.length} chars, starts: ${key.slice(0,30)}…)` : '✗ MISSING',
    MARKETDATA_TOKEN:     token  ? `✓ set (${token.length} chars)` : '✗ MISSING',
    sheetsClientReady:    !!sheetsClient,
    NODE_ENV:             process.env.NODE_ENV || '(not set)',
    BUILD_VER,
  })
})

// Catch-all: serve index.html for React client-side routing
app.get('*', (_req, res) => {
  res.sendFile(join(process.cwd(), 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`)
  console.log(`Using marketdata.app token: ${MARKETDATA_TOKEN ? '✓ loaded' : '✗ MISSING'}`)
  // Debug: list all env var names available at runtime
  const keys = Object.keys(process.env).sort()
  console.log(`ENV KEYS (${keys.length} total):`, keys.join(', '))
})
