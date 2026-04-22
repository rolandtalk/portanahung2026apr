export interface Holding {
  symbol: string
  shares: number
  cost: number      // average cost per share
  price: number     // current price
  dayChange: number // day change %
}

export type PortfolioKey = 'CUB' | 'PSC' | 'DBS' | 'FT'

export interface Portfolio {
  key: PortfolioKey
  holdings: Holding[]
}

export interface PortfolioStats {
  totalMarketValue: number
  totalCostBasis: number
  totalGainLoss: number
  totalGainLossPct: number
  totalDayChange: number
  totalDayChangePct: number
}
