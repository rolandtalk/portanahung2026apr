import { API_BASE } from './apiBase'

export const GROWTH_PERIODS = [1, 3, 10, 20, 60] as const
export type GrowthPeriod = typeof GROWTH_PERIODS[number]

export interface GrowthMetric {
  baselineDate: string | null
  baselineClose: number
  pct: number
  valueChange: number
}

export interface HoldingsGrowthRow {
  symbol: string
  shares: number
  asOf: string | null
  lastClose: number | null
  marketValue: number | null
  growth: Record<string, GrowthMetric | null>
  error?: string
}

export interface AggregateGrowthMetric {
  pct: number | null
  valueChange: number
  includedSymbols: number
  missingSymbols: number
}

export interface HoldingsGrowthResponse {
  periods: GrowthPeriod[]
  asOf: string | null
  baselineDates: Record<string, string | null>
  holdings: HoldingsGrowthRow[]
  aggregate: {
    marketValue: number
    marketValueIncludedSymbols: number
    marketValueMissingSymbols: number
    growth: Record<string, AggregateGrowthMetric>
  }
  errors: Array<{ symbol: string; message: string }>
  quoteErrors?: Array<{ symbol: string; message: string }>
  quoteError?: string | null
  quoteRetrievedAt?: string | null
  analysisEndpoint?: {
    source: 'regular-session-quote' | 'completed-closes'
    asOf: string | null
  }
  oneDay?: {
    source: 'regular-session-quote' | 'completed-closes'
    asOf: string | null
    baselineDate: string | null
    includedSymbols: number
    missingSymbols: number
  }
  retrievedAt: string
  cached: boolean
}

export async function fetchHoldingsGrowth(): Promise<HoldingsGrowthResponse> {
  const res = await fetch(`${API_BASE}/api/holdings/growth`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || body?.error || `Growth API error: ${res.status}`)
  }
  return res.json()
}
