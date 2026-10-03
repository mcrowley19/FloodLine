import { useMemo } from 'react'
import { useStore, selectDemoAt } from '../../store'
import { useRisk, useErrorToast } from '../../api/queries'
import type { RiskPoint, Status } from '../../api/types'
import { STATUSES } from '../../api/types'
import { STATUS_COLOR, STATUS_LABEL } from '../../lib/status'
import { fmtHours, fmtUtcLong, parseIso, hoursBetween } from '../../lib/time'
import { useNow } from '../../hooks/useNow'
import { getMap } from '../../map/mapRef'
import { EmptyState, PBar, SectionTitle, Skeleton, StatusPill, Toggle } from '../ui'

export default function MapPanel() {
  const demoAt = useStore(selectDemoAt)
  const layers = useStore((s) => s.layers)
  const toggleLayer = useStore((s) => s.toggleLayer)
  const selectStation = useStore((s) => s.selectStation)
  const now = useNow()
  const risk = useRisk()
  useErrorToast(risk.error, 'risk')

  const stations = useMemo(() => risk.data?.stations ?? [], [risk.data])
  const counts = useMemo(() => {
    const c: Record<Status, number> = { CLEAR: 0, WATCH: 0, PREPARE: 0, FILL_NOW: 0 }
    for (const s of stations) if (s.status in c) c[s.status]++
    return c
  }, [stations])
  const top = useMemo(() => [...stations].sort((a, b) => (b.risk_score ?? 0) - (a.risk_score ?? 0)).slice(0, 10), [stations])

  const onPick = (p: RiskPoint) => {
    selectStation(p.station_id)
    const m = getMap()
    if (m && Number.isFinite(p.lat) && Number.isFinite(p.lon)) m.easeTo({ center: [p.lon, p.lat], zoom: Math.max(m.getZoom(), 8.5), duration: 700 })
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold tracking-tight">
            Ireland <span className="text-white/40">·</span> {demoAt ? <span className="tabular-nums">{fmtUtcLong(parseIso(demoAt) ?? now)}</span> : 'now'}
          </h2>
          {risk.isFetching && !risk.isPending && <span className="text-[10px] text-white/40">updating…</span>}
        </div>
        {risk.data?.generated_at && !demoAt && <div className="mt-0.5 text-[11px] text-white/45">risk computed {fmtUtcLong(parseIso(risk.data.generated_at) ?? now)}</div>}
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {STATUSES.map((s) => (
            <div key={s} className="rounded-xl border border-white/10 bg-white/5 px-2 py-1.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/55">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                {STATUS_LABEL[s]}
              </div>
              {risk.isPending ? <Skeleton className="mt-1 h-5 w-8" /> : <div className="text-lg font-semibold tabular-nums">{counts[s]}</div>}
            </div>
          ))}
        </div>
      </header>

      {demoAt && (
        <div className="rounded-xl border border-amber-300/40 bg-amber-400/15 px-3 py-2 text-[11px] leading-snug text-amber-100">
          <span className="font-semibold">Demo</span> · data as available at {fmtUtcLong(parseIso(demoAt) ?? now)} · forecast is a proxy
        </div>
      )}

      <section>
        <SectionTitle>Layers</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          <Toggle label="Observed flood" checked={layers.observed} onChange={() => toggleLayer('observed')} color="#7FE3FF" />
          <Toggle label="Imagery" checked={layers.imagery} onChange={() => toggleLayer('imagery')} color="#A7F3D0" />
          <Toggle label="Rivers" checked={layers.rivers} onChange={() => toggleLayer('rivers')} color="#4FC3F7" />
        </div>
        {layers.imagery && <div className="mt-1.5 text-[10px] text-white/45">Sentinel-2 imagery shows from zoom 11.</div>}
      </section>

      <section>
        <SectionTitle right={<span className="text-[10px] text-white/40">{stations.length} stations</span>}>Top risks</SectionTitle>
        {risk.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : risk.isError && !risk.data ? (
          <EmptyState title="Risk feed unavailable" body="Could not reach the API. Retrying automatically." />
        ) : stations.length === 0 ? (
          <EmptyState title="No stations in the risk feed" body="/risk returned an empty list." />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {top.map((p) => {
              const crossing = parseIso(p.predicted_crossing_utc)
              const hrs = p.hours_to_crossing ?? (crossing ? hoursBetween(now, crossing) : null)
              return (
                <li key={p.station_id}>
                  <button
                    onClick={() => onPick(p)}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:border-white/25 hover:bg-white/10"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium">{p.name}</div>
                        <div className="text-[11px] text-white/50">{p.county}</div>
                      </div>
                      <StatusPill status={p.status} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <PBar value={p.p24} status={p.status} className="flex-1" />
                      <span className="w-9 text-right text-[11px] tabular-nums text-white/70">{Math.round((p.p24 ?? 0) * 100)}%</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-white/55">
                      <span>{hrs != null && Number.isFinite(hrs) ? (hrs >= 0 ? `crosses in ~${fmtHours(hrs)}` : 'crossing passed') : 'no crossing predicted'}</span>
                      {p.bags_needed != null && p.bags_needed > 0 && <span className="tabular-nums">{p.bags_needed.toLocaleString()} bags</span>}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
