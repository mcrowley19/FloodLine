import { useScrollY } from './useScroll'
import { Logo } from './ui'
import { APP_URL } from './links'
import town from './assets/hero-town-cartoon.jpg'
import bin from './assets/bin.png'
import cone from './assets/cone.png'

/** Scroll distance over which the river rises, in px. The header adds this as runway. */
const RUNWAY = 900
/** River surface as % of the illustration's height: its real level, and full flood (half way up the terrace). */
const RIVER = 80
const FLOOD = 55

const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

/**
 * Pinned illustrated town. As you scroll through the runway the river rises from
 * its real level to full flood; the reflection, sandbag, bin and cone follow it.
 */
export default function Hero() {
  const y = useScrollY()
  const water = RIVER - (RIVER - FLOOD) * easeInOutQuad(Math.min(1, Math.max(0, y / RUNWAY)))
  const belowSurface = `inset(0 0 ${(100 - water).toFixed(2)}% 0)`
  const floating = water < 71

  return (
    <header id="top" className="hero">
      <div className="hero-pin">
        <a href="#top" aria-label="Floodline" style={{ position: 'absolute', top: 26, left: '50%', transform: 'translateX(-50%)', zIndex: 8, display: 'flex', alignItems: 'center', gap: 10, color: '#0F2438', textDecoration: 'none' }}>
          <Logo ring="#1E5A8A" fill="rgba(30,90,138,.28)" />
        </a>

        {/* town + river, positioned in the illustration's own coordinates */}
        <div className="town" aria-hidden="true">
          <img src={town} alt="" className="town-img" />
          <div className="river" style={{ top: `${water}%` }} />
          {/* the town mirrored about the surface, shown only below it */}
          <img src={town} alt="" className="reflection" style={{ top: `${2 * water - 100}%`, clipPath: belowSurface }} />

          {/* sandbag drifting in the river, cut off at the surface */}
          <div className="hide-sm" style={{ position: 'absolute', left: 0, right: 0, top: `calc(${water}% - 90px)`, height: 90, overflow: 'hidden' }}>
            <div className="bob" style={{ position: 'absolute', right: '12%', bottom: -14, ['--r' as string]: '5deg', animationDelay: '-2.4s' }}>
              <svg width="64" height="34" viewBox="0 0 90 48" fill="none">
                <path d="M6 26 C 4 12, 18 5, 44 6 C 70 5, 86 12, 84 26 C 86 38, 70 44, 44 43 C 18 44, 4 38, 6 26 Z" fill="#B49B6E" />
                <path d="M10 20 C 26 12, 62 12, 80 20" stroke="#D4BF92" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </div>
          </div>

          {/* bin and cone stand on the street until the water reaches them, then ride up with it */}
          <div style={{ position: 'absolute', inset: 0, clipPath: belowSurface }}>
            <div style={{ position: 'absolute', left: '6%', top: `calc(min(73.8%, ${water}% + 22px) - 70px)` }}>
              <div className={floating ? 'bob' : undefined} style={{ ['--r' as string]: '-10deg' }}>
                <img src={bin} alt="" style={{ display: 'block', width: 46, height: 'auto', filter: 'drop-shadow(0 2px 1.5px rgba(30, 30, 30, .35))' }} />
              </div>
            </div>
            <div style={{ position: 'absolute', right: '5%', top: `calc(min(72%, ${water}% + 14px) - 50px)` }}>
              <div className={floating ? 'bob' : undefined} style={{ ['--r' as string]: '14deg', animationDelay: '-4.6s' }}>
                <img src={cone} alt="" style={{ display: 'block', width: 'auto', height: 50 }} />
              </div>
            </div>
          </div>
        </div>

        <div className="hero-fade" aria-hidden="true" />
        <h1 className="hd hero-title">Know when the water is coming.</h1>
        <div className="hero-cta">
          <a href={APP_URL} className="btn btn-solid">Open the map</a>
        </div>
      </div>
    </header>
  )
}
