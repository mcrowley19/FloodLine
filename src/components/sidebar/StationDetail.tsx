import { useMemo } from 'react'
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useStore } from '../../store'
import { useStationDetail, useSatelliteIreland, useErrorToast } from '../../api/queries'
import type { LevelSample, RainfallSample, ShapValue, Task } from '../../api/types'
import { fmtHours, fmtRelative, fmtUtcShort, hoursBetween, parseIso } from '../../lib/time'
import { nearestFlood, FLOOD_PROXIMITY_KM } from '../../lib/geo'
import { useNow } from '../../hooks/useNow'
import { SectionTitle, Skeleton, StatusPill, Stat, EmptyState } from '../ui'

export default function StationDetail({ id }: { id: string }) {
  const selectStation = useStore((s) => s.selectStation)
  const now = useNow()
  const q = useStationDetail(id)
  const sat = useSatelliteIreland()
  useErrorToast(q.error, 'station')

  const d = q.data
  const flood = useMemo(() => (d ? nearestFlood(d.station.lon, d.station.lat, sat.data?.features) : null), [d, sat.data])

  return (
    <div className="flex flex-col gap-4">
      <button onClick={() => selectStation(null)} className="inline-flex w-fit items-center gap-1 text-[12px] text-white/60 hover:text-white">
        <span aria-hidden>←</span> Back to overview
      </button>

      {q.isPending || !d ? (
        q.isError ? (
          <EmptyState title="Station unavailable" body={(q.error as Error)?.message} />
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )
      ) : (
        <>
          <header>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold leading-tight tracking-tight">{d.station.name}</h2>
                <div className="text-[12px] text-white/55">
                  {d.station.county}
                  {d.station.river ? ` · ${d.station.river}` : ''}
                </div>
              </div>
              <StatusPill status={d.status} />
            </div>
          </header>

          <section className="grid grid-cols-[72px_1fr] gap-3">
            <Gauge level={d.current_level} p95={d.p95 ?? d.station.p95 ?? null} />
            <div className="flex flex-col gap-2">
              <SectionTitle>Level · last 72 h</SectionTitle>
              <Sparkline levels={d.levels} p95={d.p95 ?? d.station.p95 ?? null} />
              <div className="flex justify-between text-[11px] text-white/55">
                <span>
                  P24 <b className="text-white/85">{Math.round((d.p24 ?? 0) * 100)}%</b>
                </span>
                <span>
                  risk <b className="text-white/85">{(d.risk_score ?? 0).toFixed(2)}</b>
                </span>
              </div>
            </div>
          </section>

          <section>
            <SectionTitle>Rainfall · 7-day forecast (mm/6h)</SectionTitle>
            <FanChart data={d.rainfall} />
          </section>

          <section>
            <SectionTitle>Decision</SectionTitle>
            <DecisionBlock d={d} now={now} />
          </section>

          <section>
            <SectionTitle>Task deadlines</SectionTitle>
            <TaskList tasks={d.tasks} now={now} />
          </section>

          <section>
            <SectionTitle>Why · SHAP top 5</SectionTitle>
            <ShapBars shap={d.shap} />
          </section>

          <section>
            <SectionTitle>Satellite</SectionTitle>
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[12px]">
              {sat.data?.status === 'unavailable' ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-white/30" />
                  <span className="text-white/60">Satellite: unavailable{sat.data.reason ? ` · ${sat.data.reason}` : ''}</span>
                </>
              ) : flood && flood.distanceKm <= FLOOD_PROXIMITY_KM ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_8px_#7FE3FF]" />
                  <span>
                    Observed flooding {flood.distanceKm < 0.05 ? 'at station' : `${flood.distanceKm.toFixed(1)} km away`}
                    {(() => {
                      const acq = parseIso(flood.acquisition ?? sat.data?.observed_at)
                      return acq ? ` · ${fmtRelative(acq, now)}` : ''
                    })()}
                  </span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-white/30" />
                  <span className="text-white/70">No observed flooding in latest pass</span>
                </>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/* ------------------------------ sub-components ----------------------------- */

function Gauge({ level, p95 }: { level: number | null; p95: number | null }) {
  const max = Math.max(p95 ?? 0, level ?? 0, 0.01) * 1.25
  const lvlPct = level != null ? Math.min(100, (level / max) * 100) : 0
  const p95Pct = p95 != null ? Math.min(100, (p95 / max) * 100) : null
  const over = level != null && p95 != null && level >= p95
  return (
    <div className="flex flex-col items-center">
      <SectionTitle>Level</SectionTitle>
      <div className="relative h-40 w-7 overflow-hidden rounded-full border border-white/15 bg-white/5">
        <div
          className="absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-500"
          style={{ height: `${lvlPct}%`, background: over ? 'linear-gradient(180deg,#FF4D4F,#FF8A3D)' : 'linear-gradient(180deg,#7FE3FF,#4FC3F7)' }}
        />
        {p95Pct != null && (
          <div className="absolute inset-x-0 border-t border-dashed border-white/80" style={{ bottom: `${p95Pct}%` }} title={`P95 ${p95?.toFixed(2)} m`} />
        )}
      </div>
      <div className="mt-1.5 text-center text-[11px] leading-tight">
        <div className="font-semibold tabular-nums">{level != null ? `${level.toFixed(2)} m` : '—'}</div>
        <div className="text-white/50">P95 {p95 != null ? `${p95.toFixed(2)} m` : '—'}</div>
      </div>
    </div>
  )
}

function Sparkline({ levels, p95 }: { levels: LevelSample[]; p95: number | null }) {
  const W = 260
  const H = 56
  if (!levels?.length) return <div className="flex h-14 items-center text-[11px] text-white/40">No level history</div>
  const ys = levels.map((l) => l.level)
  const lo = Math.min(...ys, p95 ?? Infinity)
  const hi = Math.max(...ys, p95 ?? -Infinity)
  const span = hi - lo || 1
  const x = (i: number) => (i / Math.max(1, levels.length - 1)) * W
  const y = (v: number) => H - 4 - ((v - lo) / span) * (H - 8)
  const path = levels.map((l, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(l.level).toFixed(1)}`).join(' ')
  const area = `${path} L${W},${H} L0,${H} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" aria-label="72h level sparkline">
      <defs>
        <linearGradient id="spark" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#4FC3F7" stopOpacity="0.45" />
          <stop offset="1" stopColor="#4FC3F7" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark)" />
      {p95 != null && <line x1="0" x2={W} y1={y(p95)} y2={y(p95)} stroke="#fff" strokeOpacity="0.6" strokeDasharray="3 3" strokeWidth="1" />}
      <path d={path} fill="none" stroke="#7FE3FF" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function FanChart({ data }: { data: RainfallSample[] }) {
  const rows = useMemo(() => data.map((r) => ({ t: parseIso(r.t) ?? 0, range: [r.p10, r.p90] as [number, number], p50: r.p50 })), [data])
  if (!rows.length) return <div className="flex h-32 items-center text-[11px] text-white/40">No rainfall forecast</div>
  return (
    <div className="h-36 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: -22 }}>
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            tickFormatter={(v: number) => new Date(v).toLocaleDateString('en-IE', { weekday: 'short', timeZone: 'UTC' })}
            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            contentStyle={{ background: 'rgba(11,42,74,0.95)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 10, fontSize: 11 }}
            labelFormatter={(v) => fmtUtcShort(Number(v))}
            formatter={tooltipFormatter}
          />
          <Area dataKey="range" stroke="none" fill="#4FC3F7" fillOpacity={0.22} isAnimationActive={false} />
          <Line dataKey="p50" name="p50" stroke="#7FE3FF" strokeWidth={1.8} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

const tooltipFormatter = (v: unknown, name?: unknown): [string, string] =>
  Array.isArray(v) ? [`${Number(v[0]).toFixed(1)}–${Number(v[1]).toFixed(1)} mm`, 'p10–p90'] : [`${Number(v).toFixed(1)} mm`, String(name ?? '')]

function DecisionBlock({ d, now }: { d: NonNullable<ReturnType<typeof useStationDetail>['data']>; now: number }) {
  const dec = d.decision
  const deadline = parseIso(dec.fill_deadline_utc)
  const hours = dec.hours ?? (deadline ? hoursBetween(now, deadline) : null)
  const passed = deadline != null && deadline < now
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between">
        <StatusPill status={dec.status} />
        <span className="text-[11px] text-white/55">p* = {(dec.p_star ?? 0).toFixed(2)}</span>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <Stat label="Fill by" value={<span className={`whitespace-nowrap text-[12px] ${passed ? 'line-through text-white/50' : ''}`}>{deadline ? fmtUtcShort(deadline) : '—'}</span>} sub={deadline ? fmtRelative(deadline, now) : undefined} />
        <Stat label="Bags" value={dec.bags ? dec.bags.toLocaleString() : '—'} sub={dec.crews ? `${dec.crews} crew${dec.crews === 1 ? '' : 's'}` : undefined} />
        <Stat label="Lead time" value={hours != null ? fmtHours(hours) : '—'} sub={d.predicted_crossing_utc ? `crosses ${fmtUtcShort(parseIso(d.predicted_crossing_utc) ?? now)}` : undefined} />
      </div>
      {dec.expected_cost_eur != null && <div className="mt-2 text-[11px] text-white/55">Expected cost €{Math.round(dec.expected_cost_eur).toLocaleString()}</div>}
    </div>
  )
}

function TaskList({ tasks, now }: { tasks: Task[]; now: number }) {
  if (!tasks?.length) return <div className="text-[11px] text-white/40">No tasks scheduled</div>
  return (
    <ul className="flex flex-col divide-y divide-white/10 rounded-xl border border-white/10 bg-white/5">
      {tasks.map((t, i) => {
        const dl = parseIso(t.deadline_utc)
        const passed = dl != null && dl < now
        return (
          <li key={i} className={`flex items-center justify-between px-3 py-1.5 text-[12px] ${passed || t.done ? 'text-white/45' : ''}`}>
            <span className={passed && !t.done ? 'line-through' : ''}>
              {t.done ? '✓ ' : ''}
              {t.name}
            </span>
            <span className={`tabular-nums text-[11px] ${passed ? 'line-through' : 'text-white/70'}`}>
              {dl ? fmtUtcShort(dl) : '—'}
              {dl && !passed ? <span className="ml-1 text-white/45">({fmtRelative(dl, now)})</span> : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function ShapBars({ shap }: { shap: ShapValue[] }) {
  if (!shap?.length) return <div className="text-[11px] text-white/40">No explanation available</div>
  const max = Math.max(...shap.map((s) => Math.abs(s.value)), 1e-9)
  return (
    <ul className="flex flex-col gap-1.5">
      {shap.map((s) => {
        const pct = (Math.abs(s.value) / max) * 100
        const up = s.value >= 0
        return (
          <li key={s.feature} className="grid grid-cols-[110px_1fr_44px] items-center gap-2 text-[11px]">
            <span className="truncate text-white/75" title={s.feature}>
              {s.feature.replace(/_/g, ' ')}
            </span>
            <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: up ? '#FF8A3D' : '#4FC3F7' }} />
            </div>
            <span className={`text-right tabular-nums ${up ? 'text-orange-200' : 'text-sky-200'}`}>
              {up ? '+' : ''}
              {s.value.toFixed(2)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
