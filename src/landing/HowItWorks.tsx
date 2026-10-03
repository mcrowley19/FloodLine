import { useState } from 'react'
import { STATUS, StatusChip, type Status } from './ui'

const HORIZONS = ['6h', '24h', '48h', '5 days'] as const
type Horizon = (typeof HORIZONS)[number]

/** Illustrative points; status per horizon (null = clear). The 24h column matches the town card and task list. */
const POINTS: { name: string; x: number; y: number; label: [number, number, 'start' | 'end']; status: Record<Horizon, Status | null> }[] = [
  { name: 'Graiguenamanagh', x: 281, y: 369, label: [292, 365, 'start'], status: { '6h': 'PREPARE', '24h': 'FILL NOW', '48h': 'FILL NOW', '5 days': 'FILL NOW' } },
  { name: 'Enniscorthy', x: 310, y: 375, label: [321, 384, 'start'], status: { '6h': 'WATCH', '24h': 'FILL NOW', '48h': 'FILL NOW', '5 days': 'FILL NOW' } },
  { name: 'Kilkenny', x: 259, y: 356, label: [206, 350, 'end'], status: { '6h': 'WATCH', '24h': 'PREPARE', '48h': 'FILL NOW', '5 days': 'FILL NOW' } },
  { name: 'Clonmel', x: 225, y: 394, label: [214, 408, 'end'], status: { '6h': null, '24h': 'PREPARE', '48h': 'PREPARE', '5 days': 'FILL NOW' } },
  { name: 'Athlone', x: 207, y: 260, label: [196, 256, 'end'], status: { '6h': null, '24h': 'WATCH', '48h': 'PREPARE', '5 days': 'PREPARE' } },
  { name: 'Dublin', x: 337, y: 273, label: [348, 270, 'start'], status: { '6h': null, '24h': 'WATCH', '48h': 'WATCH', '5 days': 'PREPARE' } },
]
const RADIUS: Record<Status, number> = { 'FILL NOW': 6, PREPARE: 5.5, WATCH: 5 }

const RIVERS = [
  'M206 169 L199 200 L206 262 L199 300 L180 331 L157 354 L105 360',
  'M270 294 L281 331 L281 369 L282 389 L279 412',
  'M259 356 L277 381 L281 392',
  'M214 350 L225 394 L255 404 L278 407',
  'M315 294 L307 281 L330 269 L338 269',
  'M307 319 L311 375 L322 396',
  'M127 452 L180 462',
  'M127 194 L116 169',
  'M232 187 L187 125',
  'M315 125 L304 44',
]

function IrelandMap() {
  const [horizon, setHorizon] = useState<Horizon>('24h')
  return (
    <div className="glass glow" style={{ position: 'relative', borderRadius: 26, overflow: 'hidden', aspectRatio: '5 / 4', background: 'radial-gradient(ellipse 70% 60% at 45% 50%, #0F355A, #0A2541 70%, #081D34)' }}>
      <svg aria-hidden="true" width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <pattern id="fl-grat" width="64" height="64" patternUnits="userSpaceOnUse">
            <path d="M64 0H0V64" fill="none" stroke="rgba(160,210,240,.07)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#fl-grat)" />
      </svg>
      <div className="mono" style={{ position: 'absolute', left: 20, top: 20, fontSize: 11, color: 'rgba(207,234,248,.7)' }}>26 Jan 09:00 · illustrative</div>
      <div role="group" aria-label="Forecast horizon" style={{ position: 'absolute', right: 14, top: 12, display: 'flex', gap: 2, padding: 3, borderRadius: 999, background: 'rgba(4,20,36,.5)', border: '1px solid rgba(255,255,255,.14)' }}>
        {HORIZONS.map((h) => {
          const on = h === horizon
          return (
            <button key={h} type="button" aria-pressed={on} onClick={() => setHorizon(h)} style={{ minHeight: 32, padding: '0 12px', border: 0, borderRadius: 999, font: "500 12px 'Inter', system-ui, sans-serif", cursor: 'pointer', background: on ? '#4FC3F7' : 'transparent', color: on ? '#062038' : '#CFEAF8', transition: 'background .5s' }}>
              {h}
            </button>
          )
        })}
      </div>
      <svg viewBox="-30 -20 470 560" role="img" aria-label={`Stylised map of Ireland with river risk points at the ${horizon} horizon`} style={{ position: 'absolute', left: '50%', top: '55%', transform: 'translate(-50%, -50%)', height: '82%', width: 'auto', maxWidth: '92%' }}>
        <path d="M250 15 L281 37 L304 37 L341 35 L367 81 L360 106 L394 125 L386 144 L345 181 L326 187 L334 222 L345 269 L352 315 L341 337 L322 396 L325 416 L283 422 L232 427 L214 444 L180 462 L165 477 L67 506 L90 477 L41 487 L64 462 L26 456 L19 422 L64 404 L60 367 L105 360 L94 319 L124 287 L45 262 L79 212 L37 194 L52 156 L112 162 L157 150 L180 112 L146 106 L165 62 L184 44 L232 29 L240 50 Z" fill="#1A3352" stroke="#3E6185" strokeWidth="2" strokeLinejoin="round" />
        <ellipse cx="319" cy="112" rx="14" ry="18" fill="#0E2D4D" stroke="#3E6185" strokeWidth="1" />
        <g fill="none" stroke="#4FA9FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity=".95">
          {RIVERS.map((d) => <path key={d} d={d} />)}
        </g>
        {POINTS.map((p, i) => {
          const s = p.status[horizon]
          if (!s) return <circle key={p.name} cx={p.x} cy={p.y} r="3.5" fill="rgba(207,234,248,.35)" />
          const { bg, fg } = STATUS[s]
          return (
            <g key={p.name}>
              {s !== 'WATCH' && <circle className="pulse" cx={p.x} cy={p.y} r={RADIUS[s] + 1} fill="none" stroke={bg} strokeWidth="2" style={{ animationDelay: `${-0.8 * i}s` }} />}
              <circle cx={p.x} cy={p.y} r={RADIUS[s]} fill={bg} stroke={fg} strokeWidth="1.5" />
            </g>
          )
        })}
        <g fontFamily="Inter, sans-serif" fontSize="11" fill="#CFEAF8">
          {POINTS.map((p) => <text key={p.name} x={p.label[0]} y={p.label[1]} textAnchor={p.label[2]}>{p.name}</text>)}
        </g>
      </svg>
    </div>
  )
}

const POINTS_COPY = [
  ['450 river gauges.', 'OPW gauges report water levels across Ireland every 15 minutes. That is where the model starts.'],
  ['100 versions of the next five days.', 'The ECMWF ensemble, from both the physics model (IFS) and the AI model (AIFS), gives 100 possible rainfall forecasts instead of one.'],
  ['One model for the whole country.', 'A single model turns river levels and rainfall into P(flood) at 6 hours, 24 hours, 48 hours and 5 days, for every river at once.'],
]

const RULE: [Status, string][] = [
  ['FILL NOW', 'Flooding is likely before a later fill would be ready. Fill and place sandbags, with a time to finish by.'],
  ['PREPARE', 'Flooding is possible within days. Stage sandbags, pumps and crews, and clear culverts.'],
  ['WATCH', 'The risk is rising but early. Check stock and watch the next forecast.'],
]

export default function HowItWorks() {
  return (
    <section id="how" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Every river is read, every 15 minutes.</h2>
        <div className="split-r" style={{ marginTop: 56 }}>
          <IrelandMap />
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 32 }}>
            {POINTS_COPY.map(([title, text]) => (
              <li key={title}>
                <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#fff' }}>{title}</h3>
                <p className="body">{text}</p>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ marginTop: 88, paddingTop: 56, borderTop: '1px solid rgba(255,255,255,.12)' }}>
          <p className="hd" style={{ margin: 0, fontSize: 'clamp(26px, 2.6vw, 34px)', fontWeight: 650, color: '#fff' }}>Built on the newsvendor rule.</p>
          <p className="lede" style={{ marginTop: 18 }}>
            Sandbags are a newsvendor problem. Act too early and the stock is wasted, act too late and you run short. Floodline weighs the cost of each against the chance of flooding and turns that into one decision and a deadline.
          </p>
          <div className="three" style={{ marginTop: 44 }}>
            {RULE.map(([s, text]) => (
              <div key={s}>
                <StatusChip status={s} />
                <p className="body" style={{ marginTop: 14 }}>{text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
