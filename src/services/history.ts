export interface HistoryEntry {
  date: string   // "2026-04-24"
  time: string   // "06:47 AM"
  summary: number
  CUB: number
  PSC: number
  DBS: number
  FT: number
}

const API_BASE = import.meta.env.DEV ? '' : 'https://portanahung2026apr-production.up.railway.app'

export async function saveSnapshot(values: Omit<HistoryEntry, 'date' | 'time'>): Promise<void> {
  const now = new Date()
  const dateStr = now.toLocaleDateString('sv-SE') // "2026-04-24"
  const timeStr = now.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  await fetch(`${API_BASE}/api/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateStr, time: timeStr, ...values }),
  })
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const res = await fetch(`${API_BASE}/api/history`)
    if (!res.ok) return []
    const data = await res.json()
    return data.entries || []
  } catch {
    return []
  }
}
