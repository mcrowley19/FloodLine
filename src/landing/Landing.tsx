import { useEffect, type ReactNode } from 'react'
import './landing.css'
import Hero from './Hero'
import Motes from './Motes'
import ChandraReplay from './ChandraReplay'
import { Logo, SatelliteIcon, StatusChip, type Status } from './ui'
import { APP_URL, GITHUB_URL } from './links'
import seabed from './assets/seabed.jpg'
import nightFlood from './assets/night-flood.jpg'
import michael from './assets/michael-crowley.jpg'
import sandbags from './assets/problem-sandbags.jpg'
import shotMap from './assets/dash-map.jpg'
import shotStation from './assets/dash-station.jpg'
import shotLead from './assets/dash-lead.jpg'
import shotAsk from './assets/dash-ask.jpg'

/**
 * Landing page: a pinned town floods as you scroll, then the page explains how
 * Floodline works, section by section, down to the seabed footer. Every figure
 * here comes from BACKEND.md or the running system (screenshots taken 3 Oct 2026).
 */
export default function Landing() {
  useEffect(() => {
    document.title = 'Floodline · Flood lead times for Irish rivers'
  }, [])

  return (
    <div className="fl">
      <Hero />
      <Problem />
      <Dashboard />
      {/* lower water: drifting specks from here to the seabed */}
      <div style={{ position: 'relative' }}>
        <Motes />
        <Pipeline />
        <Model />
        <Decision />
        <Hazards />
        <ChandraReplay />
        <Limits />
        <Maker />
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
        <h2 className="hd sub-h">The decision it supports: when to fill sandbags</h2>
        <div className="split" style={{ marginTop: 56 }}>
          <div>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.65, color: 'rgba(225,240,250,.72)' }}>
              Irish councils decide locally when to fill and place sandbags. Fill too early and crews and stock are tied up for a flood that may not come. Fill too late and the defence isn't in place when the river rises.
            </p>
            <p style={{ margin: '16px 0 0', fontSize: 17, lineHeight: 1.65, color: 'rgba(225,240,250,.72)' }}>
              Floodline puts a number on that decision. For every OPW river and lake gauge it estimates the probability that the level reaches the gauge's own 95th percentile within 6, 24, 48 and 120 hours. A cost rule then turns that into one status and the latest time to start filling.
            </p>
          </div>
          <img src={sandbags} alt="Council crew in hi-vis filling sandbags beside a swollen river, with a stone bridge and town behind" loading="lazy" style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 18, border: '1px solid rgba(255,255,255,.14)' }} />
        </div>
      </div>
    </section>
  )
}

function Dashboard() {
  return (
    <section id="dashboard" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">The dashboard</h2>
        <p className="lede">A React and MapLibre front end over a FastAPI backend. Live data refreshes every 2 minutes. These are screenshots of the running system on 3 October 2026.</p>
        <figure className="shot" style={{ marginTop: 48 }}>
          <img src={shotMap} alt="Floodline map of Ireland with river gauges coloured by status and a sidebar listing the highest-risk gauges" loading="lazy" />
          <figcaption><b>Map.</b> 460 live gauges coloured by status and sized by risk, which is P(crossing within 48 h) × local flood exposure. The sidebar counts each status and ranks the gauges.</figcaption>
        </figure>
        <div className="shots">
          <figure className="shot">
            <img src={shotStation} alt="Station panel for Dinin Bridge showing level against P95, a 7-day rainfall forecast, the fill-by deadline and SHAP factors" loading="lazy" />
            <figcaption><b>Station panel.</b> The last 72 h of level against P95, the 7-day ensemble rainfall (median and p10–p90 band), the decision (fill-by time, bags, lead time, p*) and the top five SHAP contributions to the 24 h prediction.</figcaption>
          </figure>
          <div className="shots-col">
            <figure className="shot">
              <img src={shotLead} alt="Lead times table with supplies to source and task deadlines per gauge" loading="lazy" />
              <figcaption><b>Lead times.</b> Hours to each gauge's fill deadline, the task schedule worked back from the predicted crossing, and supplies to source now, pooled across gauges.</figcaption>
            </figure>
            <figure className="shot">
              <img src={shotAsk} alt="Ask Floodline answering which Kilkenny gauges are most at risk" loading="lazy" />
              <figcaption><b>Ask.</b> Qwen3 8B, an open-weights model running locally through Ollama, answers from five read-only tools over the server's state. Here it called <span className="mono">river_risk</span>.</figcaption>
            </figure>
          </div>
        </div>
      </div>
    </section>
  )
}

const STAGES: [string, string, ReactNode][] = [
  ['ingest', '8 min 07 s', 'Station list and 3 years of 15-minute levels for 461 OPW gauges (hourly means, shifted to the live feed’s datum); 3 years of hourly rain for 51 half-degree cells from Open-Meteo; CFRAM flood extents for exposure.'],
  ['features', '10 s', '10.6 million station-hours of features.'],
  ['train', '2 min 41 s', 'Four LightGBM models, one per horizon. Peak memory 3.7 GB.'],
  ['satellite-build', '2 s', 'Copernicus EMSR860 polygons and the latest GFM Sentinel-1 flood extent.'],
  ['hazards-build', '≈ 1.5 min', 'Soils, flood extents and groundwater maps rasterised and summarised over 818 land cells of 10 km.'],
  ['demo-build', '≈ 3.5 min', 'The 33 Storm Chandra snapshots, including archived high-resolution rain forecasts.'],
]

const SOURCES: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <path d="M4 18a8 8 0 1 1 16 0M12 18l4-6M2 21h20" />, title: 'OPW waterlevel.ie', text: 'Live level every 15 minutes, plus the Hydro-Data archive for training. CC BY 4.0.' },
  { icon: <path d="M7 15a4.5 4.5 0 1 1 1.2-8.8A6 6 0 0 1 19.5 9 3.5 3.5 0 0 1 18 15H7ZM8 18v3M12 18v3M16 18v3" />, title: 'ECMWF IFS + AIFS ensembles', text: 'About 102 pooled members over 15 days, via Open-Meteo. Gives per-gauge p10/p50/p90 rain totals, refreshed at most every 6 hours.' },
  { icon: <path d="M4 7h16M4 12h16M4 17h10" />, title: 'Open-Meteo archive', text: 'Hourly observed rain for the same 3 years, per grid cell, plus the last 31 days to cover the archive’s lag.' },
  { icon: <path d="M3 20h18M5 20V12M10 20V8M15 20v-5M20 20V5" />, title: 'OPW CFRAM extents', text: 'Exposure is the km² of 10-year flood extent within 5 km of each gauge.' },
  { icon: <SatelliteIcon />, title: 'Copernicus EMS and GFM', text: 'Sentinel-1 radar flood maps: the EMSR860 activation for Storm Chandra, and GFM’s latest observed flooding over Ireland.' },
  { icon: <path d="M2 12h4l3-8 4 16 3-8h6" />, title: 'EPA, GSI and Marine Institute', text: 'Soil drainage, groundwater flood maps and tide plus surge forecasts for the three non-river screens.' },
]

function Pipeline() {
  return (
    <section id="pipeline" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Data pipeline</h2>
        <p className="lede">
          Python 3.11, httpx, polars and LightGBM. There is no database: each stage writes Parquet or GeoJSON and is skipped when its output already exists. A full build of all stages took about 17 minutes on a MacBook Air.
        </p>
        <ol className="stages" style={{ marginTop: 40 }}>
          {STAGES.map(([name, t, text]) => (
            <li key={name}>
              <code>{name}</code>
              <span className="t">{t}</span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
        <ul className="three" style={{ listStyle: 'none', margin: '64px 0 0', padding: 0 }}>
          {SOURCES.map(({ icon, title, text }) => (
            <li key={title}>
              <div style={{ width: 48, height: 48, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'rgba(79,195,247,.12)', border: '1px solid rgba(127,227,255,.3)', color: '#7FE3FF' }}>
                {title.startsWith('Copernicus') ? icon : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon}</svg>}
              </div>
              <h3 className="hd" style={{ margin: '18px 0 0', fontSize: 22, fontWeight: 650, color: '#fff' }}>{title}</h3>
              <p className="body">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

const METRICS: [string, string, string, string, string, string][] = [
  ['6 h', '0.48', '0.92', '0.89', '0.97', '0.17'],
  ['24 h', '0.46', '0.84', '0.84', '0.93', '0.25'],
  ['48 h', '0.45', '0.80', '0.83', '0.91', '0.31'],
  ['120 h', '0.45', '0.75', '0.89', '0.90', '0.45'],
]

function Model() {
  return (
    <section id="model" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">The model</h2>
        <p className="lede">One pooled LightGBM classifier per horizon, trained on every gauge at once with the gauge id as a categorical feature.</p>
        <div className="split" style={{ marginTop: 48, alignItems: 'start' }}>
          <ul className="kv">
            <li>
              <h3>Label</h3>
              <p>For horizon H ∈ {'{6, 24, 48, 120}'} hours: does the maximum level in the next H hours reach the gauge’s own P95? Gauges with fewer than 500 valid hours are dropped.</p>
            </li>
            <li>
              <h3>Features, per station-hour</h3>
              <p>Level now; lags of 1, 3, 6, 12 and 24 h; 3 h and 6 h rise rates; percentile of the gauge’s own record; distance to P95; rain over the past 1 h to 30 days and the next 6 h to 7 days; the gauge’s P50, P95, max and spread; exposure; location.</p>
            </li>
            <li>
              <h3>Training and calibration</h3>
              <p>Train to September 2025, validate October to December 2025, test January to February 2026. Negatives are subsampled and reweighted, so raw scores are Platt-calibrated on validation before the decision layer compares them with a cost threshold.</p>
            </li>
          </ul>
          <div>
            <table className="tbl">
              <caption className="sr-only">Test results, January to February 2026, 461 gauges</caption>
              <thead>
                <tr><th scope="col">Horizon</th><th scope="col">Cutoff</th><th scope="col">Precision</th><th scope="col">Recall</th><th scope="col">AUC-PR</th><th scope="col">Base rate</th></tr>
              </thead>
              <tbody>
                {METRICS.map((r) => <tr key={r[0]}>{r.map((v, i) => (i === 0 ? <th key={i} scope="row" style={{ textAlign: 'left', fontWeight: 600, color: '#fff', fontSize: 14, padding: '11px 0', borderBottom: '1px solid rgba(255,255,255,.08)' }}>{v}</th> : <td key={i}>{v}</td>))}</tr>)}
              </tbody>
            </table>
            <p className="body" style={{ marginTop: 16, fontSize: 14 }}>
              Test set: January to February 2026, 461 gauges. Over 1,605 real P95 crossings, the 24 h head alerted 13–24 h ahead for 1,115 and missed 100. The 48 h head alerted 25–48 h ahead for 1,312 and missed 43.
            </p>
            <div className="note">
              <b>Read these numbers with care.</b> Training and testing use observed future rain as a perfect-forecast stand-in, so they are an upper bound on what real ensemble forecasts give. P95 is also a low bar in a wet winter: base rates of 17–45% mean many gauges sit near it for weeks.
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const RULES: [Status, string][] = [
  ['FILL NOW', 'P(crossing within L) ≥ p*. Fill and place now; the deadline is the predicted crossing minus L.'],
  ['PREPARE', 'P(crossing within L + 24 h) ≥ p*. Stage bags, pumps and crews, clear culverts.'],
  ['WATCH', 'P(crossing within 120 h) ≥ p*. Check stock and watch the next run.'],
]

function Decision() {
  return (
    <section id="decision" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">From probability to a deadline</h2>
        <p className="lede">
          Sandbagging is a newsvendor problem: the cost of filling bags that aren’t needed against the cost of being short. Floodline computes the break-even probability p* and the lead time L for each gauge, and compares them with the forecast.
        </p>
        <div className="split" style={{ marginTop: 48, alignItems: 'start' }}>
          <div>
            <pre className="formula mono">{`N  = defence length × bags per metre
L  = N / (crews × fill rate) + travel + margin
p* = c_fill·N / (c_fill·N + c_short)

e.g. 100 m, 2 bags high → N = 1,500 bags
     2 crews × 100 bags/h → L = 10.25 h
     c_fill = 2, c_short = 50,000 → p* ≈ 0.057`}</pre>
            <p className="body" style={{ marginTop: 16, fontSize: 14 }}>
              P(crossing within t) is interpolated log-linearly between the four horizons after forcing it to increase with t. Every input is a default that a council can override per gauge through <span className="mono">POST /settings</span>.
            </p>
          </div>
          <div>
            <div style={{ display: 'grid', gap: 20 }}>
              {RULES.map(([s, text]) => (
                <div key={s} style={{ display: 'grid', gridTemplateColumns: '100px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
                  <StatusChip status={s} style={{ textAlign: 'center' }} />
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: 'var(--body)' }}>{text}</p>
                </div>
              ))}
            </div>
            <p className="body" style={{ marginTop: 28, fontSize: 14 }}>
              Tasks are scheduled back from the predicted crossing: rest centre on standby 24 h before the predicted crossing, public warning 18 h before, sandbags filled by the deadline, culvert screens cleared 8 h before, collection points open 4 h before. Supplies (bags, sand, sheeting, tipper loads, crew-hours) follow USACE and NDSU sandbagging ratios.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

const HAZARDS: [string, string, string][] = [
  ['Surface water', 'Per 10 km cell', 'Peak 1 h, 3 h and 24 h rain over the next ~60 h from three ~2 km models (UKV, KNMI and DMI HARMONIE), against 20 / 30 / 40 mm thresholds lowered for poorly drained or saturated ground. HIGH needs two models to agree.'],
  ['Groundwater', '1,505 GSI zones', 'Rain over the past 30, 60 and 90 days plus the next 7, ranked against the zone’s own 3-year record. Mostly karst turloughs in the west and midlands.'],
  ['Coastal', '40 surge points', 'Marine Institute tide plus surge over the next 48 h, against the 95th and 99th percentiles of predicted high water at the nearest tide station.'],
]

function Hazards() {
  return (
    <section id="hazards" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Three other flood types</h2>
        <p className="lede">
          These are rule-based screens, not trained models: there is no open record of surface-water, groundwater or coastal flood events to learn from. Their thresholds and weights are judgement. All four types merge into one alert list at <span className="mono">/alerts</span>.
        </p>
        <ul className="three" style={{ listStyle: 'none', margin: '48px 0 0', padding: 0 }}>
          {HAZARDS.map(([title, unit, text]) => (
            <li key={title}>
              <h3 className="hd" style={{ margin: 0, fontSize: 24, fontWeight: 650, color: '#fff' }}>{title}</h3>
              <p className="mono" style={{ margin: '6px 0 0', fontSize: 12, color: '#7FE3FF' }}>{unit}</p>
              <p className="body">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

const LIMITS: [string, string][] = [
  ['P95 is a proxy for flooding', 'It is not a flood threshold, and wet winters exceed it often. Councils’ own station thresholds should replace it where they exist.'],
  ['Skill is optimistic', 'Training uses observed rain in place of forecasts, so live skill depends on the ensemble and will be lower than the test table.'],
  ['Coarse rain grid', 'The free Open-Meteo tier gives 0.5° cells (about 50 km), which smooths convective storms over small catchments.'],
  ['Satellites confirm, they don’t warn', 'Sentinel-1 revisits Ireland every 2–4 days and maps arrive 6–48 h after acquisition.'],
]

function Limits() {
  return (
    <section id="limits" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Known limitations</h2>
        <ul className="limits">
          {LIMITS.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Maker() {
  return (
    <section id="maker" className="sec">
      <div className="wrap">
        <h2 className="hd sub-h">Built by one person</h2>
        <div style={{ marginTop: 48, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '24px 32px' }}>
          <img src={michael} alt="Michael Crowley" loading="lazy" style={{ display: 'block', width: 180, height: 180, objectFit: 'cover', objectPosition: '35% 25%', borderRadius: 18, filter: 'grayscale(1) contrast(1.05)', border: '1px solid rgba(255,255,255,.14)' }} />
          <div>
            <h3 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: '#fff' }}>Michael Crowley</h3>
            <p style={{ margin: '4px 0 0', fontSize: 15, color: 'rgba(207,234,248,.7)' }}>Computer Science, Trinity College Dublin</p>
            <p className="body" style={{ marginTop: 14, maxWidth: 440 }}>Designed and built Floodline solo at Hack for Humanity Dublin, 2026: the data pipeline, the model, the backend and the dashboard.</p>
          </div>
        </div>
      </div>
    </section>
  )
}

function Cta() {
  return (
    <section id="cta" className="sec">
      <div className="wrap split">
        <div>
          <h2 className="hd sub-h">Open the dashboard</h2>
          <p className="lede" style={{ marginTop: 20 }}>The live map, lead times, data sources and the Storm Chandra replay. The code, including the backend, is on GitHub.</p>
          <div style={{ marginTop: 32, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <a href={APP_URL} className="btn btn-solid">Open the dashboard</a>
            <a href={GITHUB_URL} className="btn btn-glass" target="_blank" rel="noreferrer">Source on GitHub</a>
          </div>
        </div>
        <img
          src={nightFlood}
          alt="Illustration of a flooded Irish main street at night, sandbags stacked at every doorway"
          loading="lazy"
          style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 18, border: '1px solid rgba(255,255,255,.14)', boxShadow: '0 24px 60px rgba(2,14,28,.45)' }}
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
          <span>Data: OPW (CC BY 4.0), Open-Meteo, ECMWF, Copernicus EMS and Sentinel-1, EPA, GSI, Marine Institute.</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
          <a href={APP_URL} style={{ color: 'rgba(220,238,248,.8)', textDecoration: 'none' }}>Dashboard</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" style={{ color: 'rgba(220,238,248,.8)', textDecoration: 'none' }}>GitHub</a>
        </div>
      </div>
      <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 520, zIndex: -1, pointerEvents: 'none' }}>
        <img src={seabed} alt="" style={{ display: 'block', width: '100%', height: '100%', maxWidth: 'none', objectFit: 'cover', objectPosition: 'center 85%', WebkitMaskImage: 'linear-gradient(180deg, transparent 0, rgba(0,0,0,.6) 30%, #000 60%)', maskImage: 'linear-gradient(180deg, transparent 0, rgba(0,0,0,.6) 30%, #000 60%)' }} />
      </div>
    </footer>
  )
}
