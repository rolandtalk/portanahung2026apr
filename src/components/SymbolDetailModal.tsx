import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchSymbolDetail, SymbolDetailResponse } from '../services/symbolDetail'

interface Props {
  symbol: string | null
  onClose: () => void
}

interface ChartLayout {
  width: number
  height: number
  plot: { left: number; right: number; top: number; bottom: number }
  axisFontSize: number
}

const DESKTOP_LAYOUT: ChartLayout = {
  width: 760,
  height: 350,
  plot: { left: 58, right: 738, top: 20, bottom: 302 },
  axisFontSize: 11,
}

const MOBILE_LAYOUT: ChartLayout = {
  width: 360,
  height: 285,
  plot: { left: 42, right: 347, top: 16, bottom: 245 },
  axisFontSize: 9,
}

function fmtMoney(value: number) {
  return `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function fmtPrice(value: number) {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  })}`
}

function fmtShares(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function fmtDate(value: string, compact = false) {
  if (!compact) return value
  const date = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function fmtPriceSource(source: string | null | undefined) {
  if (source === 'marketdata.app') return 'the Marketdata.app quote'
  if (source === 'yfinance-close-fallback') return 'the YFinance close'
  if (source === 'completed-close') return 'the latest completed close'
  return 'the latest database price'
}

function linePath(values: number[], x: (index: number) => number, y: (value: number) => number) {
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(value)}`).join(' ')
}

function ExternalLinkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 3h7v7M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

function PriceChart({ detail, compact }: { detail: SymbolDetailResponse; compact: boolean }) {
  const layout = compact ? MOBILE_LAYOUT : DESKTOP_LAYOUT
  const gradientId = `symbol-area-${detail.symbol.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const geometry = useMemo(() => {
    const values = [...detail.prices, ...detail.ma3].filter(Number.isFinite)
    if (values.length === 0) return null
    const observedMin = Math.min(...values)
    const observedMax = Math.max(...values)
    const spread = Math.max(observedMax - observedMin, Math.abs(observedMax) * 0.04, 0.1)
    const min = Math.max(0, observedMin - spread * 0.12)
    const max = observedMax + spread * 0.12
    const x = (index: number) => layout.plot.left + (
      (index / Math.max(1, detail.dates.length - 1)) * (layout.plot.right - layout.plot.left)
    )
    const y = (value: number) => layout.plot.bottom - (
      ((value - min) / Math.max(max - min, 0.01)) * (layout.plot.bottom - layout.plot.top)
    )
    const ticks = Array.from({ length: 5 }, (_, index) => max - ((max - min) * index) / 4)
    const rawLabelIndexes = [0, 0.25, 0.5, 0.75, 1].map(portion => (
      Math.round((detail.dates.length - 1) * portion)
    ))
    const labelIndexes = [...new Set(rawLabelIndexes)]
    return { x, y, ticks, labelIndexes }
  }, [detail.dates.length, detail.ma3, detail.prices, layout])

  if (!geometry || detail.dates.length === 0) return null

  const closePath = linePath(detail.prices, geometry.x, geometry.y)
  const ma3Path = linePath(detail.ma3, geometry.x, geometry.y)
  const closeArea = `${closePath} L ${geometry.x(detail.prices.length - 1)} ${layout.plot.bottom} L ${geometry.x(0)} ${layout.plot.bottom} Z`
  const indexByDate = new Map(detail.dates.map((date, index) => [date, index]))

  return (
    <div className="rounded-xl border border-[#25334d] bg-[#101a31] p-2 sm:p-3">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${detail.symbol} close price, three-session moving average, and reversal points`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#22d3ee" stopOpacity="0.22" />
            <stop offset="1" stopColor="#22d3ee" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <rect width={layout.width} height={layout.height} rx="12" fill="#101a31" />
        {geometry.ticks.map((tick, index) => {
          const y = geometry.y(tick)
          return (
            <g key={index}>
              <line x1={layout.plot.left} x2={layout.plot.right} y1={y} y2={y} stroke="#273550" strokeWidth="1" />
              <text
                x={layout.plot.left - 7}
                y={y + 4}
                textAnchor="end"
                fill="#8b949e"
                fontSize={layout.axisFontSize}
              >
                ${tick.toLocaleString('en-US', { maximumFractionDigits: tick < 10 ? 2 : 0 })}
              </text>
            </g>
          )
        })}
        {geometry.labelIndexes.map((index, labelIndex) => {
          const x = geometry.x(index)
          return (
            <g key={index}>
              <line x1={x} x2={x} y1={layout.plot.top} y2={layout.plot.bottom} stroke="#202d46" strokeWidth="1" />
              <text
                x={x}
                y={layout.plot.bottom + 21}
                textAnchor={labelIndex === 0 ? 'start' : labelIndex === geometry.labelIndexes.length - 1 ? 'end' : 'middle'}
                fill="#8b949e"
                fontSize={layout.axisFontSize}
              >
                {fmtDate(detail.dates[index], true)}
              </text>
            </g>
          )
        })}
        <path d={closeArea} fill={`url(#${gradientId})`} />
        <path d={closePath} fill="none" stroke="#22d3ee" strokeWidth={compact ? 2.5 : 3} strokeLinejoin="round" strokeLinecap="round" />
        <path d={ma3Path} fill="none" stroke="#f0a43c" strokeWidth={compact ? 2 : 2.5} strokeDasharray="8 6" strokeLinejoin="round" />
        {detail.reversals.map(reversal => {
          const index = indexByDate.get(reversal.date)
          if (index == null) return null
          const x = geometry.x(index)
          const y = geometry.y(reversal.price)
          const radius = compact ? 5.5 : 7
          return (
            <polygon
              key={`${reversal.date}-${reversal.price}`}
              points={`${x},${y - radius} ${x - radius},${y + radius} ${x + radius},${y + radius}`}
              fill="#f06283"
              stroke="#ff8ca5"
              strokeWidth="1"
            >
              <title>{`${reversal.date}: ${fmtPrice(reversal.price)}`}</title>
            </polygon>
          )
        })}
      </svg>
    </div>
  )
}

export default function SymbolDetailModal({ symbol, onClose }: Props) {
  const [detail, setDetail] = useState<SymbolDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [compact, setCompact] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
  ))
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const priorFocusRef = useRef<HTMLElement | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const titleId = useId()
  const descriptionId = useId()
  const activeDetail = detail?.symbol === symbol ? detail : null

  const load = useCallback((activeSymbol: string) => {
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    const requestId = ++requestIdRef.current
    requestControllerRef.current = controller
    setLoading(true)
    setError(null)
    setDetail(null)
    void fetchSymbolDetail(activeSymbol, controller.signal)
      .then(nextDetail => {
        if (requestId === requestIdRef.current) setDetail(nextDetail)
      })
      .catch(err => {
        if (requestId === requestIdRef.current && err?.name !== 'AbortError') {
          setError(err?.message || 'Failed to load symbol history')
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          requestControllerRef.current = null
          setLoading(false)
        }
      })
  }, [])

  useEffect(() => {
    if (!symbol) return
    load(symbol)
    return () => {
      requestIdRef.current += 1
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
    }
  }, [load, symbol])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)')
    const update = () => setCompact(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!symbol) return
    const dialog = dialogRef.current
    if (!dialog) return
    priorFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!dialog.open) dialog.showModal()
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0)
    const handleCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', handleCancel)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      dialog.removeEventListener('cancel', handleCancel)
      window.removeEventListener('keydown', handleKeyDown)
      if (dialog.open) dialog.close()
      document.body.style.overflow = oldOverflow
      priorFocusRef.current?.focus()
    }
  }, [onClose, symbol])

  if (!symbol) return null

  const lastReversal = activeDetail?.lastReversal || null
  const lowerSymbol = symbol.toLowerCase()
  const cnbcUrl = `https://www.cnbc.com/quotes/${encodeURIComponent(lowerSymbol)}?qsearchterm=${encodeURIComponent(lowerSymbol)}`
  const stockChartsUrl = `https://stockcharts.com/h-sc/ui?s=${encodeURIComponent(symbol)}`
  const price = activeDetail?.currentPrice ?? null
  const breakdown = activeDetail?.portfolioBreakdown ?? null
  const currentPriceSource = fmtPriceSource(activeDetail?.currentPriceSource)

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden bg-transparent p-0 text-inherit backdrop:bg-black/80"
    >
      <div
        className="flex h-full items-end justify-center p-0 sm:items-center sm:p-4"
        onPointerDown={event => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <section className="flex max-h-[100dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-[#31546a] bg-[#111a34] shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-xl">
          <header className="flex shrink-0 items-center justify-between border-b border-[#34637e] bg-[#153f57] px-4 py-3 sm:px-6">
            <div>
              <h2 id={titleId} className="text-2xl font-black tracking-wide text-cyan-400">{symbol}</h2>
              <p id={descriptionId} className="mt-0.5 text-xs text-slate-300">60-session close, MA3 and reversal history</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={`Close ${symbol} details`}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-4xl font-light leading-none text-slate-300 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
            >
              ×
            </button>
          </header>

          <div className="overflow-y-auto px-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
            {loading || (!activeDetail && !error) ? (
              <div
                role="status"
                aria-live="polite"
                aria-busy="true"
                className="flex min-h-[260px] items-center justify-center rounded-xl border border-[#25334d] bg-[#101a31] text-sm text-slate-400"
              >
                Loading {symbol} history…
              </div>
            ) : error ? (
              <div role="alert" className="rounded-xl border border-red-700/60 bg-red-950/30 px-4 py-8 text-center">
                <p className="text-sm text-red-300">{error}</p>
                <button
                  type="button"
                  onClick={() => load(symbol)}
                  className="mt-3 rounded-lg border border-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-900/50"
                >
                  Retry
                </button>
              </div>
            ) : activeDetail && activeDetail.dates.length > 0 ? (
              <>
                <PriceChart detail={activeDetail} compact={compact} />
                <p className="sr-only">
                  {activeDetail.dates.length} completed-session prices are shown.
                  {activeDetail.reversals.length > 0
                    ? ` Reversal points: ${activeDetail.reversals.map(point => `${point.date} at ${fmtPrice(point.price)}`).join('; ')}.`
                    : ' No reversal points were found.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-300" aria-label="Chart legend">
                  <span className="inline-flex items-center gap-2"><span className="h-1 w-8 rounded bg-cyan-400" />Close</span>
                  <span className="inline-flex items-center gap-2"><span className="w-8 border-t-2 border-dashed border-amber-400" />MA3</span>
                  <span className="inline-flex items-center gap-2"><span className="text-lg leading-none text-[#f06283]">▲</span>Reversal</span>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  Completed closes through {activeDetail.asOf || '—'}; Current Price uses {currentPriceSource}
                  {activeDetail.currentPriceAsOf ? ` as of ${activeDetail.currentPriceAsOf}` : ''}.
                </p>
              </>
            ) : (
              <div role="status" className="flex min-h-[220px] items-center justify-center rounded-xl border border-amber-700/50 bg-amber-950/20 px-4 text-center text-sm text-amber-200">
                No price history is available for {symbol} in the Railway database yet.
              </div>
            )}

            <dl className="mt-5 divide-y divide-[#26324b] border-y border-[#26324b] text-sm">
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-slate-400">DG</dt>
                <dd className="font-bold text-white">{activeDetail?.dg ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-slate-400">Last Reversal</dt>
                <dd className="font-bold text-white">{lastReversal ? fmtDate(lastReversal.date) : '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-slate-400">Reversal Price</dt>
                <dd className="font-bold text-white">{lastReversal ? fmtPrice(lastReversal.price) : '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-slate-400">Current Price</dt>
                <dd className="font-bold text-white">{price == null ? '—' : fmtPrice(price)}</dd>
              </div>
            </dl>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <a
                href={cnbcUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-center text-sm font-bold text-white hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                <ExternalLinkIcon /> View on CNBC
              </a>
              <a
                href={stockChartsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-center text-sm font-bold text-white hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                <ExternalLinkIcon /> View on StockCharts
              </a>
            </div>

            <section className="mt-6 overflow-hidden rounded-xl border border-[#303b55] bg-[#101a31]">
              <div className="border-b border-[#303b55] px-4 py-3">
                <h3 className="font-semibold text-white">Portfolio Holdings</h3>
                <p className="mt-0.5 text-xs text-slate-400">Shares and market value at the displayed Current Price</p>
              </div>
              {breakdown ? <div className="overflow-x-auto">
                <table className="w-full min-w-[360px] text-sm">
                  <thead>
                    <tr className="border-b border-[#303b55] text-xs uppercase tracking-wide text-slate-400">
                      <th className="px-4 py-2.5 text-left">Portfolio</th>
                      <th className="px-4 py-2.5 text-right">Shares</th>
                      <th className="px-4 py-2.5 text-right">Market Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.portfolios.map(position => (
                      <tr key={position.portfolio} className="border-b border-[#26324b] last:border-0">
                        <td className="px-4 py-3 font-semibold text-blue-400">{position.portfolio}</td>
                        <td className="px-4 py-3 text-right text-white">{fmtShares(position.shares)}</td>
                        <td className="px-4 py-3 text-right text-white">
                          {position.marketValue == null ? '—' : fmtMoney(position.marketValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[#3a4866] bg-[#172139] font-semibold text-white">
                      <td className="px-4 py-3">Total</td>
                      <td className="px-4 py-3 text-right">{fmtShares(breakdown.totalShares)}</td>
                      <td className="px-4 py-3 text-right">
                        {breakdown.totalMarketValue == null ? '—' : fmtMoney(breakdown.totalMarketValue)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div> : (
                <p role="status" aria-live="polite" className="px-4 py-5 text-center text-sm text-slate-400">
                  {loading ? 'Loading portfolio breakdown…' : 'Portfolio breakdown is unavailable.'}
                </p>
              )}
            </section>
          </div>
        </section>
      </div>
    </dialog>,
    document.body
  )
}
