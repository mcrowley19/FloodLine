import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Where the real backend lives. The dev server proxies /api/* there so the
  // browser only talks to its own origin and CORS never comes into play.
  const target = env.API_PROXY_TARGET || 'http://localhost:8000'
  const proxy = {
    '/api': { target, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, '') },
  }
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5173, proxy },
    preview: { proxy },
  }
})
