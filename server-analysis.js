export const ANALYSIS_PERIODS = Object.freeze([1, 3, 10, 20, 60])

const easternDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const easternTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function formatParts(formatter, date) {
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  )
}

export function easternDateKey(date) {
  const parts = formatParts(easternDateFormatter, date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function easternMinutes(date) {
  const parts = formatParts(easternTimeFormatter, date)
  return Number(parts.hour) * 60 + Number(parts.minute)
}

export function aggregateHoldingsBySymbol(holdingsByPortfolio) {
  const grouped = new Map()

  for (const holdings of Object.values(holdingsByPortfolio)) {
    for (const holding of holdings || []) {
      const symbol = String(holding.symbol || '').trim().toUpperCase()
      const shares = Number(holding.shares)
      if (!symbol || !Number.isFinite(shares)) continue

      const current = grouped.get(symbol) || { symbol, shares: 0 }
      current.shares += shares
      grouped.set(symbol, current)
    }
  }

  return [...grouped.values()]
    .filter(holding => holding.shares !== 0)
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export function normalizeCompletedCandles(raw, now = new Date()) {
  const closes = Array.isArray(raw?.c) ? raw.c : []
  const timestamps = Array.isArray(raw?.t) ? raw.t : []
  const candles = []

  for (let index = 0; index < Math.min(closes.length, timestamps.length); index++) {
    const close = Number(closes[index])
    const timestamp = Number(timestamps[index])
    if (!Number.isFinite(close) || !Number.isFinite(timestamp)) continue
    const date = new Date(timestamp * 1000)
    candles.push({ timestamp, date: easternDateKey(date), close })
  }

  candles.sort((a, b) => a.timestamp - b.timestamp)

  // A daily candle can represent the still-open or 15-minute-delayed session.
  // Analysis is based on completed closes, so omit today's candle until the
  // closing data has had time to settle after 4 PM ET.
  if (easternMinutes(now) < 16 * 60 + 20) {
    const today = easternDateKey(now)
    while (candles.at(-1)?.date === today) candles.pop()
  }

  return candles
}

export function calculateHoldingGrowth(holding, candles, canonicalCandles = candles) {
  const candleByDate = new Map(candles.map(candle => [candle.date, candle]))
  const latestIndex = canonicalCandles.length - 1
  const latestSession = canonicalCandles[latestIndex]
  const latest = latestSession ? candleByDate.get(latestSession.date) : null
  const growth = {}

  for (const period of ANALYSIS_PERIODS) {
    const baselineSession = canonicalCandles[latestIndex - period]
    const baseline = baselineSession ? candleByDate.get(baselineSession.date) : null
    growth[period] = latest && baseline && baseline.close !== 0
      ? {
          baselineDate: baseline.date,
          baselineClose: baseline.close,
          pct: ((latest.close / baseline.close) - 1) * 100,
          valueChange: holding.shares * (latest.close - baseline.close),
        }
      : null
  }

  return {
    ...holding,
    asOf: latest?.date || null,
    lastClose: latest?.close ?? null,
    marketValue: latest ? holding.shares * latest.close : null,
    growth,
  }
}

export function calculateGrowthAggregate(holdings) {
  const holdingsWithValue = holdings.filter(holding => Number.isFinite(holding.marketValue))
  const marketValue = holdingsWithValue.reduce((sum, holding) => sum + holding.marketValue, 0)
  const growth = {}

  for (const period of ANALYSIS_PERIODS) {
    const included = holdings.filter(holding => holding.growth?.[period])
    const currentValue = included.reduce((sum, holding) => sum + holding.marketValue, 0)
    const baselineValue = included.reduce(
      (sum, holding) => sum + holding.shares * holding.growth[period].baselineClose,
      0
    )
    const valueChange = currentValue - baselineValue

    growth[period] = {
      pct: baselineValue !== 0 ? (valueChange / baselineValue) * 100 : null,
      valueChange,
      includedSymbols: included.length,
      missingSymbols: holdings.length - included.length,
    }
  }

  return {
    marketValue,
    marketValueIncludedSymbols: holdingsWithValue.length,
    marketValueMissingSymbols: holdings.length - holdingsWithValue.length,
    growth,
  }
}
