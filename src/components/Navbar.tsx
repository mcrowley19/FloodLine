import { useEffect, useState } from 'react'
import { useStore, type Tab, selectDemoAt } from '../store'
import { fmtUtcTime, fmtUtcShort, parseIso } from '../lib/time'

const TABS: { id: Tab; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'lead', label: 'Lead Times' },
  { id: 'data', label: 'Data' },
  { id: 'ask', label: 'Ask' },
]

export default function Navbar() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const mode = useStore((s) => s.mode)
  const demoAt = useStore(selectDemoAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  return (
    <nav className="glass pointer-events-auto fixed left-1/2 top-3 z-30 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full p-1 pl-2 sm:top-4 sm:pl-3">
      <div className="mr-2 flex items-center gap-2 pr-1">
        <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
          <path d="M5 20c3-4 6-4 9 0s6 4 9 0 3-2 4-2" stroke="#4FC3F7" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M5 13c3-4 6-4 9 0s6 4 9 0 3-2 4-2" stroke="#4FC3F7" strokeWidth="3" fill="none" strokeLinecap="round" opacity=".5" />
        </svg>
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">Floodline</span>
      </div>
      <div className="flex items-center gap-0.5" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-2.5 py-1.5 text-[12px] font-medium transition sm:px-3 sm:text-[13px] ${tab === t.id ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ml-1 mr-1 border-l border-white/15 pl-2 sm:ml-2 sm:pl-3">
        {mode === 'demo' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/40 bg-amber-400/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-100" title={demoAt ?? ''}>
            demo
            {demoAt && <span className="hidden font-normal normal-case tracking-normal text-amber-100/80 sm:inline">· {fmtUtcShort(parseIso(demoAt) ?? now)}</span>}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 pr-2 text-[12px] text-white/80">
            <span className="tabular-nums">
              live<span className="hidden sm:inline"> <span className="text-white/50">·</span> {fmtUtcTime(now)}</span>
            </span>
          </span>
        )}
      </div>
    </nav>
  )
}
