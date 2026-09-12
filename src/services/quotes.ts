export interface QuoteResult {
  symbol: string
  price: number | null
  dayChangePct: number | null
  dayChange: number | null
  error?: boolean
}

export interface QuoteSnapshot {
  quotes: Record<string, QuoteResult>
  retrievedAt: string | null
  source: string | null
  stale: boolean
}

import { API_BASE } from './apiBase'

export async function fetchQuoteSnapshot(symbols: string[]): Promise<QuoteSnapshot> {
  if (symbols.length === 0) {
    return { quotes: {}, retrievedAt: null, source: null, stale: false }
  }
  const query = symbols.join(',')
  const res = await fetch(`${API_BASE}/api/quotes?symbols=${encodeURIComponent(query)}`)
  if (!res.ok) {
    throw new Error(`Quote API error: ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  return {
    quotes: (data.quotes || {}) as Record<string, QuoteResult>,
    retrievedAt: typeof data.retrievedAt === 'string' ? data.retrievedAt : null,
    source: typeof data.source === 'string' ? data.source : null,
    stale: data.stale === true,
  }
}

export async function fetchQuotes(symbols: string[]): Promise<Record<string, QuoteResult>> {
  return (await fetchQuoteSnapshot(symbols)).quotes
}
