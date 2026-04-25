const DEFAULT_API_BASE = 'https://portanahung2026apr-production.up.railway.app'

// In local dev, default to Railway so quotes work without local secrets.
// You can override with VITE_API_BASE (e.g. empty string for local proxy).
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || DEFAULT_API_BASE

