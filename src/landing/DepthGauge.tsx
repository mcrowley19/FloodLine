import { useScrollY } from './useScroll'

/** Depth reached when each section's top is 40 % of the way down the viewport. */
const MARKS: [string, number][] = [['problem', 5], ['product', 7], ['how', 10], ['data', 15], ['chandra', 20], ['satellite', 40], ['team', 44], ['cta', 48]]
/** Tick scale; the marker maps depth onto it piecewise, so each gap is the same height. */
const SCALE = [0, 5, 10, 20, 40]

function depthAt(y: number): number {
  const vh = window.innerHeight || 900
  const pts: [number, number][] = [[0, 0]]
  for (const [id, d] of MARKS) {
    const prev = pts[pts.length - 1][0]
    const el = document.getElementById(id)
    const at = el ? el.getBoundingClientRect().top + y - vh * 0.4 : prev + 900
    pts.push([Math.max(prev + 1, at), d])
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (y < pts[i + 1][0]) {
      const t = Math.max(0, (y - pts[i][0]) / (pts[i + 1][0] - pts[i][0]))
      return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t
    }
  }
  return pts[pts.length - 1][1]
}

/** Fixed gauge on the left edge reading depth in metres as you scroll. Hidden below 900px. */
export default function DepthGauge() {
  const y = useScrollY()
  const depth = depthAt(y)
  let idx = SCALE.length - 1
  for (let i = 0; i < SCALE.length - 1; i++) {
    if (depth < SCALE[i + 1]) {
      idx = i + (depth - SCALE[i]) / (SCALE[i + 1] - SCALE[i])
      break
    }
  }
  const pct = (i: number) => `${(i / (SCALE.length - 1)) * 100}%`
  // fade in over the end of the hero's flood runway; light-on-sky it can't be read
  const shown = Math.min(1, Math.max(0, (y - 500) / 400))

  return (
    <div className="gauge mono" aria-hidden="true" style={{ opacity: shown }}>
      <div style={{ position: 'absolute', left: 6, top: 0, bottom: 0, width: 1, background: 'linear-gradient(180deg, rgba(207,234,248,.5), rgba(207,234,248,.15))' }} />
      {SCALE.map((d, i) => (
        <div key={d} style={{ position: 'absolute', left: 0, top: pct(i), transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 8, opacity: Math.abs(idx - i) < 0.5 ? 0.95 : 0.35, transition: 'opacity 1.2s' }}>
          <span style={{ display: 'block', width: 13, height: 1, background: '#CFEAF8' }} />
          <span>{d} m</span>
        </div>
      ))}
      <div style={{ position: 'absolute', left: 0, top: pct(Math.min(idx, SCALE.length - 1)), transform: 'translate(-6px, -50%)', transition: 'top .5s cubic-bezier(.25,.1,.25,1)' }}>
        <div style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '7px solid #7FE3FF' }} />
      </div>
      <div style={{ position: 'absolute', left: 0, top: -30, color: '#7FE3FF', opacity: 0.8, fontSize: 13 }}>{depth.toFixed(1)} m</div>
    </div>
  )
}
