import { API_BASE } from './apiBase'
import type { PortfolioKey } from '../types'

export interface SymbolReversalPoint {
  date: string
  price: number
}

export interface SymbolDetailResponse {
  symbol: string
  dates: string[]
  prices: number[]
  ma3: number[]
  reversals: SymbolReversalPoint[]
  dg: number | null
  lastReversal: SymbolReversalPoint | null
  asOf: string | null
  currentPrice: number | null
  currentPriceAsOf: string | null
  currentPriceSource: string | null
  portfolioBreakdown: SymbolPortfolioBreakdown
  source: 'railway-postgres'
  retrievedAt: string | null
}

export interface SymbolPortfolioPosition {
  portfolio: PortfolioKey
  shares: number
  marketValue: number | null
}

export interface SymbolPortfolioBreakdown {
  portfolios: SymbolPortfolioPosition[]
  totalShares: number
  totalMarketValue: number | null
}

interface SymbolDetailApiResponse {
  symbol: string
  points: Array<{
    date: string
    close: number
    ma3: number
    reversal: boolean
  }>
  dg: number | null
  lastReversalDate: string | null
  lastReversalPrice: number | null
  asOf: string | null
  currentPrice: number | null
  currentPriceAsOf: string | null
  currentPriceSource: string | null
  portfolioBreakdown: SymbolPortfolioBreakdown
  source: 'railway-postgres'
  retrievedAt: string | null
}

export async function fetchSymbolDetail(
  symbol: string,
  signal?: AbortSignal
): Promise<SymbolDetailResponse> {
  const response = await fetch(
    `${API_BASE}/api/holdings/symbol/${encodeURIComponent(symbol)}`,
    { signal }
  )
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.detail || body?.error || `Symbol history error: ${response.status}`)
  }
  const body = await response.json() as SymbolDetailApiResponse
  const reversals = body.points
    .filter(point => point.reversal)
    .map(point => ({ date: point.date, price: point.close }))
  const lastReversal = body.lastReversalDate != null && body.lastReversalPrice != null
    ? { date: body.lastReversalDate, price: body.lastReversalPrice }
    : null

  return {
    symbol: body.symbol,
    dates: body.points.map(point => point.date),
    prices: body.points.map(point => point.close),
    ma3: body.points.map(point => point.ma3),
    reversals,
    dg: body.dg,
    lastReversal,
    asOf: body.asOf,
    currentPrice: body.currentPrice,
    currentPriceAsOf: body.currentPriceAsOf,
    currentPriceSource: body.currentPriceSource,
    portfolioBreakdown: body.portfolioBreakdown,
    source: body.source,
    retrievedAt: body.retrievedAt,
  }
}
