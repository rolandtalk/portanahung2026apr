export interface QuoteResult {
  symbol: string
  price: number | null
  dayChangePct: number | null
  dayChange: number | null
  error?: boolean
}

const API_BASE = (import.meta.env.VITE_API_URL as string) || ''

export async function fetchQuotes(symbols: string[]): Promise<Record<string, QuoteResult>> {
  if (symbols.length === 0) return {}
  const query = symbols.join(',')
  const res = await fetch(`${API_BASE}/api/quotes?symbols=${encodeURIComponent(query)}`)
  if (!res.ok) {
    throw new Error(`Quote API error: ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  return data.quotes as Record<string, QuoteResult>
}
