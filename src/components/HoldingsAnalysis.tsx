import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchHoldingsGrowth,
  GROWTH_PERIODS,
  GrowthPeriod,
  HoldingsGrowthResponse,
} from '../services/growth'

type DisplayMode = 'percent' | 'value'

function fmtShares(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function fmtMoney(value: number) {
  return `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function fmtSignedMoney(value: number) {
  return `${value >= 0 ? '+' : '-'}${fmtMoney(value)}`
}

function fmtSignedPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function valueColor(value: number | null | undefined) {
  if (value == null) return 'text-[#6b7280]'
  return value >= 0 ? 'text-green-400' : 'text-red-400'
}

export default function HoldingsAnalysis() {
  const [mode, setMode] = useState<DisplayMode>('percent')
  const [data, setData] = useState<HoldingsGrowthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await fetchHoldingsGrowth())
    } catch (err: any) {
      setError(err?.message || 'Failed to load analysis')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const rows = useMemo(
    () => [...(data?.holdings || [])].sort((a, b) => {
      if (a.marketValue == null && b.marketValue == null) return a.symbol.localeCompare(b.symbol)
      if (a.marketValue == null) return 1
      if (b.marketValue == null) return -1
      return b.marketValue - a.marketValue || a.symbol.localeCompare(b.symbol)
    }),
    [data]
  )

  const renderGrowth = (period: GrowthPeriod, row: typeof rows[number]) => {
    const metric = row.growth[String(period)]
    const value = metric ? (mode === 'percent' ? metric.pct : metric.valueChange) : null
    return (
      <td key={period} className={`px-2 py-2.5 text-right font-medium whitespace-nowrap ${valueColor(value)}`}>
        {value == null ? '—' : mode === 'percent' ? fmtSignedPercent(value) : fmtSignedMoney(value)}
      </td>
    )
  }

  return (
    <div id="holdings-analysis" className="border-t border-[#30363d] bg-[#0d1117]/30">
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-white">All Holdings Analysis</h3>
          <p className="mt-0.5 text-xs text-[#8b949e]">
            Shares combined across CUB, PSC, DBS and FT
            {data?.asOf ? ` · close prices through ${data.asOf}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#8b949e]">Growth</span>
          <div
            className="inline-flex rounded-md border border-[#374151] bg-[#0d1117] p-0.5"
            role="group"
            aria-label="Growth display"
          >
            <button
              type="button"
              onClick={() => setMode('percent')}
              aria-pressed={mode === 'percent'}
              aria-label="Show growth as percentages"
              className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
                mode === 'percent' ? 'bg-blue-600 text-white' : 'text-[#8b949e] hover:text-white'
              }`}
            >
              %
            </button>
            <button
              type="button"
              onClick={() => setMode('value')}
              aria-pressed={mode === 'value'}
              aria-label="Show growth as dollar values"
              className={`rounded px-3 py-1 text-xs font-semibold transition-colors ${
                mode === 'value' ? 'bg-blue-600 text-white' : 'text-[#8b949e] hover:text-white'
              }`}
            >
              Val
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="border-t border-[#21262d] px-4 py-8 text-center text-sm text-[#8b949e]">
          Loading close-price analysis…
        </div>
      ) : error ? (
        <div className="border-t border-[#21262d] px-4 py-6 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-3 rounded border border-[#374151] px-3 py-1.5 text-xs font-medium text-white hover:border-[#6b7280]"
          >
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="border-t border-[#21262d] px-4 py-8 text-center text-sm text-[#8b949e]">
          No holdings available.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto border-t border-[#21262d]">
            <table className="min-w-[720px] w-full text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-[#30363d] text-[11px] uppercase tracking-wide text-[#8b949e]">
                  <th scope="col" aria-label="Symbol" className="sticky left-0 z-10 bg-[#161b22] px-3 py-3 text-left">S</th>
                  <th scope="col" aria-label="Total shares" className="px-2 py-3 text-right">Q</th>
                  <th scope="col" aria-label="Market value" className="px-2 py-3 text-right">Val</th>
                  {GROWTH_PERIODS.map(period => (
                    <th key={period} scope="col" className="px-2 py-3 text-right">{period}D</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.symbol} className="border-b border-[#21262d] last:border-b-0 hover:bg-[#1c2128]">
                    <td className="sticky left-0 z-10 bg-[#161b22] px-3 py-2.5 font-semibold text-blue-400">
                      {row.symbol}
                    </td>
                    <td className="px-2 py-2.5 text-right text-white">{fmtShares(row.shares)}</td>
                    <td className="px-2 py-2.5 text-right font-medium text-white whitespace-nowrap">
                      {row.marketValue == null ? '—' : fmtMoney(row.marketValue)}
                    </td>
                    {GROWTH_PERIODS.map(period => renderGrowth(period, row))}
                  </tr>
                ))}
              </tbody>
              {mode === 'value' && data && (
                <tfoot>
                  <tr className="border-t-2 border-[#374151] bg-[#1c2128] font-semibold">
                    <td className="sticky left-0 z-10 bg-[#1c2128] px-3 py-3 text-left text-white">Total</td>
                    <td className="px-2 py-3" />
                    <td className="px-2 py-3 text-right text-white whitespace-nowrap">
                      {fmtMoney(data.aggregate.marketValue)}
                    </td>
                    {GROWTH_PERIODS.map(period => {
                      const value = data.aggregate.growth[String(period)]?.valueChange
                      return (
                        <td key={period} className={`px-2 py-3 text-right whitespace-nowrap ${valueColor(value)}`}>
                          {value == null ? '—' : fmtSignedMoney(value)}
                        </td>
                      )
                    })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {data && data.errors.length > 0 && (
            <p className="border-t border-[#21262d] px-4 py-2 text-xs text-amber-300">
              No price history for {data.errors.map(item => item.symbol).join(', ')}. Totals use available symbols.
            </p>
          )}
          {data && GROWTH_PERIODS.some(period => data.aggregate.growth[String(period)]?.missingSymbols > 0) && (
            <p className="border-t border-[#21262d] px-4 py-2 text-xs text-amber-300">
              Period coverage: {GROWTH_PERIODS.map(period => {
                const metric = data.aggregate.growth[String(period)]
                return `${period}D ${metric.includedSymbols}/${data.holdings.length}`
              }).join(' · ')} symbols. Each total uses matching session dates only.
            </p>
          )}
          <p className="border-t border-[#21262d] px-4 py-2 text-[11px] text-[#6b7280]">
            Growth applies today’s combined share quantities to historical closes; it is not transaction-adjusted portfolio performance.
          </p>
        </>
      )}
    </div>
  )
}
