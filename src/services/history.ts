export interface HistoryEntry {
  date: string   // "2026-04-24"
  time: string   // "06:47 AM"
  summary: number
  CUB: number
  PSC: number
  DBS: number
  FT: number
}

import { API_BASE } from './apiBase'

export async function saveSnapshot(values: Omit<HistoryEntry, 'date' | 'time'>): Promise<void> {
  const now = new Date()
  const dateStr = now.toLocaleDateString('sv-SE') // "2026-04-24"
  const timeStr = now.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  const res = await fetch(`${API_BASE}/api/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: dateStr, time: timeStr, ...values }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`History save failed (${res.status}): ${text}`)
  }
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
