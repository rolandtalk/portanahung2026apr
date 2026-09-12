import crypto from 'node:crypto'
import pg from 'pg'

const { Pool } = pg

export const REPLICA_SCHEMA_VERSION = 1
export const REPLICA_PORTFOLIOS = Object.freeze(['CUB', 'PSC', 'DBS', 'FT'])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const BATCH_ID = /^[A-Za-z0-9._:-]{1,160}$/
const SYMBOL = /^[A-Z0-9.^=_:-]{1,32}$/
const MAX_PRICES = 100_000
const MAX_QUOTES = 5_000
const MAX_HOLDINGS = 10_000

function inputError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function normalizeTimestamp(value, field, fallback) {
  const candidate = value ?? fallback
  const date = new Date(candidate)
  if (candidate == null || Number.isNaN(date.getTime())) {
    throw inputError(`${field} must be a valid timestamp`)
  }
  return date.toISOString()
}

function normalizeSessionDate(value, field) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw inputError(`${field} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw inputError(`${field} is not a valid calendar date`)
  }
  return value
}

function normalizeSymbol(value, field) {
  const symbol = String(value || '').trim().toUpperCase()
  if (!SYMBOL.test(symbol)) throw inputError(`${field} is invalid`)
  return symbol
}

function finiteNumber(value, field, { positive = false, optional = false } = {}) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    if (optional) return null
    throw inputError(`${field} must be ${positive ? 'a positive' : 'a finite'} number`)
  }
  const number = Number(value)
  if (!Number.isFinite(number) || (positive && number <= 0)) {
    throw inputError(`${field} must be ${positive ? 'a positive' : 'a finite'} number`)
  }
  return number
}

function normalizeSource(value, field) {
  const source = String(value || '').trim()
  if (!source || source.length > 64) throw inputError(`${field} must be 1-64 characters`)
  return source
}

function normalizeSnapshot(row, field = 'snapshot') {
  const time = String(row?.time || '').trim()
  if (!time || time.length > 64) throw inputError(`${field}.time is invalid`)
  return {
    date: normalizeSessionDate(row?.date, `${field}.date`),
    time,
    summary: finiteNumber(row?.summary, `${field}.summary`),
    CUB: finiteNumber(row?.CUB, `${field}.CUB`),
    PSC: finiteNumber(row?.PSC, `${field}.PSC`),
    DBS: finiteNumber(row?.DBS, `${field}.DBS`),
    FT: finiteNumber(row?.FT, `${field}.FT`),
  }
}

/**
 * Validates and canonicalizes a Mac collector batch before any database write.
 * `close` is the calculation price: split-adjusted and dividend-unadjusted.
 * `adjustedClose` and `rawClose` are retained only as reference values.
 */
export function validateIngestPayload(payload, idempotencyKey) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw inputError('JSON object body required')
  }
  if (payload.schemaVersion !== REPLICA_SCHEMA_VERSION) {
    throw inputError(`schemaVersion must be ${REPLICA_SCHEMA_VERSION}`)
  }
  if (typeof payload.batchId !== 'string' || !BATCH_ID.test(payload.batchId)) {
    throw inputError('batchId is invalid')
  }
  if (idempotencyKey && idempotencyKey !== payload.batchId) {
    throw inputError('Idempotency-Key must match batchId')
  }

  const generatedAt = normalizeTimestamp(payload.generatedAt, 'generatedAt')
  if (!Array.isArray(payload.prices)) throw inputError('prices array required')
  if (!Array.isArray(payload.quotes)) throw inputError('quotes array required')
  if (payload.prices.length > MAX_PRICES) throw inputError(`prices exceeds ${MAX_PRICES} rows`)
  if (payload.quotes.length > MAX_QUOTES) throw inputError(`quotes exceeds ${MAX_QUOTES} rows`)

  // Last duplicate wins, preventing a PostgreSQL ON CONFLICT statement from
  // trying to update the same row twice in one insert.
  const pricesByKey = new Map()
  payload.prices.forEach((row, index) => {
    const prefix = `prices[${index}]`
    const symbol = normalizeSymbol(row?.symbol, `${prefix}.symbol`)
    const sessionDate = normalizeSessionDate(row?.sessionDate, `${prefix}.sessionDate`)
    const close = finiteNumber(row?.close, `${prefix}.close`, { positive: true })
    const adjustedClose = finiteNumber(row?.adjustedClose, `${prefix}.adjustedClose`, {
      positive: true,
      optional: true,
    })
    const rawClose = finiteNumber(row?.rawClose, `${prefix}.rawClose`, {
      positive: true,
      optional: true,
    })
    const source = normalizeSource(row?.source, `${prefix}.source`)
    const fetchedAt = normalizeTimestamp(row?.fetchedAt, `${prefix}.fetchedAt`, generatedAt)
    pricesByKey.set(`${symbol}\u0000${sessionDate}`, {
      symbol,
      sessionDate,
      close,
      adjustedClose,
      rawClose,
      source,
      fetchedAt,
    })
  })

  const quotesBySymbol = new Map()
  payload.quotes.forEach((row, index) => {
    const prefix = `quotes[${index}]`
    const symbol = normalizeSymbol(row?.symbol, `${prefix}.symbol`)
    const sessionDate = normalizeSessionDate(row?.sessionDate, `${prefix}.sessionDate`)
    const price = finiteNumber(row?.price, `${prefix}.price`, { positive: true })
    const previousClose = finiteNumber(row?.previousClose, `${prefix}.previousClose`, {
      positive: true,
      optional: true,
    })
    const suppliedChange = finiteNumber(row?.change, `${prefix}.change`, { optional: true })
    const change = suppliedChange ?? (previousClose == null ? null : price - previousClose)
    const suppliedPct = finiteNumber(row?.changePct, `${prefix}.changePct`, { optional: true })
    const changePct = suppliedPct ?? (
      previousClose == null || previousClose === 0 ? null : (change / previousClose) * 100
    )
    const source = normalizeSource(row?.source, `${prefix}.source`)
    const fetchedAt = normalizeTimestamp(row?.fetchedAt, `${prefix}.fetchedAt`, generatedAt)
    const providerUpdatedAt = row?.providerUpdatedAt != null || row?.updatedAt != null
      ? normalizeTimestamp(
          row.providerUpdatedAt ?? row.updatedAt,
          `${prefix}.providerUpdatedAt`,
          fetchedAt
        )
      : null
    quotesBySymbol.set(symbol, {
      symbol,
      sessionDate,
      price,
      previousClose,
      change,
      changePct,
      providerUpdatedAt,
      fetchedAt,
      source,
    })
  })

  let portfolios = null
  if (payload.portfolios != null) {
    if (typeof payload.portfolios !== 'object' || Array.isArray(payload.portfolios)) {
      throw inputError('portfolios must be an object')
    }
    portfolios = {}
    let holdingCount = 0
    for (const [rawPortfolio, rows] of Object.entries(payload.portfolios)) {
      const portfolio = rawPortfolio.toUpperCase()
      if (!REPLICA_PORTFOLIOS.includes(portfolio)) {
        throw inputError(`Unknown portfolio ${rawPortfolio}`)
      }
      if (!Array.isArray(rows)) throw inputError(`portfolios.${portfolio} must be an array`)
      holdingCount += rows.length
      if (holdingCount > MAX_HOLDINGS) throw inputError(`portfolios exceeds ${MAX_HOLDINGS} rows`)
      portfolios[portfolio] = rows.map((row, index) => ({
        symbol: normalizeSymbol(row?.symbol, `portfolios.${portfolio}[${index}].symbol`),
        shares: finiteNumber(row?.shares, `portfolios.${portfolio}[${index}].shares`),
        cost: finiteNumber(row?.cost, `portfolios.${portfolio}[${index}].cost`),
      }))
    }
  }

  if (pricesByKey.size === 0 && quotesBySymbol.size === 0 && (!portfolios || Object.keys(portfolios).length === 0)) {
    throw inputError('Batch contains no prices, quotes, or portfolios')
  }

  return {
    schemaVersion: REPLICA_SCHEMA_VERSION,
    batchId: payload.batchId,
    generatedAt,
    prices: [...pricesByKey.values()],
    quotes: [...quotesBySymbol.values()],
    portfolios,
  }
}

function safeEqual(left, right) {
  if (!left || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function isAuthorizedIngestRequest(authorization, expectedToken) {
  if (!expectedToken || typeof authorization !== 'string') return false
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return Boolean(match && safeEqual(match[1], expectedToken))
}

function makeValues(rows, columns) {
  const params = []
  const tuples = rows.map(row => {
    const placeholders = columns.map(column => {
      params.push(row[column])
      return `$${params.length}`
    })
    return `(${placeholders.join(',')})`
  })
  return { params, tuples: tuples.join(',') }
}

async function upsertPrices(client, rows, batchId) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500).map(row => ({ ...row, batchId }))
    const columns = [
      'symbol', 'sessionDate', 'close', 'adjustedClose', 'rawClose', 'source', 'fetchedAt', 'batchId',
    ]
    const { params, tuples } = makeValues(chunk, columns)
    await client.query(`
      INSERT INTO market_daily_prices
        (symbol, session_date, close, adjusted_close, raw_close, source, fetched_at, batch_id)
      VALUES ${tuples}
      ON CONFLICT (symbol, session_date) DO UPDATE SET
        close = EXCLUDED.close,
        adjusted_close = EXCLUDED.adjusted_close,
        raw_close = EXCLUDED.raw_close,
        source = EXCLUDED.source,
        fetched_at = EXCLUDED.fetched_at,
        batch_id = EXCLUDED.batch_id
      WHERE market_daily_prices.fetched_at <= EXCLUDED.fetched_at
    `, params)
  }
}

async function upsertQuotes(client, rows, batchId) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500).map(row => ({ ...row, batchId }))
    const columns = [
      'symbol', 'sessionDate', 'price', 'previousClose', 'change', 'changePct',
      'providerUpdatedAt', 'fetchedAt', 'source', 'batchId',
    ]
    const { params, tuples } = makeValues(chunk, columns)
    await client.query(`
      INSERT INTO market_quotes
        (symbol, session_date, price, previous_close, change, change_pct,
         provider_updated_at, fetched_at, source, batch_id)
      VALUES ${tuples}
      ON CONFLICT (symbol) DO UPDATE SET
        session_date = EXCLUDED.session_date,
        price = EXCLUDED.price,
        previous_close = EXCLUDED.previous_close,
        change = EXCLUDED.change,
        change_pct = EXCLUDED.change_pct,
        provider_updated_at = EXCLUDED.provider_updated_at,
        fetched_at = EXCLUDED.fetched_at,
        source = EXCLUDED.source,
        batch_id = EXCLUDED.batch_id
      WHERE market_quotes.fetched_at <= EXCLUDED.fetched_at
    `, params)
  }
}

async function replacePortfolioOnClient(client, portfolio, rows, batchId, generatedAt) {
  await client.query('DELETE FROM market_holdings WHERE portfolio = $1', [portfolio])
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500).map((row, index) => ({
      portfolio,
      positionIndex: offset + index,
      ...row,
      batchId,
      updatedAt: generatedAt,
    }))
    const columns = [
      'portfolio', 'positionIndex', 'symbol', 'shares', 'cost', 'batchId', 'updatedAt',
    ]
    const { params, tuples } = makeValues(chunk, columns)
    await client.query(`
      INSERT INTO market_holdings
        (portfolio, position_index, symbol, shares, cost, batch_id, updated_at)
      VALUES ${tuples}
    `, params)
  }
  await client.query(`
    INSERT INTO market_replica_state (dataset, batch_id, generated_at, row_count, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (dataset) DO UPDATE SET
      batch_id = EXCLUDED.batch_id,
      generated_at = EXCLUDED.generated_at,
      row_count = EXCLUDED.row_count,
      updated_at = NOW()
  `, [`holdings:${portfolio}`, batchId, generatedAt, rows.length])
}

export function createMarketDataReplica({ connectionString, logger = console, pool: suppliedPool } = {}) {
  const configured = Boolean(suppliedPool || connectionString)
  const pool = suppliedPool || (connectionString ? new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  }) : null)
  let initPromise = null

  if (pool?.on) {
    pool.on('error', error => logger.error('Market replica PostgreSQL pool error:', error.message))
  }

  async function init() {
    if (!configured) return false
    if (!initPromise) {
      initPromise = (async () => {
        const client = await pool.connect()
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS market_data_ingest_batches (
              batch_id TEXT PRIMARY KEY,
              schema_version INTEGER NOT NULL,
              generated_at TIMESTAMPTZ NOT NULL,
              price_count INTEGER NOT NULL DEFAULT 0,
              quote_count INTEGER NOT NULL DEFAULT 0,
              portfolio_count INTEGER NOT NULL DEFAULT 0,
              holding_count INTEGER NOT NULL DEFAULT 0,
              received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `)
          await client.query(`
            ALTER TABLE market_data_ingest_batches
              ADD COLUMN IF NOT EXISTS portfolio_count INTEGER NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS holding_count INTEGER NOT NULL DEFAULT 0
          `)
          await client.query(`
            CREATE TABLE IF NOT EXISTS market_daily_prices (
              symbol TEXT NOT NULL,
              session_date DATE NOT NULL,
              close DOUBLE PRECISION NOT NULL CHECK (close > 0),
              adjusted_close DOUBLE PRECISION,
              raw_close DOUBLE PRECISION,
              source TEXT NOT NULL,
              fetched_at TIMESTAMPTZ NOT NULL,
              batch_id TEXT NOT NULL,
              PRIMARY KEY (symbol, session_date)
            )
          `)
          await client.query(`
            ALTER TABLE market_daily_prices
              ADD COLUMN IF NOT EXISTS raw_close DOUBLE PRECISION
          `)
          await client.query(`
            CREATE INDEX IF NOT EXISTS market_daily_prices_date_idx
            ON market_daily_prices (session_date DESC)
          `)
          await client.query(`
            CREATE TABLE IF NOT EXISTS market_quotes (
              symbol TEXT PRIMARY KEY,
              session_date DATE NOT NULL,
              price DOUBLE PRECISION NOT NULL CHECK (price > 0),
              previous_close DOUBLE PRECISION,
              change DOUBLE PRECISION,
              change_pct DOUBLE PRECISION,
              provider_updated_at TIMESTAMPTZ,
              fetched_at TIMESTAMPTZ NOT NULL,
              source TEXT NOT NULL,
              batch_id TEXT NOT NULL
            )
          `)
          await client.query(`
            CREATE TABLE IF NOT EXISTS market_holdings (
              portfolio TEXT NOT NULL,
              position_index INTEGER NOT NULL,
              symbol TEXT NOT NULL,
              shares DOUBLE PRECISION NOT NULL,
              cost DOUBLE PRECISION NOT NULL,
              batch_id TEXT NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL,
              PRIMARY KEY (portfolio, position_index)
            )
          `)
          await client.query(`
            CREATE INDEX IF NOT EXISTS market_holdings_symbol_idx
            ON market_holdings (symbol)
          `)
          await client.query(`
            CREATE TABLE IF NOT EXISTS market_replica_state (
              dataset TEXT PRIMARY KEY,
              batch_id TEXT NOT NULL,
              generated_at TIMESTAMPTZ NOT NULL,
              row_count INTEGER NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `)
          await client.query(`
            CREATE TABLE IF NOT EXISTS portfolio_snapshots (
              snapshot_date DATE PRIMARY KEY,
              snapshot_time TEXT NOT NULL,
              summary DOUBLE PRECISION NOT NULL,
              cub DOUBLE PRECISION NOT NULL,
              psc DOUBLE PRECISION NOT NULL,
              dbs DOUBLE PRECISION NOT NULL,
              ft DOUBLE PRECISION NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `)
          logger.log('Market data replica: PostgreSQL schema ready')
          return true
        } finally {
          client.release()
        }
      })().catch(error => {
        initPromise = null
        throw error
      })
    }
    return initPromise
  }

  async function ingest(rawPayload, { idempotencyKey } = {}) {
    if (!configured) throw Object.assign(new Error('DATABASE_URL not configured'), { statusCode: 503 })
    const payload = validateIngestPayload(rawPayload, idempotencyKey)
    await init()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const portfolioEntries = Object.entries(payload.portfolios || {})
      const holdingCount = portfolioEntries.reduce((sum, [, rows]) => sum + rows.length, 0)
      const inserted = await client.query(`
        INSERT INTO market_data_ingest_batches
          (batch_id, schema_version, generated_at, price_count, quote_count, portfolio_count, holding_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (batch_id) DO NOTHING
        RETURNING batch_id
      `, [
        payload.batchId,
        payload.schemaVersion,
        payload.generatedAt,
        payload.prices.length,
        payload.quotes.length,
        portfolioEntries.length,
        holdingCount,
      ])
      if (inserted.rowCount === 0) {
        await client.query('COMMIT')
        return { duplicate: true, payload }
      }

      await upsertPrices(client, payload.prices, payload.batchId)
      await upsertQuotes(client, payload.quotes, payload.batchId)
      if (payload.prices.length > 0) {
        await client.query(`
          INSERT INTO market_replica_state (dataset, batch_id, generated_at, row_count, updated_at)
          VALUES ('prices', $1, $2, $3, NOW())
          ON CONFLICT (dataset) DO UPDATE SET
            batch_id = EXCLUDED.batch_id,
            generated_at = EXCLUDED.generated_at,
            row_count = EXCLUDED.row_count,
            updated_at = NOW()
        `, [payload.batchId, payload.generatedAt, payload.prices.length])
      }
      if (payload.quotes.length > 0) {
        await client.query(`
          INSERT INTO market_replica_state (dataset, batch_id, generated_at, row_count, updated_at)
          VALUES ('quotes', $1, $2, $3, NOW())
          ON CONFLICT (dataset) DO UPDATE SET
            batch_id = EXCLUDED.batch_id,
            generated_at = EXCLUDED.generated_at,
            row_count = EXCLUDED.row_count,
            updated_at = NOW()
        `, [payload.batchId, payload.generatedAt, payload.quotes.length])
      }
      for (const [portfolio, rows] of portfolioEntries) {
        await replacePortfolioOnClient(
          client,
          portfolio,
          rows,
          payload.batchId,
          payload.generatedAt
        )
      }
      await client.query('COMMIT')
      return { duplicate: false, payload }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function getDatasetState(dataset) {
    if (!configured) return null
    await init()
    const result = await pool.query(`
      SELECT dataset, batch_id, generated_at, row_count, updated_at
      FROM market_replica_state
      WHERE dataset = $1
    `, [dataset])
    const row = result.rows[0]
    return row ? {
      dataset: row.dataset,
      batchId: row.batch_id,
      generatedAt: new Date(row.generated_at).toISOString(),
      rowCount: Number(row.row_count),
      updatedAt: new Date(row.updated_at).toISOString(),
    } : null
  }

  async function getQuotes(symbols) {
    if (!configured) return { ready: false, quotes: {}, missingSymbols: [...symbols], state: null }
    await init()
    const normalized = [...new Set(symbols.map((symbol, index) => normalizeSymbol(symbol, `symbols[${index}]`)))]
    const [state, result] = await Promise.all([
      getDatasetState('quotes'),
      normalized.length > 0
        ? pool.query(`
            SELECT symbol, session_date::text, price, previous_close, change, change_pct,
                   provider_updated_at, fetched_at, source
            FROM market_quotes
            WHERE symbol = ANY($1::text[])
          `, [normalized])
        : { rows: [] },
    ])
    const quotes = Object.fromEntries(result.rows.map(row => [row.symbol, {
      symbol: row.symbol,
      sessionDate: row.session_date,
      price: Number(row.price),
      previousClose: row.previous_close == null ? null : Number(row.previous_close),
      change: row.change == null ? null : Number(row.change),
      pct: row.change_pct == null ? null : Number(row.change_pct),
      providerUpdatedAt: row.provider_updated_at ? new Date(row.provider_updated_at).toISOString() : null,
      fetchedAt: new Date(row.fetched_at).toISOString(),
      source: row.source,
      updated: Math.floor(new Date(row.provider_updated_at || row.fetched_at).getTime() / 1000),
    }]))
    return {
      ready: Boolean(state),
      quotes,
      missingSymbols: normalized.filter(symbol => !quotes[symbol]),
      state,
    }
  }

  async function getDailyCandles(symbols, limit = 62) {
    if (!configured) return { ready: false, histories: new Map(), missingSymbols: [...symbols], state: null }
    await init()
    const normalized = [...new Set(symbols.map((symbol, index) => normalizeSymbol(symbol, `symbols[${index}]`)))]
    const boundedLimit = Math.max(2, Math.min(5000, Number(limit) || 62))
    const [state, result] = await Promise.all([
      getDatasetState('prices'),
      normalized.length > 0
        ? pool.query(`
            WITH ranked AS (
              SELECT symbol, session_date, close, fetched_at,
                     ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY session_date DESC) AS rank
              FROM market_daily_prices
              WHERE symbol = ANY($1::text[])
            )
            SELECT symbol, session_date::text, close, fetched_at
            FROM ranked
            WHERE rank <= $2
            ORDER BY symbol, session_date
          `, [normalized, boundedLimit])
        : { rows: [] },
    ])
    const histories = new Map(normalized.map(symbol => [symbol, []]))
    for (const row of result.rows) {
      histories.get(row.symbol)?.push({
        date: row.session_date,
        close: Number(row.close),
        // Timestamp is only retained for compatibility; all alignment uses the
        // canonical YYYY-MM-DD market session key.
        timestamp: Math.floor(Date.parse(`${row.session_date}T20:00:00.000Z`) / 1000),
      })
    }
    return {
      ready: Boolean(state),
      histories,
      missingSymbols: normalized.filter(symbol => histories.get(symbol)?.length === 0),
      state,
    }
  }

  async function getPortfolios(portfolios = REPLICA_PORTFOLIOS) {
    if (!configured) {
      return { ready: false, portfolios: {}, missingPortfolios: [...portfolios], states: {} }
    }
    await init()
    const normalized = [...new Set(portfolios.map(value => String(value).toUpperCase()))]
    for (const portfolio of normalized) {
      if (!REPLICA_PORTFOLIOS.includes(portfolio)) throw inputError(`Unknown portfolio ${portfolio}`)
    }
    const datasets = normalized.map(portfolio => `holdings:${portfolio}`)
    const [stateResult, holdingResult] = await Promise.all([
      pool.query(`
        SELECT dataset, batch_id, generated_at, row_count, updated_at
        FROM market_replica_state
        WHERE dataset = ANY($1::text[])
      `, [datasets]),
      normalized.length > 0
        ? pool.query(`
            SELECT portfolio, position_index, symbol, shares, cost, updated_at
            FROM market_holdings
            WHERE portfolio = ANY($1::text[])
            ORDER BY portfolio, position_index
          `, [normalized])
        : { rows: [] },
    ])
    const states = Object.fromEntries(stateResult.rows.map(row => [row.dataset.slice('holdings:'.length), {
      dataset: row.dataset,
      batchId: row.batch_id,
      generatedAt: new Date(row.generated_at).toISOString(),
      rowCount: Number(row.row_count),
      updatedAt: new Date(row.updated_at).toISOString(),
    }]))
    const holdings = Object.fromEntries(normalized.map(portfolio => [portfolio, []]))
    for (const row of holdingResult.rows) {
      holdings[row.portfolio]?.push({
        symbol: row.symbol,
        shares: Number(row.shares),
        cost: Number(row.cost),
      })
    }
    const missingPortfolios = normalized.filter(portfolio => !states[portfolio])
    return {
      ready: missingPortfolios.length === 0,
      portfolios: holdings,
      missingPortfolios,
      states,
    }
  }

  async function replacePortfolio(portfolio, rawRows, { batchId, generatedAt = new Date().toISOString() } = {}) {
    if (!configured) return false
    const normalizedPortfolio = String(portfolio).toUpperCase()
    const normalized = validateIngestPayload({
      schemaVersion: REPLICA_SCHEMA_VERSION,
      batchId: batchId || `sheet-write:${crypto.randomUUID()}`,
      generatedAt,
      prices: [],
      quotes: [],
      portfolios: { [normalizedPortfolio]: rawRows },
    })
    await init()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await replacePortfolioOnClient(
        client,
        normalizedPortfolio,
        normalized.portfolios[normalizedPortfolio],
        normalized.batchId,
        normalized.generatedAt
      )
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function getHistory() {
    if (!configured) return { ready: false, entries: [], state: null }
    await init()
    const [state, result] = await Promise.all([
      getDatasetState('history'),
      pool.query(`
        SELECT snapshot_date::text, snapshot_time, summary, cub, psc, dbs, ft
        FROM portfolio_snapshots
        ORDER BY snapshot_date DESC
      `),
    ])
    return {
      ready: Boolean(state),
      state,
      entries: result.rows.map(row => ({
        date: row.snapshot_date,
        time: row.snapshot_time,
        summary: Number(row.summary),
        CUB: Number(row.cub),
        PSC: Number(row.psc),
        DBS: Number(row.dbs),
        FT: Number(row.ft),
      })),
    }
  }

  async function upsertHistory(rawEntry) {
    if (!configured) return false
    const entry = normalizeSnapshot(rawEntry)
    await init()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO portfolio_snapshots
          (snapshot_date, snapshot_time, summary, cub, psc, dbs, ft, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (snapshot_date) DO UPDATE SET
          snapshot_time = EXCLUDED.snapshot_time,
          summary = EXCLUDED.summary,
          cub = EXCLUDED.cub,
          psc = EXCLUDED.psc,
          dbs = EXCLUDED.dbs,
          ft = EXCLUDED.ft,
          updated_at = NOW()
      `, [entry.date, entry.time, entry.summary, entry.CUB, entry.PSC, entry.DBS, entry.FT])
      const count = await client.query('SELECT COUNT(*)::int AS count FROM portfolio_snapshots')
      const now = new Date().toISOString()
      await client.query(`
        INSERT INTO market_replica_state (dataset, batch_id, generated_at, row_count, updated_at)
        VALUES ('history', $1, $2, $3, NOW())
        ON CONFLICT (dataset) DO UPDATE SET
          batch_id = EXCLUDED.batch_id,
          generated_at = EXCLUDED.generated_at,
          row_count = EXCLUDED.row_count,
          updated_at = NOW()
      `, [`history:${crypto.randomUUID()}`, now, Number(count.rows[0].count)])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function replaceHistory(rawEntries) {
    if (!configured) return false
    if (!Array.isArray(rawEntries)) throw inputError('history entries array required')
    const entriesByDate = new Map(
      rawEntries.map((row, index) => {
        const entry = normalizeSnapshot(row, `entries[${index}]`)
        return [entry.date, entry]
      })
    )
    const entries = [...entriesByDate.values()]
    await init()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM portfolio_snapshots')
      for (const entry of entries) {
        await client.query(`
          INSERT INTO portfolio_snapshots
            (snapshot_date, snapshot_time, summary, cub, psc, dbs, ft, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `, [entry.date, entry.time, entry.summary, entry.CUB, entry.PSC, entry.DBS, entry.FT])
      }
      const now = new Date().toISOString()
      await client.query(`
        INSERT INTO market_replica_state (dataset, batch_id, generated_at, row_count, updated_at)
        VALUES ('history', $1, $2, $3, NOW())
        ON CONFLICT (dataset) DO UPDATE SET
          batch_id = EXCLUDED.batch_id,
          generated_at = EXCLUDED.generated_at,
          row_count = EXCLUDED.row_count,
          updated_at = NOW()
      `, [`history-bootstrap:${crypto.randomUUID()}`, now, entries.length])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function clearHistory() {
    if (!configured) return false
    await init()
    const now = new Date().toISOString()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM portfolio_snapshots')
      await client.query(`
        INSERT INTO market_replica_state (dataset, batch_id, generated_at, row_count, updated_at)
        VALUES ('history', $1, $2, 0, NOW())
        ON CONFLICT (dataset) DO UPDATE SET
          batch_id = EXCLUDED.batch_id,
          generated_at = EXCLUDED.generated_at,
          row_count = 0,
          updated_at = NOW()
      `, [`history-clear:${crypto.randomUUID()}`, now])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function status() {
    if (!configured) return { configured: false, ready: false, datasets: {}, counts: {} }
    await init()
    const [statesResult, countsResult, lastBatchResult] = await Promise.all([
      pool.query(`
        SELECT dataset, batch_id, generated_at, row_count, updated_at
        FROM market_replica_state
        ORDER BY dataset
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM market_daily_prices)::int AS prices,
          (SELECT COUNT(*) FROM market_quotes)::int AS quotes,
          (SELECT COUNT(*) FROM market_holdings)::int AS holdings,
          (SELECT COUNT(*) FROM portfolio_snapshots)::int AS history,
          (SELECT MAX(session_date)::text FROM market_daily_prices) AS latest_session
      `),
      pool.query(`
        SELECT batch_id, generated_at, received_at, price_count, quote_count,
               portfolio_count, holding_count
        FROM market_data_ingest_batches
        ORDER BY received_at DESC
        LIMIT 1
      `),
    ])
    const datasets = Object.fromEntries(statesResult.rows.map(row => [row.dataset, {
      batchId: row.batch_id,
      generatedAt: new Date(row.generated_at).toISOString(),
      rowCount: Number(row.row_count),
      updatedAt: new Date(row.updated_at).toISOString(),
    }]))
    const required = ['prices', 'quotes', 'history', ...REPLICA_PORTFOLIOS.map(key => `holdings:${key}`)]
    const lastBatch = lastBatchResult.rows[0]
    return {
      configured: true,
      ready: required.every(dataset => datasets[dataset]),
      missingDatasets: required.filter(dataset => !datasets[dataset]),
      datasets,
      counts: countsResult.rows[0] || {},
      lastBatch: lastBatch ? {
        batchId: lastBatch.batch_id,
        generatedAt: new Date(lastBatch.generated_at).toISOString(),
        receivedAt: new Date(lastBatch.received_at).toISOString(),
        priceCount: Number(lastBatch.price_count),
        quoteCount: Number(lastBatch.quote_count),
        portfolioCount: Number(lastBatch.portfolio_count),
        holdingCount: Number(lastBatch.holding_count),
      } : null,
    }
  }

  return {
    configured,
    init,
    ingest,
    getDatasetState,
    getQuotes,
    getDailyCandles,
    getPortfolios,
    replacePortfolio,
    getHistory,
    upsertHistory,
    replaceHistory,
    clearHistory,
    status,
    close: () => pool?.end?.(),
  }
}
