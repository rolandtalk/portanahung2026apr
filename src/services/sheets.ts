import { Holding, PortfolioKey } from '../types'

const API_BASE = (import.meta.env.VITE_API_URL as string) || ''

export async function loadPortfolioFromSheet(tab: PortfolioKey): Promise<Holding[] | null> {
  try {
    const res = await fetch(`${API_BASE}/api/sheet/${tab}`)
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data.holdings) || data.holdings.length === 0) return null
    // Sheet gives us symbol/shares/cost; price/dayChange start at 0 until Refresh
    return data.holdings.map((h: { symbol: string; shares: number; cost: number }) => ({
      symbol: h.symbol,
      shares: h.shares,
      cost: h.cost,
      price: 0,
      dayChange: 0,
    }))
  } catch {
    return null
  }
}

export async function loadAllPortfoliosFromSheet(
  keys: PortfolioKey[]
): Promise<Partial<Record<PortfolioKey, Holding[]>>> {
  const results = await Promise.allSettled(
    keys.map(k => loadPortfolioFromSheet(k).then(h => ({ key: k, holdings: h })))
  )
  const out: Partial<Record<PortfolioKey, Holding[]>> = {}
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.holdings) {
      out[r.value.key] = r.value.holdings
    }
  }
  return out
}

export async function writePortfolioToSheet(tab: PortfolioKey, holdings: Holding[]): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sheet/${tab}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      holdings: holdings.map(h => ({ symbol: h.symbol, shares: h.shares, cost: h.cost })),
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Sheet write failed: ${res.status}`)
  }
}
