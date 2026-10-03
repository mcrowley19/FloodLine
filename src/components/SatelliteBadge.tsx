import { useStore } from '../store'
import { useSatellite } from '../api/queries'
import { useNow } from '../hooks/useNow'
import { fmtRelative, fmtUtcLong, parseIso } from '../lib/time'

/** "Sentinel-1 observed · 14h ago" floating near the bottom-left of the map. */
export default function SatelliteBadge() {
  const mode = useStore((s) => s.mode)
  const viewBbox = useStore((s) => s.viewBbox)
  const observedOn = useStore((s) => s.layers.observed)
  const now = useNow()
  const sat = useSatellite(mode === 'live' ? viewBbox : null)

  if (!observedOn) return null
  const d = sat.data
  if (!d && sat.isPending) {
    return <Badge className="text-white/50">Satellite: loading…</Badge>
  }
  if (!d) return null
  if (d.status === 'unavailable') {
    return (
      <Badge className="text-white/50" title={d.reason ?? 'No recent acquisition'}>
        <span className="h-1.5 w-1.5 rounded-full bg-white/30" />
        Satellite: unavailable
      </Badge>
    )
  }
  const at = parseIso(d.observed_at)
  const n = d.features?.features?.length ?? 0
  return (
    <Badge className="text-cyan-100" title={at ? `${fmtUtcLong(at)} · ${n} polygon${n === 1 ? '' : 's'} in view` : 'Observed flooding'}>
      <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_#7FE3FF]" />
      {mode === 'demo' ? 'EMSR860' : (d.source ?? 'Sentinel-1')} observed{at ? <> · {fmtRelative(at, now)}</> : null}
    </Badge>
  )
}

function Badge({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <div
      title={title}
      className={`glass pointer-events-auto fixed bottom-10 left-4 z-20 flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-medium md:bottom-12 ${className}`}
    >
      {children}
    </div>
  )
}
