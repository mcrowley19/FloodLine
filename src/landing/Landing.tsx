import { useEffect, type ReactNode } from 'react'
import './landing.css'
import Hero from './Hero'
import DepthGauge from './DepthGauge'
import Motes from './Motes'
import HowItWorks from './HowItWorks'
import ChandraReplay from './ChandraReplay'
import { HATCH, ImagePlaceholder, Logo, SatelliteIcon, STATUS, StatusChip, type Status } from './ui'
import { APP_URL, GITHUB_URL } from './links'
import seabed from './assets/seabed.jpg'

/**
 * Marketing landing page: a descent into water. A pinned town floods as you scroll,
 * then the page is one body of water getting darker down to the seabed footer.
 */
export default function Landing() {
  useEffect(() => {
    document.title = 'Floodline · Know when the water is coming'
  }, [])

  return (
    <div className="fl">
      <DepthGauge />
      <Hero />
      <Problem />
      <Product />
      {/* lower water: drifting specks from here to the seabed */}
      <div style={{ position: 'relative' }}>
        <Motes />
        <HowItWorks />
        <Data />
        <ChandraReplay />
        <Satellite />
        <Team />
        <Cta />
        <Footer />
      </div>
    </div>
  )
}

function Problem() {
  return (
    <section id="problem" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Google forecasts the river. Nobody turns that into a task list.</h2>
        <div className="split" style={{ marginTop: 56 }}>
          <p style={{ margin: 0, fontSize: 17, lineHeight: 1.65, color: 'rgba(225,240,250,.72)' }}>
            In January 2026, Storm Chandra flooded Dublin, Wexford and Kilkenny, with more than 600 flooding reports. Ireland's local flood warnings are officially five to ten years away. Until then, each council decides on its own when to start filling sandbags. Fill too early and the bags rot. Fill too late and they arrive after the water.
          </p>
          <ImagePlaceholder
            ratio="16 / 9"
            file="problem-sandbags.jpg"
            prompt="Council crew in hi-vis filling sandbags beside a swollen brown river under a heavy grey sky, Irish town and stone bridge behind, light rain, documentary photo, muted colours."
          />
        </div>
      </div>
    </section>
  )
}

const TASKS: [Status, string, string, string][] = [
  ['FILL NOW', 'Graiguenamanagh', 'Fill and place sandbags', 'by 19:00'],
  ['FILL NOW', 'Enniscorthy', 'Fill and place sandbags', 'by 21:00'],
  ['PREPARE', 'Kilkenny', 'Clear culverts on the Nore', '< 48h'],
  ['PREPARE', 'Clonmel', 'Stage pumps and crews', '< 48h'],
  ['WATCH', 'Athlone', 'Check sandbag stock', '< 5 days'],
]

const BARS: [string, number, string][] = [
  ['6h', 18, 'rgba(255,209,102,.85)'],
  ['24h', 40, 'rgba(255,154,60,.9)'],
  ['48h', 56, STATUS['FILL NOW'].bg],
  ['5 days', 62, STATUS['FILL NOW'].bg],
]

function Product() {
  return (
    <section id="product" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Lead times for every river in Ireland, hours before it floods.</h2>
        <div className="two" style={{ marginTop: 56 }}>
          <div>
            <h3 className="hd h3">If you plan the flood response</h3>
            <p className="body" style={{ marginTop: 12 }}>
              Floodline gives every gauged river a chance of flooding at 6 hours, 24 hours, 48 hours and 5 days. Each place gets one status, FILL NOW, PREPARE or WATCH, and a deadline, so you know where sandbags and crews go first.
            </p>
            <div className="glass" style={{ marginTop: 28, borderRadius: 22, padding: 26, aspectRatio: '4 / 3', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="hd" style={{ fontSize: 30, fontWeight: 700, color: '#fff', overflowWrap: 'anywhere' }}>Graiguenamanagh</div>
                  <div style={{ marginTop: 4, fontSize: 14, color: 'var(--muted)' }}>River Barrow, Co. Kilkenny</div>
                </div>
                <StatusChip status="FILL NOW" style={{ padding: '6px 10px', borderRadius: 8 }} />
              </div>
              <div>
                <div style={{ fontSize: 14, color: 'var(--muted)' }}>Deadline</div>
                <div className="hd" style={{ fontSize: 56, lineHeight: 1, fontWeight: 700, color: '#fff' }}>19:00</div>
                <div className="mono" style={{ marginTop: 6, fontSize: 12, color: 'rgba(207,234,248,.65)' }}>Issued 26 Jan 09:00 · illustrative</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, alignItems: 'end' }}>
                {BARS.map(([label, h, bg]) => (
                  <div key={label}>
                    <div style={{ height: h, borderRadius: 4, background: bg }} />
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div>
            <h3 className="hd h3">If you're the crew on the ground</h3>
            <p className="body" style={{ marginTop: 12 }}>
              The forecast arrives as a task list, not a chart. Each row is a town, a river and a time to have the job done by: fill sandbags, clear culverts, get ready to evacuate.
            </p>
            <div className="glass" style={{ marginTop: 28, borderRadius: 22, padding: 22, aspectRatio: '4 / 3', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>Today's tasks</span>
                <span className="mono" style={{ fontSize: 11, color: 'rgba(207,234,248,.65)' }}>26 Jan 09:00 · illustrative</span>
              </div>
              <ul style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {TASKS.map(([status, town, task, when]) => (
                  <li key={town} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, background: 'rgba(4,20,36,.32)', border: '1px solid rgba(255,255,255,.08)' }}>
                    <StatusChip status={status} style={{ flex: 'none', width: 76, textAlign: 'center', padding: '4px 0', borderRadius: 6, fontSize: 10.5 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#F1F9FE' }}>{town}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{task}</div>
                    </div>
                    <span className="mono" style={{ fontSize: 11, color: '#BFE9FA', textAlign: 'right', whiteSpace: 'nowrap' }}>{when}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const icon = (paths: ReactNode) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
)

const SOURCES: [ReactNode, string, string][] = [
  [icon(<><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-6" /><path d="M2 21h20" /></>), 'OPW river gauges', '450 gauges reporting water level every 15 minutes. Licensed CC BY 4.0.'],
  [icon(<><path d="M7 15a4.5 4.5 0 1 1 1.2-8.8A6 6 0 0 1 19.5 9 3.5 3.5 0 0 1 18 15H7Z" /><path d="M8 18v3M12 18v3M16 18v3" /></>), 'ECMWF IFS ensemble', 'The physics-based ensemble rainfall forecast, used out to five days.'],
  [icon(<><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9z" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>), 'ECMWF AIFS ensemble', "ECMWF's machine-learning forecast, run as an ensemble alongside IFS."],
  [icon(<path d="M4 7h16M4 12h16M4 17h10" />), 'Open-Meteo', 'Serves both ensembles through one open API.'],
  [<SatelliteIcon key="s1" />, 'Copernicus Sentinel-1', 'A radar satellite that sees through cloud. It shows where it actually flooded.'],
  [icon(<><path d="M3 20h18" /><path d="M5 20V12M10 20V8M15 20v-5M20 20V5" /></>), 'The model', 'One model for all of Ireland, built in the 3-hour hack, giving P(flood) at four horizons.'],
]

function Data() {
  return (
    <section id="data" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Open data, one model, and a deadline on every warning.</h2>
        <p className="lede">Nothing in the pipeline is proprietary. Every source below is open, and the code is in the repo.</p>
        <ul className="three" style={{ listStyle: 'none', margin: '56px 0 0', padding: 0 }}>
          {SOURCES.map(([ic, title, text]) => (
            <li key={title}>
              <div style={{ width: 52, height: 52, borderRadius: 16, display: 'grid', placeItems: 'center', background: 'rgba(79,195,247,.12)', border: '1px solid rgba(127,227,255,.3)', color: '#7FE3FF' }}>{ic}</div>
              <h3 className="hd" style={{ margin: '20px 0 0', fontSize: 24, fontWeight: 650, color: '#fff' }}>{title}</h3>
              <p className="body">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

const BEFORE: { date: string; status: Status; opacity?: number; note?: string }[] = [
  { date: '24 Jan', status: 'WATCH', opacity: 0.55 },
  { date: '25 Jan', status: 'PREPARE', opacity: 0.7 },
  { date: '26 Jan 09:00', status: 'FILL NOW', note: 'by 19:00' },
]

function Satellite() {
  return (
    <section id="satellite" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">The model warns. The satellite confirms.</h2>
        <p className="lede">After the water comes, Copernicus radar sees through the cloud and maps where it flooded.</p>
        <div className="two" style={{ marginTop: 56 }}>
          <div>
            <div className="glass" style={{ borderRadius: 24, aspectRatio: '4 / 3', padding: 28, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12 }}>
              {BEFORE.map((r) => {
                const hot = !!r.note
                return (
                  <div key={r.date} style={{ display: 'flex', alignItems: 'center', gap: 14, opacity: r.opacity ?? 1, ...(hot ? { padding: 14, margin: '0 -14px', borderRadius: 14, background: 'rgba(255,90,78,.1)', border: '1px solid rgba(255,90,78,.45)' } : {}) }}>
                    <span className="mono" style={{ width: 110, flex: 'none', fontSize: 12, color: hot ? '#fff' : '#CFEAF8' }}>{r.date}</span>
                    <StatusChip status={r.status} style={{ padding: '4px 8px', borderRadius: 6, fontSize: 11 }} />
                    {r.note && <span style={{ fontSize: 14, color: '#fff' }}>{r.note}</span>}
                  </div>
                )
              })}
            </div>
            <h3 className="hd h3" style={{ marginTop: 24 }}>Before</h3>
            <p className="body">On the morning of 26 January, Graiguenamanagh moves to FILL NOW with a 19:00 deadline, a day before landfall.</p>
          </div>
          <div>
            <div className="glass" style={{ position: 'relative', borderRadius: 24, overflow: 'hidden', aspectRatio: '4 / 3', background: '#071A2F' }}>
              <svg viewBox="0 0 640 480" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustrative town outline with radar-observed flood extent hatched along the river" style={{ display: 'block', width: '100%', height: '100%' }}>
                <defs>
                  <pattern id="fl-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="7" stroke="#7FE3FF" strokeWidth="1.6" opacity=".75" />
                  </pattern>
                </defs>
                <rect width="640" height="480" fill="#071A2F" />
                <path d="M-20 140 C 120 170, 200 250, 300 270 S 480 320, 660 400" fill="none" stroke="#123E66" strokeWidth="48" />
                <line x1="268" y1="220" x2="320" y2="318" stroke="#2F5677" strokeWidth="12" />
                <g fill="none" stroke="rgba(170,220,245,.32)" strokeWidth="4" strokeLinecap="round">
                  <path d="M-10 86 C 120 116, 190 196, 290 220 S 470 275, 650 350" />
                  <path d="M-10 200 C 110 230, 200 305, 300 324 S 470 370, 650 450" />
                  <path d="M120 0 L170 148" /><path d="M250 10 L272 216" /><path d="M420 40 L432 262" /><path d="M322 324 L304 480" /><path d="M500 354 L522 480" />
                </g>
                <g fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="1.2">
                  {[[40,30,56,40],[106,40,34,46],[180,50,56,34],[180,100,44,44],[290,70,50,58],[350,90,56,40],[290,140,110,34],[446,130,70,44],[530,190,70,50],[446,196,60,40],[60,260,60,50],[130,320,70,48],[60,340,50,70],[210,380,70,40],[340,380,60,56],[420,410,66,40]].map(([x, y, w, h]) => (
                    <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />
                  ))}
                </g>
                <g fill="url(#fl-hatch)" stroke="#7FE3FF" strokeWidth="1.6" strokeLinejoin="round">
                  <path d="M150 170 L230 196 L300 226 L420 256 L486 282 L470 304 L400 298 L300 282 L222 248 L160 206 Z" />
                  <path d="M160 252 L250 290 L320 320 L430 348 L520 388 L492 418 L380 388 L300 354 L230 332 L150 288 Z" />
                  <path d="M520 282 L600 320 L590 350 L528 324 Z" />
                </g>
              </svg>
              <div style={{ position: 'absolute', left: 16, top: 16, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999, background: 'rgba(6,26,46,.72)', border: '1px solid rgba(127,227,255,.45)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', fontSize: 13, color: '#E6F8FF' }}>
                <span aria-hidden="true" style={{ width: 14, height: 9, borderRadius: 2, background: HATCH, border: '1px solid #7FE3FF' }} />
                Sentinel-1 observed · 14h ago
              </div>
              <div className="mono" style={{ position: 'absolute', right: 16, bottom: 14, fontSize: 11, color: 'rgba(207,234,248,.65)' }}>illustrative</div>
            </div>
            <h3 className="hd h3" style={{ marginTop: 24 }}>After</h3>
            <p className="body">On 27 January, Sentinel-1 radar maps the flooded streets along the Barrow.</p>
          </div>
        </div>
      </div>
    </section>
  )
}

/** TODO: names and roles from Michael. */
const TEAM = [1, 2, 3, 4].map(() => ({ name: '[Name]', role: '[Course, college]' }))

function Team() {
  return (
    <section id="team" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Meet the team</h2>
        <ul className="four" style={{ listStyle: 'none', margin: '56px 0 0', padding: 0 }}>
          {TEAM.map((p, i) => (
            <li key={i} style={{ minWidth: 0 }}>
              <ImagePlaceholder ratio="1 / 1" label="Headshot" prompt="Looking at the camera. Shown in black and white on the page." />
              <h3 style={{ margin: '18px 0 0', fontSize: 18, fontWeight: 600, color: '#fff' }}>{p.name}</h3>
              <p style={{ margin: '4px 0 0', fontSize: 15, color: 'rgba(207,234,248,.65)' }}>{p.role}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Cta() {
  return (
    <section id="cta" className="sec">
      <div className="wrap split">
        <div>
          <h2 className="hd sub-h">Pick a river. See when it floods.</h2>
          <div style={{ marginTop: 36, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <a href={APP_URL} className="btn btn-solid">Open the map</a>
            <a href={GITHUB_URL} className="btn btn-glass" target="_blank" rel="noreferrer">Source on GitHub</a>
          </div>
        </div>
        <ImagePlaceholder
          ratio="4 / 3"
          file="night-flood.jpg"
          prompt="A flooded Irish main street at night, sandbags stacked at the doorways, streetlights reflected in still dark water, nobody around, calm, cinematic, deep blue tones."
        />
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer style={{ position: 'relative', zIndex: 2, isolation: 'isolate', paddingTop: 40 }}>
      {/* ~360px of bottom padding keeps the text above the sandbags in the seabed */}
      <div className="wrap foot" style={{ paddingBottom: 360, fontSize: 14, color: 'rgba(207,227,240,.65)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <a href="#top" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: '#fff', textDecoration: 'none' }}>
            <Logo size={22} text={18} ring="#7FE3FF" fill="rgba(79,195,247,.32)" />
          </a>
          <span>Built at Hack for Humanity Dublin, 2026.</span>
          <span>Data: OPW (CC BY 4.0), Open-Meteo, Copernicus Sentinel-1.</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
          <a href={APP_URL} style={{ color: 'rgba(220,238,248,.8)', textDecoration: 'none' }}>App</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" style={{ color: 'rgba(220,238,248,.8)', textDecoration: 'none' }}>GitHub</a>
        </div>
      </div>
      <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 520, zIndex: -1, pointerEvents: 'none' }}>
        <img src={seabed} alt="" style={{ display: 'block', width: '100%', height: '100%', maxWidth: 'none', objectFit: 'cover', objectPosition: 'center 85%', WebkitMaskImage: 'linear-gradient(180deg, transparent 0, rgba(0,0,0,.6) 30%, #000 60%)', maskImage: 'linear-gradient(180deg, transparent 0, rgba(0,0,0,.6) 30%, #000 60%)' }} />
      </div>
    </footer>
  )
}
