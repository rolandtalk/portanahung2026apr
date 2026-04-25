import React, { useState, useCallback } from 'react'
import { Holding, PortfolioKey } from '../types'
import { calcStats } from '../App'
import { fetchQuotes } from '../services/quotes'

interface Props {
  portfolioKey: PortfolioKey
  holdings: Holding[]
  onUpdateHoldings: (holdings: Holding[]) => void
  onSave: () => void
  lastRefreshed: string
  onRefreshed: (timestamp: string) => void
}

function fmt(n: number, prefix = '$') {
  return `${prefix}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function fmtPrice(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function SortIcon() {
  return <span className="inline-block ml-1 text-[#8b949e] text-[10px] leading-none">⇅</span>
}

type SortKey = 'symbol' | 'priceChgPct' | 'dayChg' | 'mktVal' | 'gl' | 'glPct' | 'none'
type SortDir = 'asc' | 'desc'

export default function PortfolioPage({ portfolioKey, holdings, onUpdateHoldings, onSave, lastRefreshed, onRefreshed }: Props) {
  const [newSymbol, setNewSymbol] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('none')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const handleRefreshAndSave = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const symbols = holdings.map(h => h.symbol)
      const quotes = await fetchQuotes(symbols)
      const updated = holdings.map(h => {
        const q = quotes[h.symbol]
        if (!q || q.error || q.price === null) return h
        return {
          ...h,
          price: q.price,
          dayChange: q.dayChangePct ?? h.dayChange,
        }
      })
      onUpdateHoldings(updated)
      onSave()
      const ts = new Date().toLocaleString('en-US', {
        month: 'short', day: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      })
      onRefreshed(ts)
    } catch (err: any) {
      setRefreshError(err.message || 'Failed to fetch quotes')
    } finally {
      setRefreshing(false)
    }
  }, [holdings, onUpdateHoldings, onSave, onRefreshed])

  const stats = calcStats(holdings)

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedHoldings = [...holdings].sort((a, b) => {
    if (sortKey === 'none') return 0
    let av = 0, bv = 0
    if (sortKey === 'symbol') return sortDir === 'asc'
      ? a.symbol.localeCompare(b.symbol)
      : b.symbol.localeCompare(a.symbol)
    if (sortKey === 'dayChg') {
      const prevA = a.price / (1 + a.dayChange / 100)
      const prevB = b.price / (1 + b.dayChange / 100)
      av = (a.price - prevA) * a.shares
      bv = (b.price - prevB) * b.shares
    }
    if (sortKey === 'priceChgPct') { av = a.dayChange; bv = b.dayChange }
    if (sortKey === 'mktVal') { av = a.shares * a.price; bv = b.shares * b.price }
    if (sortKey === 'gl') { av = a.shares * (a.price - a.cost); bv = b.shares * (b.price - b.cost) }
    if (sortKey === 'glPct') {
      av = a.cost > 0 ? ((a.price - a.cost) / a.cost) * 100 : 0
      bv = b.cost > 0 ? ((b.price - b.cost) / b.cost) * 100 : 0
    }
    return sortDir === 'asc' ? av - bv : bv - av
  })

  const updateField = (symbol: string, field: 'shares' | 'cost', value: number) => {
    onUpdateHoldings(holdings.map(h =>
      h.symbol === symbol ? { ...h, [field]: value } : h
    ))
  }

  const removeHolding = (symbol: string) => {
    onUpdateHoldings(holdings.filter(h => h.symbol !== symbol))
  }

  const addHolding = () => {
    const sym = newSymbol.trim().toUpperCase()
    if (!sym) return
    if (holdings.find(h => h.symbol === sym)) {
      alert(`${sym} already exists in this portfolio.`)
      return
    }
    onUpdateHoldings([...holdings, { symbol: sym, shares: 0, cost: 0, price: 0, dayChange: 0 }])
    setNewSymbol('')
  }

  const dayChangePos = stats.totalDayChange >= 0
  const glPos = stats.totalGainLoss >= 0
  const timeMatch = lastRefreshed.match(/\d+:\d+:\d+ [AP]M/)
  const timeShort = timeMatch
    ? timeMatch[0].replace(/:\d\d ([AP]M)/, ' $1')
    : lastRefreshed

  return (
    <div>
      {/* Portfolio Header */}
      <div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-bold text-white">{portfolioKey} Portfolio</h1>
          <span className={`text-xl font-semibold ${dayChangePos ? 'text-green-400' : 'text-red-400'}`}>
            {dayChangePos ? '+' : '-'}{fmt(stats.totalDayChange)} ({dayChangePos ? '+' : ''}{stats.totalDayChangePct.toFixed(2)}%)
          </span>
        </div>
        <p className="text-xs text-[#8b949e] mt-1">
          Prices shown are close prices from Marketdata.app&nbsp;&nbsp;
          <span className="text-[#6b7280]">(as of {timeShort})</span>
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mt-4 mb-6">
        <div className="md:col-span-7 grid grid-cols-1 gap-4">
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
            <p className="text-xs text-[#8b949e] mb-1 uppercase tracking-wide">Total Market Value</p>
            <p className="text-2xl font-bold text-white whitespace-nowrap">{fmt(stats.totalMarketValue)}</p>
          </div>
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
            <p className="text-xs text-[#8b949e] mb-1 uppercase tracking-wide">Total Cost Basis</p>
            <p className="text-2xl font-bold text-white whitespace-nowrap">{fmt(stats.totalCostBasis)}</p>
          </div>
        </div>
        <div className="md:col-span-5 bg-[#161b22] border border-[#30363d] rounded-lg p-4 min-h-full flex flex-col justify-center">
          <p className="text-xs text-[#8b949e] mb-2 uppercase tracking-wide">Total Gain/Loss</p>
          <p className={`text-3xl md:text-4xl font-bold whitespace-nowrap ${glPos ? 'text-green-400' : 'text-red-400'}`}>
            {glPos ? '+' : '-'}{fmt(stats.totalGainLoss)}
          </p>
          <p className={`text-base mt-1 ${glPos ? 'text-green-400' : 'text-red-400'}`}>
            {glPos ? '+' : ''}{stats.totalGainLossPct.toFixed(2)}%
          </p>
        </div>
      </div>

      {/* Holdings Table */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
        {/* Table Header Bar */}
        <div className="flex items-center justify-between px-2 py-3 border-b border-[#30363d]">
          <h2 className="text-base font-semibold text-white">Holdings</h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newSymbol}
              onChange={e => setNewSymbol(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && addHolding()}
              placeholder="Symbol"
              className="bg-[#0d1117] border border-[#30363d] rounded px-3 py-1.5 text-sm text-white placeholder-[#8b949e] w-28 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={addHolding}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded text-sm font-medium transition-colors"
            >
              + Add
            </button>
            <button
              onClick={handleRefreshAndSave}
              disabled={refreshing}
              className="bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              >
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
              {refreshing ? 'Refreshing…' : 'Refresh & Save'}
            </button>
          </div>
        </div>

        {/* Error banner */}
        {refreshError && (
          <div className="px-4 py-2 bg-red-900/40 border-b border-red-700 text-red-300 text-xs flex items-center justify-between">
            <span>⚠ {refreshError}</span>
            <button onClick={() => setRefreshError(null)} className="ml-4 text-red-400 hover:text-white">✕</button>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs md:text-sm">
            <thead>
              <tr className="border-b border-[#30363d] text-[#8b949e] text-[10px] md:text-xs uppercase tracking-normal">
                <th
                  className="text-left px-1 py-2 cursor-pointer hover:text-white select-none whitespace-nowrap"
                  onClick={() => handleSort('symbol')}
                >
                  Smbl <SortIcon />
                </th>
                <th className="text-right px-1 py-2">Shares</th>
                <th className="text-right px-1 py-2">Cost</th>
                <th className="text-right px-1 py-2">Price</th>
                <th
                  className="text-right px-1 py-2 cursor-pointer hover:text-white select-none whitespace-nowrap"
                  onClick={() => handleSort('dayChg')}
                >
                  Day Chg <SortIcon />
                </th>
                <th
                  className="text-right px-1 py-2 cursor-pointer hover:text-white select-none whitespace-nowrap"
                  onClick={() => handleSort('priceChgPct')}
                >
                  % <SortIcon />
                </th>
                <th
                  className="text-right px-1 py-2 cursor-pointer hover:text-white select-none whitespace-nowrap"
                  onClick={() => handleSort('mktVal')}
                >
                  Mkt Val <SortIcon />
                </th>
                <th
                  className="text-right px-1 py-2 cursor-pointer hover:text-white select-none whitespace-nowrap"
                  onClick={() => handleSort('gl')}
                >
                  G/L <SortIcon />
                </th>
                <th
                  className="text-right px-1 py-2 cursor-pointer hover:text-white select-none whitespace-nowrap"
                  onClick={() => handleSort('glPct')}
                >
                  G/L% <SortIcon />
                </th>
                <th className="text-right px-1 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedHoldings.map((h, i) => {
                const mktVal = h.shares * h.price
                const gl = h.shares * (h.price - h.cost)
                const glPct = h.cost > 0 ? ((h.price - h.cost) / h.cost) * 100 : 0
                const prevPrice = h.price / (1 + h.dayChange / 100)
                const dayChangeDollar = (h.price - prevPrice) * h.shares
                const glPos = gl >= 0
                const dcPos = dayChangeDollar >= 0

                return (
                  <tr
                    key={h.symbol}
                    className={`border-b border-[#21262d] hover:bg-[#1c2128] transition-colors ${
                      i % 2 === 0 ? '' : ''
                    }`}
                  >
                    {/* Symbol */}
                    <td className="px-1 py-2 font-semibold text-white">{h.symbol}</td>

                    {/* Shares - editable */}
                    <td className="px-1 py-2 text-right">
                      <input
                        type="number"
                        value={h.shares || ''}
                        onChange={e => updateField(h.symbol, 'shares', parseFloat(e.target.value) || 0)}
                        className="bg-[#21262d] border border-[#30363d] rounded px-1 py-0.5 text-right text-white w-16 focus:outline-none focus:border-blue-500 text-xs md:text-sm"
                      />
                    </td>

                    {/* Cost - editable */}
                    <td className="px-1 py-2 text-right">
                      <input
                        type="number"
                        value={h.cost || ''}
                        onChange={e => updateField(h.symbol, 'cost', parseFloat(e.target.value) || 0)}
                        className="bg-[#21262d] border border-[#30363d] rounded px-1 py-0.5 text-right text-white w-16 focus:outline-none focus:border-blue-500 text-xs md:text-sm"
                      />
                    </td>

                    {/* Price */}
                    <td className="px-1 py-2 text-right text-white font-medium">{fmtPrice(h.price)}</td>

                    {/* Day Change $ */}
                    <td className={`px-1 py-2 text-right font-medium ${dcPos ? 'text-green-400' : 'text-red-400'}`}>
                      {dcPos ? '+' : '-'}{fmt(dayChangeDollar)}
                    </td>

                    {/* Price Change % */}
                    <td className={`px-1 py-2 text-right font-medium ${dcPos ? 'text-green-400' : 'text-red-400'}`}>
                      {dcPos ? '+' : ''}{h.dayChange.toFixed(2)}%
                    </td>

                    {/* Market Value */}
                    <td className="px-1 py-2 text-right text-white font-medium">
                      {fmt(mktVal)}
                    </td>

                    {/* G/L */}
                    <td className={`px-1 py-2 text-right font-medium ${glPos ? 'text-green-400' : 'text-red-400'}`}>
                      {glPos ? '+' : '-'}{fmt(gl)}
                    </td>

                    {/* G/L % */}
                    <td className={`px-1 py-2 text-right font-medium ${glPos ? 'text-green-400' : 'text-red-400'}`}>
                      {glPos ? '+' : ''}{glPct.toFixed(2)}%
                    </td>

                    {/* Action */}
                    <td className="px-1 py-2 text-right">
                      <button
                        onClick={() => removeHolding(h.symbol)}
                        className="bg-red-700 hover:bg-red-600 text-white w-7 h-7 rounded flex items-center justify-center ml-auto transition-colors"
                        title={`Remove ${h.symbol}`}
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M1 1l12 12M13 1L1 13" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                )
              })}
              {holdings.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-[#8b949e]">
                    No holdings yet. Add a symbol above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
