import { useEffect, useRef, useState } from 'react'
import { HATCH, STATUS, SatelliteIcon, type Status } from './ui'

const DAYS = [22, 23, 24, 25, 26, 27, 28, 29, 30]
const LAST = DAYS[DAYS.length - 1]
const STEP_MS = 1300
/** Centre of a day's column on the 9-column ribbon, as a % of its width. */
const at = (day: number) => `${(((day - DAYS[0]) + 0.5) / DAYS.length) * 100}%`
const LANDFALL = 27
const PASSES = [28, 29]

const ribbonFor = (d: number) => (d === 24 ? STATUS.WATCH.bg : d === 25 ? STATUS.PREPARE.bg : d === 26 ? STATUS['FILL NOW'].bg : d >= 27 ? HATCH : 'rgba(255,255,255,.08)')

const ROWS: { day: number; date: string; status: Status | 'OBSERVED'; text: string }[] = [
  { day: 24, date: '24 Jan', status: 'WATCH', text: 'Check sandbag stock and crews.' },
  { day: 25, date: '25 Jan', status: 'PREPARE', text: 'Stage sandbags and pumps. Clear culverts.' },
  { day: 26, date: '26 Jan 09:00', status: 'FILL NOW', text: 'Fill and place sandbags by 19:00.' },
  { day: 27, date: '27 Jan', status: 'OBSERVED', text: 'Flooding observed by Sentinel-1.' },
]

/** Step through 22–30 Jan; Graiguenamanagh's rows unlock as the selected day passes them. */
export default function ChandraReplay() {
  const [day, setDay] = useState(26)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const stop = () => {
    window.clearInterval(timer.current)
    timer.current = undefined
    setPlaying(false)
  }
  const play = () => {
    window.clearInterval(timer.current)
    setDay(DAYS[0])
    setPlaying(true)
    timer.current = window.setInterval(() => setDay((d) => Math.min(d + 1, LAST)), STEP_MS)
  }
  // the replay ends one step after reaching the last day
  useEffect(() => {
    if (!playing || day < LAST) return
    const t = window.setTimeout(stop, STEP_MS)
    return () => window.clearTimeout(t)
  }, [playing, day])
  useEffect(() => () => window.clearInterval(timer.current), [])

  const current = ROWS.reduce((c, r, i) => (r.day <= day ? i : c), -1)

  return (
    <section id="chandra" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Storm Chandra, replayed.</h2>
        <p className="lede">We replay the five days before the storm using only the data that existed each day.</p>

        <div className="glass replay" style={{ marginTop: 48 }}>
          <div>
            <div style={{ position: 'relative', height: 50 }}>
              <div style={{ position: 'absolute', left: at(LANDFALL), bottom: 0, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 12, color: '#fff', whiteSpace: 'nowrap' }}>Landfall</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 4H8a4 4 0 0 0 0 8h7a3 3 0 0 1 0 6H4" />
                </svg>
              </div>
              {PASSES.map((d) => (
                <div key={d} style={{ position: 'absolute', left: at(d), bottom: 2, transform: 'translateX(-50%)' }}>
                  <SatelliteIcon size={18} stroke="#7FE3FF" label={`Sentinel-1 pass, ${d} January`} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: `repeat(${DAYS.length}, minmax(0, 1fr))`, gap: 3 }} aria-hidden="true">
              {DAYS.map((d) => (
                <div key={d} style={{ height: 12, borderRadius: 3, background: ribbonFor(d), opacity: d <= day ? 1 : 0.25, transition: 'opacity .8s' }} />
              ))}
            </div>
            <div role="group" aria-label="Replay day" style={{ position: 'relative', marginTop: 8, display: 'grid', gridTemplateColumns: `repeat(${DAYS.length}, minmax(0, 1fr))`, gap: 3 }}>
              <div aria-hidden="true" style={{ position: 'absolute', left: at(LANDFALL), top: -72, height: 72, width: 1, background: 'linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,.55) 40%, rgba(255,255,255,.25))', pointerEvents: 'none' }} />
              {DAYS.map((d) => {
                const sel = d === day
                return (
                  <button
                    key={d}
                    type="button"
                    className="day-btn mono"
                    aria-pressed={sel}
                    aria-label={`${d} January 2026`}
                    onClick={() => {
                      stop()
                      setDay(d)
                    }}
                    style={{ minHeight: 48, padding: 0, borderRadius: 10, border: `1px solid ${sel ? '#7FE3FF' : 'rgba(255,255,255,.12)'}`, background: sel ? 'rgba(79,195,247,.22)' : 'rgba(255,255,255,.03)', color: sel ? '#fff' : 'rgba(207,234,248,.75)', fontSize: 13, cursor: 'pointer', transition: 'background .6s, border-color .6s' }}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
            <div className="mono" style={{ marginTop: 8, fontSize: 11, color: 'rgba(207,234,248,.6)' }}>January 2026</div>

            <div style={{ marginTop: 28, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
              <button type="button" onClick={play} className="btn btn-glass" style={{ minHeight: 46, padding: '0 20px', font: "500 15px 'Inter', system-ui, sans-serif" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8Z" /></svg>
                {playing ? 'Replaying…' : 'Replay 22–30 Jan'}
              </button>
              <span style={{ fontSize: 13, color: 'rgba(207,234,248,.75)' }} aria-live="polite">
                Data up to <span className="mono" style={{ color: '#7FE3FF' }}>{day === 26 ? '26 Jan 09:00' : `${day} Jan`}</span>
              </span>
            </div>
          </div>

          <div className="replay-town">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <h3 className="hd" style={{ margin: 0, fontSize: 30, fontWeight: 700, color: '#fff' }}>Graiguenamanagh</h3>
              <span style={{ fontSize: 13, color: 'rgba(207,234,248,.7)' }}>River Barrow</span>
            </div>
            <ol style={{ listStyle: 'none', margin: '24px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {ROWS.map((r, i) => {
                const reached = r.day <= day
                const isCur = i === current
                const obs = r.status === 'OBSERVED'
                return (
                  <li key={r.date} className="replay-row" style={{ borderRadius: 14, border: `1px solid ${isCur ? 'rgba(127,227,255,.6)' : 'rgba(255,255,255,.08)'}`, background: isCur ? 'rgba(79,195,247,.12)' : 'rgba(255,255,255,.03)', opacity: reached ? 1 : 0.38, transition: 'opacity .9s, background .9s, border-color .9s' }}>
                    <div>
                      <div className="mono" style={{ fontSize: 12, color: '#CFEAF8' }}>{r.date}</div>
                      <span className="mono" style={{ display: 'inline-block', marginTop: 6, padding: '4px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 500, background: obs ? HATCH : STATUS[r.status as Status].bg, color: obs ? '#04192C' : STATUS[r.status as Status].fg, border: `1px solid ${obs ? '#7FE3FF' : 'transparent'}` }}>
                        {obs ? 'Sentinel-1' : r.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 15, lineHeight: 1.45, color: '#E8F5FC' }}>{reached ? r.text : 'Not known yet.'}</div>
                  </li>
                )
              })}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}
