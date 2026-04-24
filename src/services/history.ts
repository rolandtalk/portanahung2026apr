export interface HistoryEntry {
  date: string   // "2026-04-24"
  time: string   // "06:47 AM"
  summary: number
  CUB: number
  PSC: number
  DBS: number
  FT: number
}

const HISTORY_KEY = 'portanahung-history-v1'

export function saveSnapshot(values: Omit<HistoryEntry, 'date' | 'time'>): void {
  const now = new Date()
  const dateStr = now.toLocaleDateString('sv-SE') // "2026-04-24"
  const timeStr = now.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  const entry: HistoryEntry = { date: dateStr, time: timeStr, ...values }
  try {
    const existing: HistoryEntry[] = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    const filtered = existing.filter(e => e.date !== dateStr)
    const updated = [entry, ...filtered].slice(0, 60)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated))
  } catch { /* ignore */ }
}

export function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch { return [] }
}
