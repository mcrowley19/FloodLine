import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  // maplibre-gl v6 resolves its worker with `new URL(..., import.meta.url)`;
  // pre-bundling would move the module and break that URL in dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
