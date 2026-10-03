import { Fragment, useMemo, useState } from 'react'
import { useLeadTimes, useRisk, useSatelliteIreland, useErrorToast } from '../api/queries'
import type { LeadTimeRow, Status, SupplyItem } from '../api/types'
import { STATUSES } from '../api/types'
import { STATUS_LABEL, STATUS_RANK } from '../lib/status'
import { fmtHours, fmtUtcShort, hoursBetween, parseIso } from '../lib/time'
import { nearestFlood, FLOOD_PROXIMITY_KM } from '../lib/geo'
import { useNow } from '../hooks/useNow'
import { useStore } from '../store'
import { EmptyState, Skeleton, Stat, StatusPill } from './ui'

type SortKey = 'name' | 'county' | 'status' | 'hours' | 'bags' | 'crossing' | 'observed'

interface Row extends LeadTimeRow {
  hours: number | null
  crossingMs: number | null
  deadlineMs: number | null
  observed: boolean
  observedKm: number | null
  bagsGet: number
}

const SUMMARY_KEYS = ['sandbags', 'sand_t', 'sheeting_m2', 'tipper_loads', 'crew_hours']

const fmtQty = (v: number, unit: string) => {
  const n = v >= 100 || unit === 'bags' || unit === 'loads' ? Math.round(v).toLocaleString() : v.toFixed(1)
  return `${n} ${unit}`
}

const itemGet = (items: SupplyItem[] | undefined, key: string) => items?.find((i) => i.key === key)?.get ?? 0

export default function LeadTimesTab() {
  const now = useNow()
  const lt = useLeadTimes()
  const risk = useRisk()
  const sat = useSatelliteIreland()
  const selectStation = useStore((s) => s.selectStation)
  const setTab = useStore((s) => s.setTab)
  useErrorToast(lt.error, 'lead-times')

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'hours', dir: 1 })
  const [statusFilter, setStatusFilter] = useState<Status | 'ALL'>('ALL')
  const [county, setCounty] = useState('ALL')
  const [search, setSearch] = useState('')

  // station coords for the proximity check come from the row itself or the risk feed
  const coords = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>()
    for (const r of risk.data?.stations ?? []) m.set(r.station_id, { lat: r.lat, lon: r.lon })
    return m
  }, [risk.data])

  const rows: Row[] = useMemo(() => {
    const fc = sat.data?.status === 'ok' ? sat.data.features : null
    return (lt.data ?? []).map((r) => {
      const deadlineMs = parseIso(r.fill_deadline_utc)
      const c = r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon } : coords.get(r.station_id)
      const nf = c && fc ? nearestFlood(c.lon, c.lat, fc) : null
      return {
        ...r,
        deadlineMs,
        hours: deadlineMs != null ? hoursBetween(now, deadlineMs) : r.hours_remaining,
        crossingMs: parseIso(r.predicted_crossing_utc),
        observed: !!nf && nf.distanceKm <= FLOOD_PROXIMITY_KM,
        observedKm: nf?.distanceKm ?? null,
        bagsGet: itemGet(r.supplies?.items, 'sandbags'),
      }
    })
  }, [lt.data, coords, sat.data, now])

  const counties = useMemo(() => [...new Set(rows.map((r) => r.county).filter(Boolean))].sort(), [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = rows.filter(
      (r) =>
        (statusFilter === 'ALL' || r.status === statusFilter) &&
        (county === 'ALL' || r.county === county) &&
        (!q || r.name.toLowerCase().includes(q) || r.county.toLowerCase().includes(q) || r.tasks.some((t) => t.name.toLowerCase().includes(q))),
    )
    const cmp = (a: Row, b: Row): number => {
      switch (sort.key) {
        case 'name': return a.name.localeCompare(b.name)
        case 'county': return a.county.localeCompare(b.county)
        case 'status': return STATUS_RANK[a.status] - STATUS_RANK[b.status]
        case 'hours': return (a.hours ?? Infinity) - (b.hours ?? Infinity)
        case 'bags': return b.bagsGet - a.bagsGet
        case 'crossing': return (a.crossingMs ?? Infinity) - (b.crossingMs ?? Infinity)
        case 'observed': return Number(b.observed) - Number(a.observed)
      }
    }
    return list.sort((a, b) => cmp(a, b) * sort.dir || STATUS_RANK[a.status] - STATUS_RANK[b.status])
  }, [rows, search, statusFilter, county, sort])

  // Totals across the filtered stations: what to source now vs. every defence at once.
  const totals = useMemo(() => {
    const m = new Map<string, { label: string; unit: string; get: number; full: number }>()
    for (const r of filtered)
      for (const i of r.supplies?.items ?? []) {
        const t = m.get(i.key) ?? { label: i.label, unit: i.unit, get: 0, full: 0 }
        t.get += i.get
        t.full += i.full
        m.set(i.key, t)
      }
    return SUMMARY_KEYS.map((k) => [k, m.get(k)] as const).filter((e): e is readonly [string, NonNullable<typeof e[1]>] => !!e[1])
  }, [filtered])
  const fullKits = filtered.filter((r) => r.supplies?.full_kit).length

  const [expanded, setExpanded] = useState<string | null>(null)

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  const open = (id: string) => {
    selectStation(id)
    setTab('map')
  }

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-sea px-4 pb-24 pt-20 md:px-8">
      <div className="mx-auto max-w-[1400px]">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Lead times</h1>
            <p className="text-[12px] text-white/55">Hours remaining to each station's fill deadline, and the supplies to source given the current flood chance. Passed deadlines are struck through.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search station, county, task…"
              className="glass w-56 rounded-full px-3 py-1.5 text-[12px] placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | 'ALL')} className="glass rounded-full px-3 py-1.5 text-[12px] focus:outline-none">
              <option value="ALL">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select value={county} onChange={(e) => setCounty(e.target.value)} className="glass rounded-full px-3 py-1.5 text-[12px] focus:outline-none">
              <option value="ALL">All counties</option>
              {counties.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        {totals.length > 0 && (
          <div className="glass mb-4 rounded-2xl p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55">Supplies to source now</h2>
              <span className="text-[11px] text-white/45">
                {fullKits} of {filtered.length} stations need a full kit · rest are risk-weighted for a pooled stock
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {totals.map(([k, t]) => (
                <Stat key={k} label={t.label} value={fmtQty(t.get, t.unit)} sub={`${fmtQty(t.full, t.unit)} if every defence goes up`} />
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-white/45">
              Each station's kit is its full sandbag defence. If the chance of crossing P95 within fill time plus 24 h resupply clears the cost threshold p*, the whole kit is
              listed; otherwise the station adds probability × kit to a shared stock. Ratios: ~13.6 kg (30 lb) of sand per bag and 1 yd³ per 100 bags, 3 courses ≈ 0.3 m, sheeting
              ≥0.15 mm (6 mil) lapped 0.9 m, from{' '}
              <a className="underline hover:text-white/70" href="https://www.ndsu.edu/agriculture/extension/publications/sandbagging-flood-protection" target="_blank" rel="noreferrer">
                NDSU / USACE sandbagging guidance
              </a>
              . 1 m ground apron and 20 t tipper loads are planning assumptions.
            </p>
          </div>
        )}

        <div className="glass overflow-hidden rounded-2xl">
          {lt.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : lt.isError && !lt.data ? (
            <div className="p-6">
              <EmptyState title="Lead times unavailable" body="Could not reach the API." />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No stations match" body={rows.length ? 'Try clearing the filters.' : '/lead-times returned nothing.'} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] border-collapse text-[12px]">
                <thead className="sticky top-0 bg-[#0B2A4A]/80 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55 backdrop-blur">
                  <tr>
                    <Th label="Station" k="name" sort={sort} onSort={toggleSort} />
                    <Th label="County" k="county" sort={sort} onSort={toggleSort} />
                    <Th label="Status" k="status" sort={sort} onSort={toggleSort} />
                    <Th label="Hours to fill deadline" k="hours" sort={sort} onSort={toggleSort} right />
                    <Th label="Supplies to get" k="bags" sort={sort} onSort={toggleSort} right />
                    <Th label="Predicted crossing" k="crossing" sort={sort} onSort={toggleSort} />
                    <Th label="Observed" k="observed" sort={sort} onSort={toggleSort} center />
                    <th className="px-3 py-2.5 font-semibold">Tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const passed = r.deadlineMs != null && r.deadlineMs < now
                    const sp = r.supplies
                    const isOpen = expanded === r.station_id
                    return (
                      <Fragment key={r.station_id}>
                        <tr className="border-t border-white/10 transition hover:bg-white/5">
                          <td className="px-3 py-2">
                            <button onClick={() => open(r.station_id)} className="font-medium hover:underline">
                              {r.name}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-white/70">{r.county}</td>
                          <td className="px-3 py-2">
                            <StatusPill status={r.status} />
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums ${passed ? 'text-white/45 line-through' : r.hours != null && r.hours < 6 ? 'text-red-200' : ''}`}>
                            {r.hours != null ? fmtHours(r.hours) : '—'}
                            {r.deadlineMs != null && <span className="ml-1.5 text-white/40 no-underline">{fmtUtcShort(r.deadlineMs)}</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {sp ? (
                              <button
                                onClick={() => setExpanded(isOpen ? null : r.station_id)}
                                aria-expanded={isOpen}
                                className="inline-flex items-baseline gap-1.5 hover:underline"
                                title={`${Math.round(sp.p_need * 100)}% chance the defence is needed within ${sp.horizon_h} h`}
                              >
                                <span className={sp.full_kit ? 'font-semibold text-amber-200' : 'text-white/80'}>{r.bagsGet.toLocaleString()} bags</span>
                                <span className="text-white/40">{Math.round(sp.p_need * 100)}%</span>
                                <span className="text-[9px] text-white/40">{isOpen ? '▲' : '▼'}</span>
                              </button>
                            ) : (
                              <span className="text-white/35">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-white/80">{r.crossingMs != null ? fmtUtcShort(r.crossingMs) : <span className="text-white/35">—</span>}</td>
                          <td className="px-3 py-2 text-center">
                            {r.observed ? (
                              <span className="text-cyan-300" title={`Observed flooding ${r.observedKm?.toFixed(1)} km away`} aria-label="Observed flooding within 3 km">
                                ✓
                              </span>
                            ) : (
                              <span className="text-white/20">·</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {r.tasks.length === 0 && <span className="text-white/35">—</span>}
                              {r.tasks.map((t, i) => {
                                const dl = parseIso(t.deadline_utc)
                                const tp = dl != null && dl < now
                                return (
                                  <span key={i} className={`whitespace-nowrap rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] ${tp ? 'text-white/40 line-through' : 'text-white/80'}`}>
                                    {t.name}
                                    {dl != null && <span className="ml-1 text-white/45">{fmtUtcShort(dl)}</span>}
                                  </span>
                                )
                              })}
                            </div>
                          </td>
                        </tr>
                        {isOpen && sp && (
                          <tr className="bg-white/[0.03]">
                            <td colSpan={8} className="px-3 pb-3 pt-1">
                              <div className="mb-1.5 text-[11px] text-white/55">
                                {sp.full_kit
                                  ? `Full kit: ${Math.round(sp.p_need * 100)}% chance of crossing P95 within ${sp.horizon_h} h clears the cost threshold.`
                                  : `Risk-weighted share: ${Math.round(sp.p_need * 100)}% chance within ${sp.horizon_h} h × full kit.`}
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {sp.items.map((i) => (
                                  <span key={i.key} className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px]">
                                    <span className="text-white/55">{i.label}</span> <span className="tabular-nums text-white/90">{fmtQty(i.get, i.unit)}</span>
                                    <span className="text-white/35"> / {fmtQty(i.full, i.unit)}</span>
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="mt-2 text-[11px] text-white/40">
          {filtered.length} of {rows.length} stations · Observed = Sentinel-1 flood polygon within {FLOOD_PROXIMITY_KM} km
          {sat.data?.status === 'unavailable' ? ' (satellite unavailable)' : ''}
        </div>
      </div>
    </div>
  )
}

function Th({ label, k, sort, onSort, right, center }: { label: string; k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void; right?: boolean; center?: boolean }) {
  const active = sort.key === k
  return (
    <th className={`px-3 py-2.5 font-semibold ${right ? 'text-right' : center ? 'text-center' : ''}`}>
      <button onClick={() => onSort(k)} className={`inline-flex items-center gap-1 hover:text-white ${active ? 'text-white' : ''}`}>
        {label}
        <span className="text-[9px]">{active ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  )
}
