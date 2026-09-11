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

export function normalizeRegularSessionQuotes(raw) {
  const symbols = Array.isArray(raw?.symbol) ? raw.symbol : []
  const quotes = {}

  for (let index = 0; index < symbols.length; index++) {
    const symbol = String(symbols[index] || '').trim().toUpperCase()
    const priceValue = raw?.last?.[index]
    const changeValue = raw?.change?.[index]
    const updatedValue = raw?.updated?.[index]
    const price = Number(priceValue)
    const change = Number(changeValue)
    const updated = Number(updatedValue)
    if (
      !symbol ||
      priceValue == null ||
      changeValue == null ||
      updatedValue == null ||
      !Number.isFinite(price) ||
      !Number.isFinite(change) ||
      !Number.isFinite(updated)
    ) continue

    const previousClose = price - change
    const rawPct = raw?.changepct?.[index]
    const pct = rawPct != null && Number.isFinite(Number(rawPct))
      ? Number(rawPct) * 100
      : previousClose !== 0
        ? (change / previousClose) * 100
        : null

    quotes[symbol] = {
      symbol,
      price,
      change,
      pct,
      updated,
      sessionDate: easternDateKey(new Date(updated * 1000)),
    }
  }

  return quotes
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

export function applyRegularSessionQuotes(payload, quotes, canonicalSessionDate, quoteRetrievedAt) {
  const baseOneDay = payload.aggregate?.growth?.[1] || payload.aggregate?.growth?.['1']
  const fallback = {
    ...payload,
    oneDay: {
      source: 'completed-closes',
      asOf: payload.asOf,
      baselineDate: payload.baselineDates?.[1] || payload.baselineDates?.['1'] || null,
      includedSymbols: baseOneDay?.includedSymbols ?? 0,
      missingSymbols: baseOneDay?.missingSymbols ?? payload.holdings.length,
    },
    quoteErrors: [],
    quoteRetrievedAt: quoteRetrievedAt || null,
  }

  // If the quote service is behind the candle history, completed candles are
  // more recent and already provide the correct closed-session 1D comparison.
  if (!canonicalSessionDate || (payload.asOf && canonicalSessionDate < payload.asOf)) {
    return fallback
  }

  const quoteErrors = []
  const holdings = payload.holdings.map(holding => {
    const quote = quotes[holding.symbol]
    if (!quote || quote.sessionDate !== canonicalSessionDate || !Number.isFinite(quote.pct)) {
      quoteErrors.push({
        symbol: holding.symbol,
        message: quote
          ? quote.sessionDate !== canonicalSessionDate
            ? `Quote belongs to ${quote.sessionDate}, not ${canonicalSessionDate}`
            : 'Quote change unavailable'
          : 'Regular-session quote unavailable',
      })

      // Outside regular trading hours, the completed candle and quote refer to
      // the same session. Preserve that candle rather than discarding valid
      // close-to-close data just because this symbol's quote is unavailable.
      if (canonicalSessionDate === payload.asOf && holding.asOf === payload.asOf) {
        return holding
      }

      return {
        ...holding,
        asOf: null,
        lastClose: null,
        marketValue: null,
        growth: { ...holding.growth, 1: null },
      }
    }

    const baselineDate = canonicalSessionDate > payload.asOf
      ? payload.asOf
      : holding.growth?.[1]?.baselineDate || payload.baselineDates?.[1] || null
    const baselineClose = quote.price - quote.change
    return {
      ...holding,
      asOf: canonicalSessionDate,
      lastClose: quote.price,
      marketValue: holding.shares * quote.price,
      growth: {
        ...holding.growth,
        1: {
          baselineDate,
          baselineClose,
          pct: quote.pct,
          valueChange: holding.shares * quote.change,
        },
      },
    }
  })

  const valued = holdings.filter(holding => Number.isFinite(holding.marketValue))
  const includedOneDay = holdings.filter(holding => holding.growth?.[1])
  const marketValue = valued.reduce((sum, holding) => sum + holding.marketValue, 0)
  const oneDayCurrentValue = includedOneDay.reduce(
    (sum, holding) => sum + holding.marketValue,
    0
  )
  const oneDayBaselineValue = includedOneDay.reduce(
    (sum, holding) => sum + holding.shares * holding.growth[1].baselineClose,
    0
  )
  const oneDayValueChange = oneDayCurrentValue - oneDayBaselineValue

  return {
    ...payload,
    holdings,
    aggregate: {
      ...payload.aggregate,
      marketValue,
      marketValueIncludedSymbols: valued.length,
      marketValueMissingSymbols: holdings.length - valued.length,
      growth: {
        ...payload.aggregate.growth,
        1: {
          pct: oneDayBaselineValue !== 0
            ? (oneDayValueChange / oneDayBaselineValue) * 100
            : null,
          valueChange: oneDayValueChange,
          includedSymbols: includedOneDay.length,
          missingSymbols: holdings.length - includedOneDay.length,
        },
      },
    },
    oneDay: {
      source: 'regular-session-quote',
      asOf: canonicalSessionDate,
      baselineDate: canonicalSessionDate > payload.asOf
        ? payload.asOf
        : payload.baselineDates?.[1] || null,
      includedSymbols: includedOneDay.length,
      missingSymbols: holdings.length - includedOneDay.length,
    },
    quoteErrors,
    quoteRetrievedAt: quoteRetrievedAt || null,
  }
}
