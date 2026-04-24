import React, { useState, useCallback } from 'react'
import { Holding, PortfolioKey } from '../types'
import { calcStats } from '../App'
import { loadHistory, HistoryEntry } from '../services/history'

const PORTFOLIO_KEYS: PortfolioKey[] = ['CUB', 'PSC', 'DBS', 'FT']

interface Props {
  portfolios: Record<PortfolioKey, Holding[]>
  onSelectPortfolio: (key: PortfolioKey) => void
  lastRefreshed: string
  onRefresh: () => Promise<void>
}

function fmt(n: number) {
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function fmtSigned(n: number) {
  return `${n >= 0 ? '+' : '-'}${fmt(n)}`
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    >
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  )
}

export default function SummaryPage({ portfolios, onSelectPortfolio, lastRefreshed, onRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory())

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      await onRefresh()
      setHistory(loadHistory())
    } catch (err: any) {
      setRefreshError(err.message || 'Failed to fetch quotes')
    } finally {
      setRefreshing(false)
    }
  }, [onRefresh])

  const allHoldings = Object.values(portfolios).flat()
  const totalStats = calcStats(allHoldings)
  const dcPos = totalStats.totalDayChange >= 0
  const glPos = totalStats.totalGainLoss >= 0

  // Extract just the time part from lastRefreshed for the subtitle
  const timeMatch = lastRefreshed.match(/\d+:\d+:\d+ [AP]M/)
  const timeShort = timeMatch
    ? timeMatch[0].replace(/:\d\d ([AP]M)/, ' $1')
    : lastRefreshed

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 transition-colors"
          >
            <RefreshIcon spinning={refreshing} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-bold text-white">Summary</h1>
          <span className={`text-xl font-semibold ${dcPos ? 'text-green-400' : 'text-red-400'}`}>
            {dcPos ? '+' : '-'}{fmt(totalStats.totalDayChange)} ({dcPos ? '+' : ''}{totalStats.totalDayChangePct.toFixed(2)}%)
          </span>
        </div>
        <p className="text-xs text-[#8b949e] mt-1">
          Prices shown are Close prices from YFinance&nbsp;&nbsp;
          <span className="text-[#6b7280]">(as of {timeShort})</span>
        </p>

        {refreshError && (
          <div className="mt-2 px-3 py-1.5 bg-red-900/40 border border-red-700 rounded text-red-300 text-xs flex items-center justify-between">
            <span>⚠ {refreshError}</span>
            <button onClick={() => setRefreshError(null)} className="ml-4 text-red-400 hover:text-white">✕</button>
          </div>
        )}
      </div>

      {/* ── Overall Stats ── */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
          <p className="text-xs text-[#8b949e] mb-1">Total Market Value</p>
          <p className="text-2xl font-bold text-white">{fmt(totalStats.totalMarketValue)}</p>
        </div>
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
          <p className="text-xs text-[#8b949e] mb-1">Total Cost Basis</p>
          <p className="text-2xl font-bold text-white">{fmt(totalStats.totalCostBasis)}</p>
        </div>
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
          <p className="text-xs text-[#8b949e] mb-1">Total Gain/Loss</p>
          <p className={`text-2xl font-bold ${glPos ? 'text-green-400' : 'text-red-400'}`}>
            {glPos ? '+' : '-'}{fmt(totalStats.totalGainLoss)}
          </p>
          <p className={`text-sm mt-0.5 ${glPos ? 'text-green-400' : 'text-red-400'}`}>
            {glPos ? '+' : ''}{totalStats.totalGainLossPct.toFixed(2)}%
          </p>
        </div>
      </div>

      {/* ── Portfolio Summary Table ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#30363d]">
          <h2 className="text-base font-semibold text-white">Portfolio Summary</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#30363d] text-[#8b949e] text-xs uppercase tracking-wide">
                <th className="text-left px-4 py-3">Portfolio</th>
                <th className="text-right px-4 py-3">Market Value</th>
                <th className="text-right px-4 py-3 whitespace-nowrap">Day Change ($)</th>
                <th className="text-right px-4 py-3 whitespace-nowrap">Day Change (%)</th>
                <th className="text-right px-4 py-3 whitespace-nowrap">Total Gain of Portfolio</th>
              </tr>
            </thead>
            <tbody>
              {PORTFOLIO_KEYS.map((key, i) => {
                const stats = calcStats(portfolios[key])
                const dcP = stats.totalDayChange >= 0
                const glP = stats.totalGainLoss >= 0
                return (
                  <tr
                    key={key}
                    onClick={() => onSelectPortfolio(key)}
                    className={`border-b border-[#21262d] hover:bg-[#1c2128] cursor-pointer transition-colors ${
                      i === PORTFOLIO_KEYS.length - 1 ? 'border-b-0' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-semibold text-blue-400 group-hover:text-blue-300">
                      {key}
                    </td>
                    <td className="px-4 py-3 text-right text-white font-medium">
                      {fmt(stats.totalMarketValue)}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${dcP ? 'text-green-400' : 'text-red-400'}`}>
                      {dcP ? '+' : '-'}{fmt(stats.totalDayChange)}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${dcP ? 'text-green-400' : 'text-red-400'}`}>
                      {dcP ? '+' : ''}{stats.totalDayChangePct.toFixed(2)}%
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${glP ? 'text-green-400' : 'text-red-400'}`}>
                      <div>{glP ? '+' : '-'}{fmt(stats.totalGainLoss)}</div>
                      <div className="text-xs">({glP ? '+' : ''}{stats.totalGainLossPct.toFixed(2)}%)</div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Historical Data ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#30363d]">
          <h2 className="text-base font-semibold text-white">Historical Data (Refresh Snapshots)</h2>
        </div>
        {history.length === 0 ? (
          <p className="px-4 py-6 text-center text-[#8b949e] text-sm">
            No snapshots yet — hit Refresh to record today's values.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#30363d] text-[#8b949e] text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3">Date</th>
                  <th className="text-right px-4 py-3">Summary</th>
                  {PORTFOLIO_KEYS.map(k => (
                    <th key={k} className="text-right px-4 py-3">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((entry, i) => (
                  <tr
                    key={entry.date}
                    className={`border-b border-[#21262d] ${i === history.length - 1 ? 'border-b-0' : ''}`}
                  >
                    <td className="px-4 py-3 text-[#8b949e] whitespace-nowrap">
                      <div>{entry.date}</div>
                      <div className="text-xs text-[#6b7280]">{entry.time}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-white font-medium">{fmt(entry.summary)}</td>
                    {PORTFOLIO_KEYS.map(k => (
                      <td key={k} className="px-4 py-3 text-right text-[#8b949e]">
                        {fmt(entry[k] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  )
}
