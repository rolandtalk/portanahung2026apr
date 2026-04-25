import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

// Cloudflare plugin touches host networking; keep it off for normal local dev.
// Use `CLOUDFLARE_VITE_PLUGIN=1 npm run build` (see package.json) for CF builds.
const useCfPlugin = process.env.CLOUDFLARE_VITE_PLUGIN === '1'

export default defineConfig({
  plugins: [react(), ...(useCfPlugin ? [cloudflare()] : [])],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})