import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AssetValueChartData, AvcPeriod } from '../services/growth'

interface Props {
  open: boolean
  data: AssetValueChartData | null
  onClose: () => void
}

interface ChartLine {
  id: 'asset' | 'SPY' | 'QQQ'
  label: string
  color: string
  dash?: string
  values: number[]
}

interface ChartLayout {
  width: number
  height: number
  plot: { left: number; right: number; top: number; bottom: number }
  labelX: number
  axisFontSize: number
  endpointFontSize: number
}

const DESKTOP_LAYOUT: ChartLayout = {
  width: 760,
  height: 340,
  plot: { left: 54, right: 574, top: 22, bottom: 288 },
  labelX: 596,
  axisFontSize: 11,
  endpointFontSize: 12,
}

const MOBILE_LAYOUT: ChartLayout = {
  width: 360,
  height: 300,
  plot: { left: 39, right: 232, top: 18, bottom: 250 },
  labelX: 240,
  axisFontSize: 9,
  endpointFontSize: 9.5,
}

function fmtSignedPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtMoney(value: number) {
  return `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function fmtDate(value: string) {
  const parsed = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function linePath(values: number[], x: (index: number) => number, y: (value: number) => number) {
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(value)}`).join(' ')
}

function placeEndpointLabels(
  lines: ChartLine[],
  y: (value: number) => number,
  layout: ChartLayout
) {
  const minimumGap = layout === MOBILE_LAYOUT ? 19 : 24
  const { plot } = layout
  const placed = lines
    .map(line => ({ id: line.id, desired: y(line.values[line.values.length - 1] ?? 100), y: 0 }))
    .sort((a, b) => a.desired - b.desired)

  placed.forEach((item, index) => {
    item.y = Math.max(plot.top + 7, index === 0 ? item.desired : Math.max(item.desired, placed[index - 1].y + minimumGap))
  })

  if ((placed[placed.length - 1]?.y ?? 0) > plot.bottom - 7) {
    const shift = (placed[placed.length - 1]?.y ?? 0) - (plot.bottom - 7)
    placed.forEach(item => { item.y -= shift })
    for (let index = placed.length - 2; index >= 0; index--) {
      placed[index].y = Math.min(placed[index].y, placed[index + 1].y - minimumGap)
    }
  }

  return Object.fromEntries(placed.map(item => [item.id, item.y])) as Record<ChartLine['id'], number>
}

export default function AssetValueChartModal({ open, data, onClose }: Props) {
  const [period, setPeriod] = useState<AvcPeriod>(20)
  const [excludedSymbols, setExcludedSymbols] = useState<string[]>([])
  const [compactChart, setCompactChart] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
  ))
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const priorFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const layout = compactChart ? MOBILE_LAYOUT : DESKTOP_LAYOUT
  const topSymbolSignature = (data?.topHoldings || []).map(holding => holding.symbol).join('|')
  const exclusionMask = (data?.topHoldings || []).reduce(
    (mask, holding, index) => excludedSymbols.includes(holding.symbol) ? mask | (1 << index) : mask,
    0
  )

  useEffect(() => {
    const currentSymbols = new Set((data?.topHoldings || []).map(holding => holding.symbol))
    setExcludedSymbols(symbols => symbols.filter(symbol => currentSymbols.has(symbol)))
  }, [topSymbolSignature])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)')
    const update = () => setCompactChart(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!open) return

    const dialog = dialogRef.current
    if (!dialog) return
    priorFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!dialog.open) dialog.showModal()
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0)

    const onCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }

    dialog.addEventListener('cancel', onCancel)
    return () => {
      window.clearTimeout(focusTimer)
      dialog.removeEventListener('cancel', onCancel)
      if (dialog.open) dialog.close()
      document.body.style.overflow = oldOverflow
      priorFocusRef.current?.focus()
    }
  }, [open, onClose])

  const chart = data?.charts[String(period)] || null
  const activeIncludedSymbols = (chart?.includedSymbols || []).filter(
    symbol => !excludedSymbols.includes(symbol)
  )
  const unavailableSeries = chart
    ? [
        chart.assetsByExclusion[String(exclusionMask)] ? null : 'Asset Value',
        chart.benchmarks.SPY ? null : '$SPY',
        chart.benchmarks.QQQ ? null : '$QQQ',
      ].filter((label): label is string => Boolean(label))
    : []
  const lines = useMemo<ChartLine[]>(() => {
    if (!chart) return []
    const candidates: Array<ChartLine | null> = [
      chart.assetsByExclusion[String(exclusionMask)]
        ? {
            id: 'asset',
            label: 'Asset Value',
            color: '#58a6ff',
            values: chart.assetsByExclusion[String(exclusionMask)]!,
          }
        : null,
      chart.benchmarks.SPY
        ? { id: 'SPY', label: '$SPY', color: '#3fb950', dash: '9 5', values: chart.benchmarks.SPY }
        : null,
      chart.benchmarks.QQQ
        ? { id: 'QQQ', label: '$QQQ', color: '#d2a8ff', dash: '2 5', values: chart.benchmarks.QQQ }
        : null,
    ]
    return candidates.filter((line): line is ChartLine => Boolean(line && line.values.length === chart.dates.length))
  }, [chart, exclusionMask])

  const chartGeometry = useMemo(() => {
    const allValues = lines.flatMap(line => line.values).filter(Number.isFinite)
    if (allValues.length === 0) return null
    const observedMin = Math.min(100, ...allValues)
    const observedMax = Math.max(100, ...allValues)
    const spread = Math.max(observedMax - observedMin, 2)
    const min = observedMin - spread * 0.12
    const max = observedMax + spread * 0.12
    const y = (value: number) => layout.plot.bottom - ((value - min) / (max - min)) * (layout.plot.bottom - layout.plot.top)
    const x = (index: number) => layout.plot.left + (
      (index / Math.max(1, (chart?.dates.length || 1) - 1)) * (layout.plot.right - layout.plot.left)
    )
    const ticks = Array.from({ length: 5 }, (_, index) => min + ((max - min) * index) / 4)
    const baselineTickIndex = ticks.reduce(
      (closest, tick, index) => Math.abs(tick - 100) < Math.abs(ticks[closest] - 100) ? index : closest,
      0
    )
    ticks[baselineTickIndex] = 100
    ticks.sort((a, b) => b - a)
    return { x, y, ticks, labels: placeEndpointLabels(lines, y, layout) }
  }, [chart?.dates.length, layout, lines])

  if (!open) return null

  const modal = (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden bg-transparent p-0 text-inherit backdrop:bg-black/75"
    >
      <div
        className="flex h-full items-end justify-center p-0 sm:items-center sm:p-4"
        onMouseDown={event => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div className="flex max-h-[calc(100dvh-0.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-[#30363d] bg-[#0d1117] shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-xl">
          <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#30363d] bg-[#161b22] px-4 py-3 sm:px-5">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-white">Asset Value Chart</h2>
            <p id={descriptionId} className="mt-0.5 text-xs text-[#8b949e]">
              Current combined shares compared with $SPY and $QQQ, each rebased to 100%.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close Asset Value Chart"
            className="ml-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#374151] text-xl text-[#c9d1d9] hover:border-[#6b7280] hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            ×
          </button>
          </div>

          <div className="overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-[#8b949e]">Period</legend>
              <div className="inline-flex rounded-lg border border-[#374151] bg-[#161b22] p-0.5">
                {([20, 60] as AvcPeriod[]).map(option => (
                  <label key={option} className="cursor-pointer">
                    <input
                      type="radio"
                      name="avc-period"
                      value={option}
                      checked={period === option}
                      onChange={() => setPeriod(option)}
                      className="peer sr-only"
                    />
                    <span className="flex min-h-10 min-w-14 items-center justify-center rounded-md px-3 text-sm font-semibold text-[#8b949e] peer-checked:bg-blue-600 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400">
                      {option}D
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="text-right text-xs text-[#8b949e]">
              <p>{data?.endpointSource === 'regular-session-quote' ? 'Regular-session endpoint' : 'Completed-close endpoint'}</p>
              <p className="mt-1 font-medium text-[#c9d1d9]">Through {data?.asOf || '—'}</p>
            </div>
          </div>

          {(data?.topHoldings.length || 0) > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-[#8b949e]">Include or exclude the three largest holdings</p>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {data!.topHoldings.map((holding, index) => {
                  const bit = 1 << index
                  const included = (exclusionMask & bit) === 0
                  const available = holding.availablePeriods.includes(period)
                  if (!available) {
                    return (
                      <div
                        key={holding.symbol}
                        aria-label={`${holding.symbol} omitted because there is not enough ${period}-day history`}
                        className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="font-semibold text-white">#{holding.rank} {holding.symbol}</p>
                            <p className="text-[11px] text-[#8b949e]">{fmtMoney(holding.marketValue)}</p>
                          </div>
                          <span className="rounded-full border border-amber-700/60 px-2 py-1 text-[11px] font-medium text-amber-200">
                            Omitted
                          </span>
                        </div>
                        <p className="mt-1.5 text-[11px] text-amber-200">Not enough {period}D history</p>
                      </div>
                    )
                  }
                  return (
                    <fieldset
                      key={holding.symbol}
                      className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2.5"
                    >
                      <legend className="sr-only">{holding.symbol} inclusion</legend>
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="font-semibold text-white">#{holding.rank} {holding.symbol}</p>
                          <p className="text-[11px] text-[#8b949e]">
                            {fmtMoney(holding.marketValue)}
                            {holding.weightPct != null ? ` · ${holding.weightPct.toFixed(1)}%` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <label className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[#c9d1d9] focus-within:ring-2 focus-within:ring-blue-500">
                            <input
                              type="radio"
                              name={`avc-${holding.symbol}`}
                              checked={included}
                              onChange={() => setExcludedSymbols(symbols => (
                                symbols.filter(symbol => symbol !== holding.symbol)
                              ))}
                              className="h-4 w-4 accent-blue-600"
                            />
                            In
                          </label>
                          <label className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[#c9d1d9] focus-within:ring-2 focus-within:ring-blue-500">
                            <input
                              type="radio"
                              name={`avc-${holding.symbol}`}
                              checked={!included}
                              onChange={() => setExcludedSymbols(symbols => (
                                symbols.includes(holding.symbol) ? symbols : [...symbols, holding.symbol]
                              ))}
                              className="h-4 w-4 accent-blue-600"
                            />
                            Out
                          </label>
                        </div>
                      </div>
                    </fieldset>
                  )
                })}
              </div>
            </div>
          )}

          {!chart || chart.dates.length === 0 || !chartGeometry || lines.length === 0 ? (
            <div className="mt-4 rounded-lg border border-amber-700/50 bg-amber-950/20 px-4 py-8 text-center text-sm text-amber-200">
              There is not enough aligned market history for this chart.
            </div>
          ) : (
            <>
              <div className="mt-4 rounded-lg border border-[#30363d] bg-[#161b22]">
                <svg
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  className="h-[300px] w-full sm:h-[360px]"
                  role="img"
                  aria-labelledby={`${titleId}-chart-title ${titleId}-chart-desc`}
                >
                  <title id={`${titleId}-chart-title`}>{period}-session Asset Value, SPY and QQQ comparison</title>
                  <desc id={`${titleId}-chart-desc`}>
                    All available lines begin at 100 percent. Endpoint changes are listed below the chart.
                  </desc>
                  <rect x="0" y="0" width={layout.width} height={layout.height} fill="#161b22" />
                  {chartGeometry.ticks.map(tick => (
                    <g key={tick}>
                      <line
                        x1={layout.plot.left}
                        x2={layout.plot.right}
                        y1={chartGeometry.y(tick)}
                        y2={chartGeometry.y(tick)}
                        stroke={Math.abs(tick - 100) < 0.001 ? '#6e7681' : '#30363d'}
                        strokeWidth={Math.abs(tick - 100) < 0.001 ? 1.5 : 1}
                      />
                      <text x={layout.plot.left - 6} y={chartGeometry.y(tick) + 3} textAnchor="end" fill="#8b949e" fontSize={layout.axisFontSize}>
                        {tick.toFixed(1)}%
                      </text>
                    </g>
                  ))}
                  {[0, Math.floor((chart.dates.length - 1) / 2), chart.dates.length - 1].map(index => (
                    <g key={index}>
                      <line
                        x1={chartGeometry.x(index)}
                        x2={chartGeometry.x(index)}
                        y1={layout.plot.top}
                        y2={layout.plot.bottom}
                        stroke="#21262d"
                      />
                      <text x={chartGeometry.x(index)} y={layout.plot.bottom + 22} textAnchor="middle" fill="#8b949e" fontSize={layout.axisFontSize}>
                        {fmtDate(chart.dates[index])}
                      </text>
                    </g>
                  ))}
                  {lines.map(line => {
                    const endValue = line.values[line.values.length - 1]
                    const endY = chartGeometry.y(endValue)
                    const labelY = chartGeometry.labels[line.id]
                    return (
                      <g key={line.id}>
                        <path
                          d={linePath(line.values, chartGeometry.x, chartGeometry.y)}
                          fill="none"
                          stroke={line.color}
                          strokeWidth={line.id === 'asset' ? 3 : 2.25}
                          strokeDasharray={line.dash}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          vectorEffect="non-scaling-stroke"
                        />
                        <circle cx={layout.plot.right} cy={endY} r={compactChart ? 3 : 4} fill={line.color} />
                        <path
                          d={`M ${layout.plot.right + 4} ${endY} L ${layout.labelX - 5} ${labelY}`}
                          fill="none"
                          stroke={line.color}
                          strokeWidth="1"
                        />
                        <text x={layout.labelX} y={labelY + 3} fill={line.color} fontSize={layout.endpointFontSize} fontWeight="600">
                          {line.id === 'asset' ? 'Assets' : line.label} {fmtSignedPercent(endValue - 100)}
                        </text>
                      </g>
                    )
                  })}
                </svg>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="Chart endpoint summary">
                {lines.map(line => {
                  const change = line.values[line.values.length - 1] - 100
                  return (
                    <div key={line.id} className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2">
                      <div className="flex items-center gap-2 text-xs text-[#8b949e]">
                        <span className="h-0.5 w-5" style={{ backgroundColor: line.color }} aria-hidden="true" />
                        {line.label}
                      </div>
                      <p className={`mt-1 text-lg font-semibold ${change >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {fmtSignedPercent(change)}
                      </p>
                    </div>
                  )
                })}
              </div>
              {unavailableSeries.length > 0 && (
                <p className="mt-2 rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                  Unavailable for this period: {unavailableSeries.join(', ')}.
                </p>
              )}
            </>
          )}

          {chart && (
            <p className="mt-3 text-[11px] leading-relaxed text-[#6b7280]">
              Uses current combined quantities and exact matching trading sessions. {activeIncludedSymbols.length} symbols are included in the displayed Asset Value curve for {period}D
              {excludedSymbols.some(symbol => chart.includedSymbols.includes(symbol)) ? `; ${excludedSymbols.filter(symbol => chart.includedSymbols.includes(symbol)).join(', ')} switched out` : ''}
              {chart.omittedSymbols.length > 0 ? `; ${chart.omittedSymbols.length} without complete history are omitted` : ''}.
              Prices are split-adjusted; dividends and historical trades are not included.
            </p>
          )}
          </div>
        </div>
      </div>
    </dialog>
  )

  return createPortal(modal, document.body)
}
