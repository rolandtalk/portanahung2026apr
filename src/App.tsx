import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Holding, PortfolioKey, PortfolioStats } from './types'
import SummaryPage from './components/SummaryPage'
import PortfolioPage from './components/PortfolioPage'
import { loadAllPortfoliosFromSheet, writePortfolioToSheet } from './services/sheets'
import { fetchQuotes } from './services/quotes'
import { saveSnapshot } from './services/history'

const PORTFOLIO_KEYS: PortfolioKey[] = ['CUB', 'PSC', 'DBS', 'FT']

const STORAGE_KEY = 'portanahung-portfolios-v2'

const DEFAULT_PORTFOLIOS: Record<PortfolioKey, Holding[]> = {
  CUB: [
    { symbol: 'HWM',   shares: 690,   cost: 167.48, price: 236.93,  dayChange: -4.36 },
    { symbol: 'GOOG',  shares: 744,   cost: 298.00, price: 335.52,  dayChange:  1.53 },
    { symbol: 'TSLA',  shares: 462,   cost: 410.02, price: 390.67,  dayChange:  1.10 },
    { symbol: 'RKLB',  shares: 930,   cost: 66.80,  price: 90.16,   dayChange:  4.06 },
    { symbol: 'IQ',    shares: 10079, cost: 8.36,   price: 1.265,   dayChange: -4.17 },
    { symbol: 'GLD',   shares: 90,    cost: 428.80, price: 434.63,  dayChange:  1.18 },
    { symbol: 'NVDA',  shares: 190,   cost: 173.27, price: 201.49,  dayChange:  0.81 },
    { symbol: 'BABA',  shares: 80,    cost: 139.80, price: 137.06,  dayChange:  1.24 },
    { symbol: 'MSTR',  shares: 100,   cost: 170.40, price: 179.37,  dayChange:  9.39 },
    { symbol: 'EIS',   shares: 200,   cost: 121.20, price: 127.44,  dayChange:  0.83 },
    { symbol: 'UAE',   shares: 800,   cost: 19.70,  price: 19.40,   dayChange: -0.57 },
    { symbol: 'ABBNY', shares: 200,   cost: 37.08,  price: 97.89,   dayChange:  4.29 },
    { symbol: 'ARKG',  shares: 400,   cost: 29.60,  price: 30.86,   dayChange:  0.49 },
    { symbol: 'QS',    shares: 1100,  cost: 7.16,   price: 7.135,   dayChange:  2.22 },
    { symbol: 'ARKX',  shares: 2450,  cost: 24.33,  price: 33.79,   dayChange:  1.24 },
    { symbol: 'LQD',   shares: 100,   cost: 110.33, price: 109.96,  dayChange:  0.32 },
    { symbol: 'EWZ',   shares: 250,   cost: 25.50,  price: 40.76,   dayChange: -0.07 },
    { symbol: 'TLT',   shares: 50,    cost: 88.56,  price: 86.92,   dayChange:  0.40 },
    { symbol: 'SHY',   shares: 200,   cost: 82.00,  price: 82.52,   dayChange:  0.05 },
    { symbol: 'HYG',   shares: 60,    cost: 78.70,  price: 80.49,   dayChange:  0.15 },
    { symbol: 'ALB',   shares: 5,     cost: 274.91, price: 192.29,  dayChange: -3.09 },
    { symbol: 'PLTR',  shares: 84,    cost: 130.00, price: 150.86,  dayChange:  3.35 },
    { symbol: 'ADSK',  shares: 40,    cost: 240.12, price: 245.97,  dayChange:  0.20 },
    { symbol: 'ABBV',  shares: 60,    cost: 189.06, price: 203.67,  dayChange: -0.71 },
    { symbol: 'ORCL',  shares: 20,    cost: 170.70, price: 187.28,  dayChange:  3.37 },
    { symbol: 'AVGO',  shares: 95,    cost: 309.00, price: 414.78,  dayChange:  3.14 },
    { symbol: 'NET',   shares: 30,    cost: 195.70, price: 206.78,  dayChange: -0.43 },
    { symbol: 'AMZN',  shares: 60,    cost: 252.00, price: 252.87,  dayChange:  1.19 },
    { symbol: 'CRWD',  shares: 20,    cost: 425.90, price: 461.96,  dayChange:  2.75 },
    { symbol: 'MSFT',  shares: 85,    cost: 418.00, price: 431.47,  dayChange:  1.72 },
    { symbol: 'BNTX',  shares: 150,   cost: 104.50, price: 111.01,  dayChange: -0.53 },
    { symbol: 'TWST',  shares: 430,   cost: 54.60,  price: 63.89,   dayChange:  2.04 },
    { symbol: 'UNH',   shares: 35,    cost: 328.40, price: 357.76,  dayChange:  3.40 },
  ],
  PSC: [
    { symbol: 'AAPL', shares: 200,  cost: 150,   price: 172.50, dayChange: -0.52 },
    { symbol: 'MSFT', shares: 100,  cost: 280,   price: 415.30, dayChange: 0.31  },
    { symbol: 'AMZN', shares: 150,  cost: 130,   price: 182.40, dayChange: -0.88 },
    { symbol: 'META', shares: 80,   cost: 220,   price: 486.90, dayChange: -1.20 },
  ],
  DBS: [
    { symbol: 'PLTR', shares: 500,  cost: 18.5,  price: 22.30,  dayChange: 2.10  },
    { symbol: 'AMD',  shares: 300,  cost: 95,    price: 162.40, dayChange: -1.55 },
    { symbol: 'COIN', shares: 60,   cost: 210,   price: 238.70, dayChange: 3.25  },
  ],
  FT: [
    { symbol: 'AAPL',  shares: 1,   cost: 266.02,    price: 272.75,  dayChange:  2.47 },
    { symbol: 'ARKK',  shares: 1,   cost: 46.87,     price: 79.12,   dayChange:  2.25 },
    { symbol: 'ARKX',  shares: 681, cost: 32.00805,  price: 33.82,   dayChange:  1.35 },
    { symbol: 'AVGO',  shares: 34,  cost: 320.34912, price: 416.00,  dayChange:  3.44 },
    { symbol: 'BABA',  shares: 35,  cost: 125.95714, price: 137.31,  dayChange:  1.43 },
    { symbol: 'COIN',  shares: 6,   cost: 209.76667, price: 207.09,  dayChange:  5.69 },
    { symbol: 'EWP',   shares: 30,  cost: 49.20,     price: 56.81,   dayChange:  0.07 },
    { symbol: 'EWU',   shares: 1,   cost: 32.95,     price: 47.21,   dayChange:  0.56 },
    { symbol: 'EWY',   shares: 50,  cost: 147.334,   price: 154.24,  dayChange:  5.08 },
    { symbol: 'FLY',   shares: 290, cost: 38.21141,  price: 41.92,   dayChange: -0.40 },
    { symbol: 'GEV',   shares: 51,  cost: 877.84314, price: 1119.54, dayChange: 12.94 },
    { symbol: 'GOOG',  shares: 58,  cost: 303.90379, price: 335.41,  dayChange:  1.49 },
    { symbol: 'HWM',   shares: 100, cost: 239.9074,  price: 237.17,  dayChange: -4.26 },
    { symbol: 'HYG',   shares: 30,  cost: 77.66,     price: 80.50,   dayChange:  0.16 },
    { symbol: 'INTC',  shares: 120, cost: 65.60042,  price: 66.23,   dayChange: -0.05 },
    { symbol: 'IONQ',  shares: 160, cost: 45.44875,  price: 48.40,   dayChange:  4.58 },
    { symbol: 'JETS',  shares: 10,  cost: 20.60,     price: 26.00,   dayChange: -2.80 },
    { symbol: 'KRE',   shares: 1,   cost: 35.00,     price: 69.74,   dayChange:  0.16 },
    { symbol: 'LEMB',  shares: 1,   cost: 36.00,     price: 42.32,   dayChange:  0.24 },
    { symbol: 'LQD',   shares: 1,   cost: 108.59,    price: 110.00,  dayChange:  0.35 },
    { symbol: 'LRCX',  shares: 149, cost: 227.9445,  price: 262.31,  dayChange:  1.52 },
    { symbol: 'MCHI',  shares: 1,   cost: 41.40,     price: 58.44,   dayChange:  0.48 },
    { symbol: 'MRVL',  shares: 110, cost: 108.04091, price: 155.56,  dayChange:  2.81 },
    { symbol: 'MSTR',  shares: 45,  cost: 169.62222, price: 178.69,  dayChange:  8.98 },
    { symbol: 'MU',    shares: 1,   cost: 420.00,    price: 476.38,  dayChange:  6.01 },
    { symbol: 'NOW',   shares: 195, cost: 87.03716,  price: 85.99,   dayChange: -16.57 },
    { symbol: 'NUGT',  shares: 1,   cost: 230.60,    price: 198.54,  dayChange:  3.86 },
    { symbol: 'NVDA',  shares: 70,  cost: 171.775,   price: 201.48,  dayChange:  0.80 },
    { symbol: 'PAVE',  shares: 1,   cost: 26.37,     price: 55.20,   dayChange: -0.06 },
    { symbol: 'PHO',   shares: 1,   cost: 56.24,     price: 69.81,   dayChange: -0.06 },
    { symbol: 'PLTR',  shares: 56,  cost: 139.74804, price: 151.03,  dayChange:  3.47 },
    { symbol: 'RKLB',  shares: 250, cost: 64.3568,   price: 90.18,   dayChange:  4.08 },
    { symbol: 'SHOP',  shares: 51,  cost: 127.40196, price: 132.22,  dayChange:  0.83 },
    { symbol: 'SNDK',  shares: 1,   cost: 891.00,    price: 937.26,  dayChange:  3.74 },
    { symbol: 'TMV',   shares: 1,   cost: 29.68,     price: 36.83,   dayChange: -1.34 },
    { symbol: 'TNA',   shares: 1,   cost: 31.58,     price: 60.38,   dayChange:  1.84 },
    { symbol: 'TS',    shares: 20,  cost: 54.10,     price: 61.83,   dayChange:  1.78 },
    { symbol: 'TSLA',  shares: 35,  cost: 379.56514, price: 390.40,  dayChange:  1.03 },
    { symbol: 'TWST',  shares: 70,  cost: 60.73571,  price: 63.74,   dayChange:  1.80 },
    { symbol: 'UBER',  shares: 1,   cost: 86.77,     price: 75.81,   dayChange: -1.88 },
    { symbol: 'XLE',   shares: 1,   cost: 56.90,     price: 56.44,   dayChange:  1.01 },
    { symbol: 'XLF',   shares: 1,   cost: 46.72,     price: 52.26,   dayChange: -0.09 },
    { symbol: 'XME',   shares: 1,   cost: 105.66,    price: 120.35,  dayChange:  2.53 },
    { symbol: 'YINN',  shares: 1,   cost: 47.28,     price: 35.86,   dayChange: -0.11 },
  ],
}

function loadPortfolios(): Record<PortfolioKey, Holding[]> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch { /* ignore */ }
  return DEFAULT_PORTFOLIOS
}

function savePortfolios(portfolios: Record<PortfolioKey, Holding[]>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolios))
  } catch { /* ignore */ }
}

export function calcStats(holdings: Holding[]): PortfolioStats {
  let totalMarketValue = 0
  let totalCostBasis = 0
  let totalDayChange = 0

  for (const h of holdings) {
    const mktVal = h.shares * h.price
    const costBasis = h.shares * h.cost
    const prevPrice = h.price / (1 + h.dayChange / 100)
    const dayChangeDollar = (h.price - prevPrice) * h.shares
    totalMarketValue += mktVal
    totalCostBasis += costBasis
    totalDayChange += dayChangeDollar
  }

  const totalGainLoss = totalMarketValue - totalCostBasis
  const totalGainLossPct = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0
  const totalDayChangePct = totalMarketValue > 0
    ? (totalDayChange / (totalMarketValue - totalDayChange)) * 100
    : 0

  return { totalMarketValue, totalCostBasis, totalGainLoss, totalGainLossPct, totalDayChange, totalDayChangePct }
}

type View = 'summary' | PortfolioKey

export default function App() {
  const [portfolios, setPortfolios] = useState<Record<PortfolioKey, Holding[]>>(loadPortfolios)
  const [view, setView] = useState<View>('summary')
  const [sheetLoading, setSheetLoading] = useState(true)
  const [sheetStatus, setSheetStatus] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date().toLocaleString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }))

  const syncFromSheet = useCallback((showStatus = true) => {
    const cached = loadPortfolios()
    return loadAllPortfoliosFromSheet(PORTFOLIO_KEYS).then(sheetData => {
      const merged = { ...cached }
      let updated = 0
      for (const key of PORTFOLIO_KEYS) {
        const sheetHoldings = sheetData[key]
        if (!sheetHoldings || sheetHoldings.length === 0) continue
        const cachedMap: Record<string, Holding> = {}
        for (const h of (cached[key] || [])) cachedMap[h.symbol] = h
        merged[key] = sheetHoldings.map(sh => ({
          ...sh,
          price: cachedMap[sh.symbol]?.price ?? sh.price,
          dayChange: cachedMap[sh.symbol]?.dayChange ?? sh.dayChange,
        }))
        updated++
      }
      if (updated > 0) {
        setPortfolios(merged)
        savePortfolios(merged)
        if (showStatus) setSheetStatus('Synced from Google Sheets')
      } else {
        if (showStatus) setSheetStatus('Using cached data')
      }
      return merged
    })
  }, [])

  // On startup: load from Google Sheets
  useEffect(() => {
    setSheetLoading(true)
    syncFromSheet(true).then(() => {
      setSheetLoading(false)
      setTimeout(() => setSheetStatus(null), 4000)
    }).catch(() => {
      setSheetLoading(false)
      setSheetStatus('Could not reach Google Sheets — using cache')
      setTimeout(() => setSheetStatus(null), 5000)
    })
  }, [])

  // Re-sync from Sheet when window regains focus (cross-device sync)
  useEffect(() => {
    const onFocus = () => {
      syncFromSheet(false).catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [syncFromSheet])

  // Debounce timers per portfolio key for sheet writes
  const sheetWriteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const updateHoldings = useCallback((key: PortfolioKey, holdings: Holding[]) => {
    setPortfolios(prev => {
      const next = { ...prev, [key]: holdings }
      savePortfolios(next)
      // Debounced write to Google Sheet (1.5s after last edit)
      clearTimeout(sheetWriteTimers.current[key])
      sheetWriteTimers.current[key] = setTimeout(() => {
        writePortfolioToSheet(key, holdings).catch(err =>
          console.warn(`Sheet write [${key}] failed:`, err.message)
        )
      }, 1500)
      return next
    })
  }, [])

  const handleSave = useCallback((key: PortfolioKey) => {
    savePortfolios(portfolios)
    writePortfolioToSheet(key, portfolios[key]).catch(err =>
      console.warn(`Sheet write [${key}] failed:`, err.message)
    )
  }, [portfolios])

  const handleRefreshAll = useCallback(async () => {
    const allSymbols = PORTFOLIO_KEYS.flatMap(key => portfolios[key].map(h => h.symbol))
    const uniqueSymbols = [...new Set(allSymbols)]
    const quotes = await fetchQuotes(uniqueSymbols)
    const updated = { ...portfolios }
    for (const key of PORTFOLIO_KEYS) {
      updated[key] = portfolios[key].map(h => {
        const q = quotes[h.symbol]
        if (!q || q.error || q.price === null) return h
        return { ...h, price: q.price, dayChange: q.dayChangePct ?? h.dayChange }
      })
    }
    setPortfolios(updated)
    savePortfolios(updated)
    const ts = new Date().toLocaleString('en-US', {
      month: 'short', day: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    })
    setLastRefreshed(ts)
    await saveSnapshot({
      summary: calcStats(Object.values(updated).flat()).totalMarketValue,
      CUB: calcStats(updated.CUB).totalMarketValue,
      PSC: calcStats(updated.PSC).totalMarketValue,
      DBS: calcStats(updated.DBS).totalMarketValue,
      FT:  calcStats(updated.FT).totalMarketValue,
    })
  }, [portfolios])

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#f0f6fc]">
      {/* Google Sheets status banner */}
      {sheetStatus && (
        <div className={`text-xs text-center py-1.5 px-4 ${sheetLoading ? 'bg-blue-900/40 text-blue-300' : 'bg-green-900/40 text-green-300'}`}>
          {sheetLoading ? '⏳' : '✓'} {sheetStatus}
        </div>
      )}
      <div className="max-w-6xl mx-auto px-4 py-4">
        {/* Top Nav */}
        <div className="flex items-center gap-2 mb-6">
          <button
            onClick={() => setView('summary')}
            className={`flex items-center gap-1 px-4 py-2 rounded text-sm font-medium border transition-colors ${
              view === 'summary'
                ? 'bg-[#1f2937] border-[#374151] text-white'
                : 'bg-transparent border-[#374151] text-[#8b949e] hover:text-white hover:border-[#6b7280]'
            }`}
          >
            ← Summary
          </button>
          {PORTFOLIO_KEYS.map(key => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`px-5 py-2 rounded text-sm font-medium transition-colors ${
                view === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-transparent border border-[#374151] text-[#8b949e] hover:text-white hover:border-[#6b7280]'
              }`}
            >
              {key}
            </button>
          ))}
        </div>

        {/* Page Content */}
        {view === 'summary' ? (
          <SummaryPage
            portfolios={portfolios}
            onSelectPortfolio={(key) => setView(key)}
            lastRefreshed={lastRefreshed}
            onRefresh={handleRefreshAll}
          />
        ) : (
          <PortfolioPage
            portfolioKey={view as PortfolioKey}
            holdings={portfolios[view as PortfolioKey]}
            onUpdateHoldings={(h) => updateHoldings(view as PortfolioKey, h)}
            onSave={() => handleSave(view as PortfolioKey)}
            lastRefreshed={lastRefreshed}
            onRefreshed={setLastRefreshed}
          />
        )}
      </div>
    </div>
  )
}
