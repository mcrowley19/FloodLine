import { useEffect, useRef, useState } from 'react'
import { CHANDRA, FIRST_EMSR, LANDFALL } from './chandraData'
import { STATUS, SatelliteIcon } from './ui'
import landfallShot from './assets/dash-landfall.jpg'

const SERIES = [
  { key: 'FILL NOW', color: STATUS['FILL NOW'].bg },
  { key: 'PREPARE', color: STATUS.PREPARE.bg },
  { key: 'WATCH', color: STATUS.WATCH.bg },
  { key: 'CLEAR', color: 'rgba(207,234,248,.24)' },
] as const

const STEP_MS = 350
const N = CHANDRA.length
const LANDFALL_I = CHANDRA.findIndex(([t]) => t === LANDFALL)
const EMSR_I = CHANDRA.findIndex(([t]) => t === FIRST_EMSR)

// chart geometry, in viewBox units
const W = 640
const H = 280
const PAD = { l: 34, r: 6, t: 26, b: 26 }
const Y_MAX = 450
const colW = (W - PAD.l - PAD.r) / N
const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / Y_MAX)
const x = (i: number) => PAD.l + i * colW

const fmt = (t: string) => {
  const d = new Date(`${t}:00:00Z`)
  return `${d.getUTCDate()} Jan ${String(d.getUTCHours()).padStart(2, '0')}:00`
}

/** Status counts across all gauges for every 6-hourly snapshot of the replay. */
function StatusChart({ sel, onSelect }: { sel: number; onSelect: (i: number) => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
        {[0, 100, 200, 300, 400].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="rgba(207,234,248,.1)" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="rgba(207,234,248,.6)" fontFamily="IBM Plex Mono, monospace">{v}</text>
          </g>
        ))}
        {CHANDRA.map(([, ...counts], i) => {
          let base = 0
          return (
            <g key={i} opacity={i === sel ? 1 : 0.72} style={{ transition: 'opacity .3s' }}>
              {counts.map((c, s) => {
                const top = y(base + c)
                const h = y(base) - top
                base += c
                // 2px surface gap between stacked segments
                return h > 2 ? <rect key={s} x={x(i) + 1.5} width={colW - 3} y={top} height={h - 2} rx={1.5} fill={SERIES[s].color} /> : null
              })}
            </g>
          )
        })}
        {/* landfall and first satellite pass */}
        <line x1={x(LANDFALL_I) + colW / 2} x2={x(LANDFALL_I) + colW / 2} y1={PAD.t - 12} y2={H - PAD.b} stroke="#fff" strokeOpacity=".7" strokeDasharray="3 3" />
        <text x={x(LANDFALL_I) + colW / 2} y={PAD.t - 16} textAnchor="middle" fontSize="11" fill="#fff">Landfall</text>
        <line x1={x(EMSR_I) + colW / 2} x2={x(EMSR_I) + colW / 2} y1={PAD.t - 12} y2={H - PAD.b} stroke="#7FE3FF" strokeOpacity=".8" strokeDasharray="3 3" />
        <text x={x(EMSR_I) + colW / 2} y={PAD.t - 16} textAnchor="middle" fontSize="11" fill="#7FE3FF">Sentinel-1</text>
        {Array.from({ length: 9 }, (_, d) => (
          <text key={d} x={x(d * 4) + colW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="rgba(207,234,248,.65)" fontFamily="IBM Plex Mono, monospace">{22 + d}</text>
        ))}
      </svg>
      {/* one hit target per snapshot, the full column height */}
      <div role="group" aria-label="Replay snapshot" style={{ position: 'absolute', inset: 0, left: `${(PAD.l / W) * 100}%`, right: `${(PAD.r / W) * 100}%`, display: 'grid', gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` }}>
        {CHANDRA.map(([t, f, p, w, c], i) => (
          <button
            key={t}
            type="button"
            aria-pressed={i === sel}
            aria-label={`${fmt(t)} UTC: ${f} fill now, ${p} prepare, ${w} watch, ${c} clear`}
            onClick={() => onSelect(i)}
            onMouseEnter={() => onSelect(i)}
            onFocus={() => onSelect(i)}
            style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }}
          />
        ))}
      </div>
    </div>
  )
}

export default function ChandraReplay() {
  const [sel, setSel] = useState(LANDFALL_I)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const stop = () => {
    window.clearInterval(timer.current)
    timer.current = undefined
    setPlaying(false)
  }
  const play = () => {
    window.clearInterval(timer.current)
    let i = 0
    setSel(0)
    setPlaying(true)
    timer.current = window.setInterval(() => {
      i += 1
      setSel(i)
      if (i >= N - 1) stop()
    }, STEP_MS)
  }
  useEffect(() => () => window.clearInterval(timer.current), [])

  const [t, ...counts] = CHANDRA[sel]
  const total = counts.reduce((a, b) => a + b, 0)
  const tag = sel === LANDFALL_I ? ' · landfall' : sel >= EMSR_I ? ' · after first Sentinel-1 pass' : ''

  return (
    <section id="chandra" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Storm Chandra, replayed from the archive</h2>
        <p className="lede">
          The replay runs the same pipeline at 33 snapshots, every 6 hours from 22 to 30 January 2026. Each snapshot sees only the levels and rain recorded up to that time. Archived rain after the snapshot stands in for the ensemble median, so the forecast part is a proxy.
        </p>

        <div className="glass replay" style={{ marginTop: 48 }}>
          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span className="mono" style={{ fontSize: 13, color: '#fff' }}>{fmt(t)} UTC<span style={{ color: '#7FE3FF' }}>{tag}</span></span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{total} gauges with data</span>
            </div>
            <div aria-live="polite" className="readout">
              {SERIES.map((s, i) => (
                <div key={s.key} style={{ padding: '10px 12px', borderRadius: 12, background: 'rgba(4,20,36,.35)', border: '1px solid rgba(255,255,255,.1)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                    <span aria-hidden="true" style={{ flex: 'none', width: 9, height: 9, borderRadius: 2, background: s.color }} />
                    <span className="mono">{s.key}</span>
                  </div>
                  <div className="num" style={{ marginTop: 4, fontSize: 22, fontWeight: 600, color: '#fff' }}>{counts[i]}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 22 }}>
              <StatusChart
                sel={sel}
                onSelect={(i) => {
                  if (timer.current) stop()
                  setSel(i)
                }}
              />
            </div>
            <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(207,234,248,.6)' }}>
              <span className="mono">January 2026, 6-hourly</span>
              <span>Hover or tap a column</span>
            </div>
            <div style={{ marginTop: 22 }}>
              <button type="button" onClick={play} className="btn btn-glass" style={{ minHeight: 46, padding: '0 20px', font: "500 15px 'Inter', system-ui, sans-serif" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8Z" /></svg>
                {playing ? 'Replaying…' : 'Replay 22–30 Jan'}
              </button>
            </div>
            <table className="sr-only">
              <caption>Gauges per status at each replay snapshot</caption>
              <thead><tr><th>Time (UTC)</th>{SERIES.map((s) => <th key={s.key}>{s.key}</th>)}</tr></thead>
              <tbody>{CHANDRA.map(([tt, ...cs]) => <tr key={tt}><td>{fmt(tt)}</td>{cs.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>

          <ul className="kv">
            <li>
              <h3>What it shows</h3>
              <p>Gauges at FILL NOW rise from 168 on 22 January to 336 at landfall (27 January 00:00) and peak at 344 on the evening of the 29th.</p>
            </li>
            <li>
              <h3>Why so many, so early</h3>
              <p>The status compares each gauge against its own 95th percentile. In a wet January many rivers were already above it days before the storm, so they read FILL NOW from the first snapshot. Graiguenamanagh on the Barrow is one of them.</p>
            </li>
            <li>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><SatelliteIcon size={18} stroke="#7FE3FF" />Satellite confirmation</h3>
              <p>Copernicus EMS activation EMSR860 delivered Sentinel-1 flood maps for Co. Kilkenny, the first acquired on 29 January at 18:13 UTC. The Wexford products were never delivered.</p>
            </li>
          </ul>
        </div>

        <figure className="shot" style={{ marginTop: 40 }}>
          <img src={landfallShot} alt="Floodline dashboard in replay mode at landfall, 27 January 2026 00:00 UTC, with most river gauges marked fill now" loading="lazy" />
          <figcaption><b>Replay mode at landfall.</b> The dashboard's own replay: 336 of 409 gauges at FILL NOW. The scrubber steps through the same 33 snapshots as the chart above.</figcaption>
        </figure>
      </div>
    </section>
  )
}
