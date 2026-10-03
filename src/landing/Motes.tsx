import { useEffect, useRef } from 'react'

/** Fixed pseudo-random specks so the layout is the same on every render. */
const MOTES = Array.from({ length: 50 }, (_, i) => {
  const r = (n: number) => (((Math.sin(i * 7.31 + n * 41.17) * 24634.6345) % 1) + 1) % 1
  return {
    left: `${(r(1) * 100).toFixed(1)}%`,
    top: `${(r(2) * 100).toFixed(1)}%`,
    size: `${(1 + r(3) * 2).toFixed(1)}px`,
    opacity: 0.15 + r(4) * 0.3,
    delay: `${(-r(5) * 18).toFixed(1)}s`,
  }
})

const PARALLAX = 0.15

/**
 * Faint drifting specks behind the lower sections, the only ambient effect on the
 * page. They move at 15 % parallax once the container reaches the top of the
 * viewport. The transform is written directly so scrolling never re-renders them.
 */
export default function Motes() {
  const box = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const update = () => {
      raf = 0
      if (!box.current || !layer.current) return
      const shift = Math.max(0, -box.current.getBoundingClientRect().top) * PARALLAX
      layer.current.style.transform = `translate3d(0, ${shift.toFixed(1)}px, 0)`
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  return (
    <div ref={box} aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {/* extends upward so the parallax shift never uncovers an empty strip at the top */}
      <div ref={layer} style={{ position: 'absolute', left: 0, right: 0, top: '-20%', bottom: 0 }}>
        {MOTES.map((m, i) => (
          <span key={i} className="mote" style={{ position: 'absolute', left: m.left, top: m.top, width: m.size, height: m.size, borderRadius: '50%', background: `rgba(190,225,245,${m.opacity.toFixed(2)})`, animationDelay: m.delay }} />
        ))}
      </div>
    </div>
  )
}
