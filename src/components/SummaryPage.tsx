import React from 'react'
import { Holding, PortfolioKey } from '../types'
import { calcStats } from '../App'

const PORTFOLIO_KEYS: PortfolioKey[] = ['CUB', 'PSC', 'DBS', 'FT']

interface Props {
  portfolios: Record<PortfolioKey, Holding[]>
  onSelectPortfolio: (key: PortfolioKey) => void
  lastRefreshed: string
}

function fmt(n: number, prefix = '$') {
  return `${prefix}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export default function SummaryPage({ portfolios, onSelectPortfolio, lastRefreshed }: Props) {
  const allHoldings = Object.values(portfolios).flat()
  const totalStats = calcStats(allHoldings)

  const glPos = totalStats.totalGainLoss >= 0
  const dcPos = totalStats.totalDayChange >= 0

  return (
    <div>
      <div className="mb-1">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-bold text-white">Summary</h1>
          <span className={`text-xl font-semibold ${dcPos ? 'text-green-400' : 'text-red-400'}`}>
            {dcPos ? '+' : '-'}{fmt(totalStats.totalDayChange)} ({dcPos ? '+' : ''}{totalStats.totalDayChangePct.toFixed(2)}%)
          </span>
        </div>
        <p className="text-xs text-[#8b949e] mt-1">
          All Portfolios Combined&nbsp;&nbsp;
          <span className="text-[#6b7280]">(Last retrieved: {lastRefreshed})</span>
        </p>
      </div>

      {/* Overall Stats */}
      <div className="grid grid-cols-3 gap-4 mt-4 mb-6">
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

      {/* Per-Portfolio Cards */}
      <div className="grid grid-cols-2 gap-4">
        {PORTFOLIO_KEYS.map(key => {
          const stats = calcStats(portfolios[key])
          const pos = stats.totalGainLoss >= 0
          const dcP = stats.totalDayChange >= 0

          return (
            <button
              key={key}
              onClick={() => onSelectPortfolio(key)}
              className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 text-left hover:border-blue-500 hover:bg-[#1c2128] transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-lg font-bold text-white group-hover:text-blue-400 transition-colors">
                  {key} Portfolio
                </span>
                <span className={`text-sm font-medium ${dcP ? 'text-green-400' : 'text-red-400'}`}>
                  {dcP ? '+' : '-'}{fmt(stats.totalDayChange)} ({dcP ? '+' : ''}{stats.totalDayChangePct.toFixed(2)}%)
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-[#8b949e] text-xs mb-0.5">Market Value</p>
                  <p className="text-white font-semibold">{fmt(stats.totalMarketValue)}</p>
                </div>
                <div>
                  <p className="text-[#8b949e] text-xs mb-0.5">Cost Basis</p>
                  <p className="text-white font-semibold">{fmt(stats.totalCostBasis)}</p>
                </div>
                <div>
                  <p className="text-[#8b949e] text-xs mb-0.5">Gain/Loss</p>
                  <p className={`font-semibold ${pos ? 'text-green-400' : 'text-red-400'}`}>
                    {pos ? '+' : '-'}{fmt(stats.totalGainLoss)}
                  </p>
                  <p className={`text-xs ${pos ? 'text-green-400' : 'text-red-400'}`}>
                    {pos ? '+' : ''}{stats.totalGainLossPct.toFixed(2)}%
                  </p>
                </div>
              </div>
              <div className="mt-3 text-xs text-[#8b949e]">
                {portfolios[key].length} holdings
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
