import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchHoldingsGrowth,
  GROWTH_PERIODS,
  GrowthPeriod,
  HoldingsGrowthRow,
  HoldingsGrowthResponse,
} from '../services/growth'
import AssetValueChartModal from './AssetValueChartModal'
import SymbolDetailModal from './SymbolDetailModal'

type DisplayMode = 'percent' | 'value'
type SortColumn = 'symbol' | 'marketValue' | GrowthPeriod
type SortDirection = 'asc' | 'desc'

interface Props {
  refreshKey: string
}

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

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  return (
    <span aria-hidden="true" className={active ? 'text-blue-400' : 'text-[#484f58]'}>
      {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
    </span>
  )
}

export default function HoldingsAnalysis({ refreshKey }: Props) {
  const [mode, setMode] = useState<DisplayMode>('percent')
  const [sortColumn, setSortColumn] = useState<SortColumn>('marketValue')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [data, setData] = useState<HoldingsGrowthResponse | null>(null)
  const [avcOpen, setAvcOpen] = useState(false)
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
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
  }, [load, refreshKey])

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(direction => direction === 'asc' ? 'desc' : 'asc')
      return
    }

    setSortColumn(column)
    setSortDirection(column === 'symbol' ? 'asc' : 'desc')
  }

  const closeAvc = useCallback(() => setAvcOpen(false), [])
  const closeSymbolDetail = useCallback(() => setSelectedSymbol(null), [])

  const rows = useMemo(
    () => [...(data?.holdings || [])].sort((a, b) => {
      if (sortColumn === 'symbol') {
        const comparison = a.symbol.localeCompare(b.symbol)
        return sortDirection === 'asc' ? comparison : -comparison
      }

      const getValue = (row: HoldingsGrowthRow) => {
        if (sortColumn === 'marketValue') return row.marketValue
        const metric = row.growth[String(sortColumn)]
        return metric ? (mode === 'percent' ? metric.pct : metric.valueChange) : null
      }
      const aValue = getValue(a)
      const bValue = getValue(b)

      // Missing price history always stays at the bottom in either direction.
      if (aValue == null && bValue == null) return a.symbol.localeCompare(b.symbol)
      if (aValue == null) return 1
      if (bValue == null) return -1

      const comparison = aValue - bValue
      return (sortDirection === 'asc' ? comparison : -comparison) || a.symbol.localeCompare(b.symbol)
    }),
    [data, mode, sortColumn, sortDirection]
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
            {data?.asOf ? ` · regular-session prices through ${data.asOf}` : ''}
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
          <button
            type="button"
            onClick={() => setAvcOpen(true)}
            disabled={!data?.avc}
            aria-haspopup="dialog"
            aria-label="Open Asset Value Chart"
            className="min-h-9 rounded-md border border-blue-500/70 bg-blue-950/40 px-3 text-xs font-semibold text-blue-300 transition-colors hover:border-blue-400 hover:bg-blue-900/50 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:border-[#374151] disabled:bg-transparent disabled:text-[#6b7280]"
          >
            AVC
          </button>
        </div>
      </div>

      {loading ? (
        <div className="border-t border-[#21262d] px-4 py-8 text-center text-sm text-[#8b949e]">
          Loading market analysis…
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
                  <th
                    scope="col"
                    aria-sort={sortColumn === 'symbol' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky left-0 z-10 bg-[#161b22] p-0 text-left"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('symbol')}
                      aria-label={`Sort by symbol${sortColumn === 'symbol' ? `, currently ${sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}`}
                      className="flex w-full items-center gap-1 px-3 py-3 text-left hover:text-white"
                    >
                      <span aria-hidden="true">S</span>
                      <SortIcon active={sortColumn === 'symbol'} direction={sortDirection} />
                    </button>
                  </th>
                  <th scope="col" aria-label="Total shares" className="px-2 py-3 text-right">Q</th>
                  <th
                    scope="col"
                    aria-sort={sortColumn === 'marketValue' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="p-0 text-right"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('marketValue')}
                      aria-label={`Sort by market value${sortColumn === 'marketValue' ? `, currently ${sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}`}
                      className="flex w-full items-center justify-end gap-1 px-2 py-3 hover:text-white"
                    >
                      <span aria-hidden="true">Val</span>
                      <SortIcon active={sortColumn === 'marketValue'} direction={sortDirection} />
                    </button>
                  </th>
                  {GROWTH_PERIODS.map(period => (
                    <th
                      key={period}
                      scope="col"
                      aria-sort={sortColumn === period ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className="p-0 text-right"
                    >
                      <button
                        type="button"
                        onClick={() => handleSort(period)}
                        aria-label={`Sort by ${period}-day ${mode === 'percent' ? 'percentage' : 'value'} growth${sortColumn === period ? `, currently ${sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}`}
                        className="flex w-full items-center justify-end gap-1 px-2 py-3 hover:text-white"
                      >
                        <span aria-hidden="true">{period}D</span>
                        <SortIcon active={sortColumn === period} direction={sortDirection} />
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.symbol} className="border-b border-[#21262d] last:border-b-0 hover:bg-[#1c2128]">
                    <td className="sticky left-0 z-10 bg-[#161b22] p-0 font-semibold text-blue-400">
                      <button
                        type="button"
                        onClick={() => setSelectedSymbol(row.symbol)}
                        aria-haspopup="dialog"
                        aria-label={`Open ${row.symbol} price history and portfolio holdings`}
                        className="flex min-h-10 w-full items-center px-3 py-2.5 text-left text-blue-400 transition-colors hover:bg-blue-950/30 hover:text-blue-300 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
                      >
                        {row.symbol}
                      </button>
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
              No historical data for {data.errors.map(item => item.symbol).join(', ')}. Period totals use available symbols.
            </p>
          )}
          {data && (data.quoteErrors?.length || 0) > 0 && (
            <p className="border-t border-[#21262d] px-4 py-2 text-xs text-amber-300">
              No matching regular-session quote for {data.quoteErrors?.map(item => item.symbol).join(', ')}. Same-session completed closes are used when available; otherwise affected Analysis values are excluded.
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
            {(data?.analysisEndpoint?.source || data?.oneDay?.source) === 'regular-session-quote'
              ? 'During trading, every period uses the latest available regular-session price against the close 1, 3, 10, 20 or 60 trading sessions earlier. Outside trading hours, every period uses the latest close against the corresponding earlier close.'
              : 'All periods use completed closes because a newer aligned regular-session quote was unavailable.'}
            {' '}Current combined quantities are applied throughout.
          </p>
        </>
      )}
      <AssetValueChartModal open={avcOpen} data={data?.avc || null} onClose={closeAvc} />
      <SymbolDetailModal symbol={selectedSymbol} onClose={closeSymbolDetail} />
    </div>
  )
}
