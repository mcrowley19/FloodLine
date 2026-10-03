import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'

// The map app lives at /map; everything else gets the landing page. Each is its
// own chunk so the landing page never downloads MapLibre.
const isApp = /^\/map(\/|$)/.test(window.location.pathname)
const Page = lazy(() => (isApp ? import('./App') : import('./landing/Landing')))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </QueryClientProvider>
  </StrictMode>,
)
