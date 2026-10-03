import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { preloadDemo } from '../api/queries'
import { useStore } from '../store'
import { fmtDayLabel, fmtUtcShort, parseIso } from '../lib/time'
import { useIsMobile } from '../hooks/useMedia'

const STEP_MS = 1500

/** Floating bottom-centre pill: "▶ Replay Storm Chandra" → expands into a scrubber in demo mode. */
export default function DemoPill() {
  const qc = useQueryClient()
  const mode = useStore((s) => s.mode)
  const timeline = useStore((s) => s.timeline)
  const index = useStore((s) => s.demoIndex)
  const playing = useStore((s) => s.demoPlaying)
  const loading = useStore((s) => s.demoLoading)
  const enterDemo = useStore((s) => s.enterDemo)
  const exitDemo = useStore((s) => s.exitDemo)
  const setDemoIndex = useStore((s) => s.setDemoIndex)
  const stepDemo = useStore((s) => s.stepDemo)
  const setDemoPlaying = useStore((s) => s.setDemoPlaying)
  const setDemoLoading = useStore((s) => s.setDemoLoading)
  const pushToast = useStore((s) => s.pushToast)
  const sheetOpen = useStore((s) => s.sheetOpen)
  const tab = useStore((s) => s.tab)
  const isMobile = useIsMobile()
  const [progress, setProgress] = useState(0)
  const [expanded, setExpanded] = useState(false)

  const start = async () => {
    setDemoLoading(true)
    setProgress(0)
    try {
      const tl = await api.demoTimeline()
      enterDemo(tl)
      await preloadDemo(qc, tl, (done, total) => setProgress(done / total))
    } catch (e) {
      pushToast('error', `Demo unavailable: ${(e as Error).message}`)
      exitDemo()
    } finally {
      setDemoLoading(false)
    }
  }

  // auto-advance
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => stepDemo(1), STEP_MS)
    return () => clearInterval(id)
  }, [playing, stepDemo])

  // keyboard scrubbing
  useEffect(() => {
    if (mode !== 'demo') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return
      if (e.key === 'ArrowRight') stepDemo(1)
      else if (e.key === 'ArrowLeft') stepDemo(-1)
      else if (e.key === ' ') {
        e.preventDefault()
        setDemoPlaying(!playing)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, playing, stepDemo, setDemoPlaying])

  // On desktop the sidebar takes the right 396 px of the map tab, so centre the pill over the remaining map area.
  const bottomStyle = isMobile
    ? { bottom: tab === 'map' ? `calc(${sheetOpen ? '72vh' : '220px'} + 12px)` : 16 }
    : { bottom: 24, left: tab === 'map' ? 'calc((100vw - 396px) / 2)' : '50%' }

  if (mode === 'live') {
    return (
      <div className="pointer-events-none fixed left-1/2 z-30 -translate-x-1/2" style={bottomStyle}>
        <button
          onClick={start}
          disabled={loading}
          className="glass pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium transition hover:bg-white/15 disabled:opacity-60"
        >
          <span className="text-amber-300">▶</span> {loading ? 'Loading replay…' : 'Replay Storm Chandra'}
        </button>
      </div>
    )
  }

  if (!timeline) return null
  const at = parseIso(timeline.steps[index]) ?? 0

  if (isMobile && !expanded) {
    return (
      <div className="pointer-events-none fixed left-1/2 z-30 -translate-x-1/2" style={bottomStyle}>
        <div className="glass pointer-events-auto flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-[12px]">
          <PlayButton playing={playing} onToggle={() => setDemoPlaying(!playing)} />
          <button onClick={() => setExpanded(true)} className="whitespace-nowrap tabular-nums font-medium">
            {fmtUtcShort(at)}
          </button>
          <span className="rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-100">demo</span>
          <button onClick={exitDemo} className="ml-1 text-white/60 hover:text-white" aria-label="Exit demo">
            ×
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pointer-events-none fixed left-1/2 z-30 w-[min(640px,calc(100vw-24px))] -translate-x-1/2" style={bottomStyle}>
      <div className="glass pointer-events-auto rounded-[28px] px-4 pb-3 pt-3">
        <div className="flex items-center gap-3">
          <PlayButton playing={playing} onToggle={() => setDemoPlaying(!playing)} disabled={loading} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold tabular-nums">{fmtUtcShort(at)}</span>
              <span className="truncate text-[11px] text-white/55">{timeline.name}</span>
            </div>
            {loading ? (
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-amber-300 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            ) : (
              <div className="text-[10px] text-white/45">
                step {index + 1}/{timeline.steps.length} · {timeline.step_hours}h · ←/→ to scrub, space to play
              </div>
            )}
          </div>
          {isMobile && (
            <button onClick={() => setExpanded(false)} className="text-[11px] text-white/60 hover:text-white">
              collapse
            </button>
          )}
          <button onClick={exitDemo} className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/15">
            Exit
          </button>
        </div>
        <Scrubber timeline={timeline} index={index} onChange={setDemoIndex} />
      </div>
    </div>
  )
}

function PlayButton({ playing, onToggle, disabled }: { playing: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-label={playing ? 'Pause' : 'Play'}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-[13px] transition hover:bg-white/25 disabled:opacity-50"
    >
      {playing ? '❚❚' : <span className="translate-x-px">▶</span>}
    </button>
  )
}

function Scrubber({ timeline, index, onChange }: { timeline: NonNullable<ReturnType<typeof useStore.getState>['timeline']>; index: number; onChange: (i: number) => void }) {
  const n = timeline.steps.length
  const t0 = parseIso(timeline.steps[0]) ?? 0
  const t1 = parseIso(timeline.steps[n - 1]) ?? t0 + 1
  const pos = (ms: number) => `${(((ms - t0) / (t1 - t0 || 1)) * 100).toFixed(2)}%`

  const ticks = useMemo(
    () =>
      timeline.steps.map((s, i) => {
        const ms = parseIso(s) ?? 0
        return { i, ms, day: new Date(ms).getUTCHours() === 0 }
      }),
    [timeline.steps],
  )
  const landfall = parseIso(timeline.landfall_utc)
  const sats = timeline.satellite_acquisitions.map((a) => parseIso(a.acquisition_utc)).filter((x): x is number => x != null)

  return (
    <div className="relative mt-5 px-2">
      {/* markers above the track: landfall on the top row, satellite acquisitions on the row below */}
      <div className="relative h-8">
        {landfall != null && (
          <div className="absolute top-0 -translate-x-1/2" style={{ left: pos(landfall) }}>
            <div className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-amber-200">landfall</div>
            <div className="mx-auto h-5 w-px bg-amber-300/80" />
          </div>
        )}
        {sats.map((ms, i) => {
          const frac = (ms - t0) / (t1 - t0 || 1)
          const prev = i > 0 ? (sats[i - 1] - t0) / (t1 - t0 || 1) : -1
          const labelled = frac - prev > 0.09 // skip labels that would overlap the previous one
          return (
            <div key={i} className="absolute top-3 -translate-x-1/2" style={{ left: pos(ms) }} title={`EMSR860 acquisition ${fmtUtcShort(ms)}`}>
              <div className={`whitespace-nowrap text-[8px] uppercase tracking-wider text-cyan-200/90 ${labelled ? '' : 'invisible'}`}>satellite</div>
              <div className="mx-auto h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_6px_#7FE3FF]" />
            </div>
          )
        })}
      </div>
      {/* ticks */}
      <div className="pointer-events-none absolute left-2 right-2 top-[38px] h-3">
        {ticks.map((t) => (
          <div key={t.i} className={`absolute -translate-x-1/2 ${t.day ? 'h-3 w-px bg-white/45' : 'h-1.5 w-px bg-white/20'}`} style={{ left: pos(t.ms), top: t.day ? 0 : 3 }} />
        ))}
        {landfall != null && <div className="absolute -translate-x-1/2 h-3 w-[2px] bg-amber-300" style={{ left: pos(landfall) }} />}
      </div>
      <input
        type="range"
        className="scrubber relative z-10"
        min={0}
        max={n - 1}
        step={1}
        value={index}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Demo time"
        aria-valuetext={fmtUtcShort(parseIso(timeline.steps[index]) ?? 0)}
      />
      {/* day labels */}
      <div className="relative h-4">
        {ticks
          .filter((t) => t.day)
          .map((t) => (
            <div key={t.i} className="absolute -translate-x-1/2 whitespace-nowrap text-[9px] text-white/50 tabular-nums" style={{ left: pos(t.ms) }}>
              {fmtDayLabel(t.ms)}
            </div>
          ))}
      </div>
    </div>
  )
}
