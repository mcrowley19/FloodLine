import { useState } from 'react'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useDataStatus, useSaveSettings, useErrorToast } from '../api/queries'
import type { Attribution, Settings, SourceHealth } from '../api/types'
import { fmtRelative, fmtUtcLong, parseIso } from '../lib/time'
import { useNow } from '../hooks/useNow'
import { EmptyState, SectionTitle, Skeleton, Stat } from './ui'

// Backend DecisionInputs defaults (src/floodline/decision.py)
const DEFAULT_SETTINGS: Settings = { defence_length_m: 200, bags_high: 2, crews: 2, fill_rate_bags_per_crew_hour: 100, cost_fill_unneeded_per_bag: 2, cost_short: 50000 }

const EXPECTED_SOURCES = ['OPW', 'Open-Meteo IFS', 'Open-Meteo AIFS', 'CFRAM', 'GFM', 'EMSR860', 'CDSE WMS']

export default function DataTab() {
  const ds = useDataStatus()
  const now = useNow()
  useErrorToast(ds.error, 'data-status')
  const d = ds.data

  // merge the expected source list with whatever the backend reports
  const sources: SourceHealth[] = EXPECTED_SOURCES.map((name) => {
    const found = d?.sources?.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.name.toLowerCase().includes(name.toLowerCase()))
    return found ?? { name, ok: false, reason: d ? 'not reported' : undefined }
  })
  for (const s of d?.sources ?? []) if (!sources.some((x) => x.name === s.name)) sources.push(s)

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-sea px-4 pb-24 pt-20 md:px-8">
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Dataset" className="xl:col-span-1">
          {!d ? (
            ds.isError ? <EmptyState title="Data status unavailable" /> : <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Stations" value={d.stations_loaded?.toLocaleString() ?? '—'} />
              <Stat label="Rows" value={d.rows?.toLocaleString() ?? '—'} />
              <Stat
                label="Last live"
                value={<span className="text-[13px]">{d.last_live_reading_utc ? fmtRelative(parseIso(d.last_live_reading_utc) ?? now, now) : '—'}</span>}
                sub={d.last_live_reading_utc ? fmtUtcLong(parseIso(d.last_live_reading_utc) ?? now) : undefined}
              />
            </div>
          )}
        </Card>

        <Card title="Model metrics per horizon" className="xl:col-span-2">
          {!d ? (
            <Skeleton className="h-24 w-full" />
          ) : d.model_metrics?.length ? (
            <table className="w-full text-[12px]">
              <thead className="text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-white/50">
                <tr>
                  <th className="py-1 pr-3">Horizon</th>
                  <th className="py-1 pr-3 text-right">Precision</th>
                  <th className="py-1 pr-3 text-right">Recall</th>
                  <th className="py-1 text-right">AUC-PR</th>
                </tr>
              </thead>
              <tbody>
                {d.model_metrics.map((m) => (
                  <tr key={m.horizon} className="border-t border-white/10">
                    <td className="py-1.5 pr-3 font-medium">{m.horizon}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtPct(m.precision)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtPct(m.recall)}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.auc_pr?.toFixed(3) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No metrics reported" />
          )}
        </Card>

        <Card title="Lead-time distribution" className="xl:col-span-2">
          {!d ? (
            <Skeleton className="h-44 w-full" />
          ) : d.lead_time_histogram?.length ? (
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.lead_time_histogram} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <XAxis dataKey="bin" tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: 'rgba(255,255,255,0.06)' }} contentStyle={{ background: 'rgba(11,42,74,0.95)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 10, fontSize: 11 }} />
                  <Bar dataKey="count" name="events" fill="#4FC3F7" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState title="No lead-time histogram" />
          )}
        </Card>

        <Card title="Source health">
          <ul className="flex flex-col divide-y divide-white/10">
            {sources.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-3 py-1.5 text-[12px]" title={s.reason ?? undefined}>
                <span>{s.name}</span>
                <span className={`truncate text-right text-[11px] ${d && !s.ok ? 'text-red-300' : 'text-white/50'}`}>
                  {!d ? '…' : s.ok ? (s.last_updated_utc ? fmtRelative(parseIso(s.last_updated_utc) ?? now, now) : 'ok') : (s.reason ?? 'down')}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Decision-layer defaults" className="md:col-span-2 xl:col-span-2">
          {/* key resets the form whenever the backend reports new settings */}
          <SettingsForm key={JSON.stringify(d?.settings ?? null)} initial={d?.settings} />
        </Card>

        <Card title="Attribution" className="md:col-span-2 xl:col-span-3">
          {!d ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[11px] text-white/65 md:grid-cols-2">
              {(d.attribution?.length ? d.attribution : DEFAULT_ATTRIBUTION).map((a) => (
                <li key={a.name}>
                  <span className="font-semibold text-white/85">{a.name}</span> — {a.text}
                  {a.url && (
                    <>
                      {' '}
                      <a href={a.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                        ↗
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

const DEFAULT_ATTRIBUTION: Attribution[] = [
  { name: 'OPW', text: 'Hydrometric data © Office of Public Works, Ireland (waterlevel.ie), CC BY 4.0.' },
  { name: 'Open-Meteo', text: 'Forecasts (ECMWF IFS & AIFS) via Open-Meteo, CC BY 4.0.' },
  { name: 'CFRAM', text: 'Flood maps © OPW Catchment Flood Risk Assessment and Management programme.' },
  { name: 'Copernicus', text: 'Contains modified Copernicus Sentinel data. Global Flood Monitoring (GFM) and EMSR860 © European Union.' },
  { name: 'OpenStreetMap', text: 'Counties and rivers © OpenStreetMap contributors, ODbL.' },
]

function fmtPct(v: number | null | undefined) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

function Card({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-2xl p-4 ${className}`}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  )
}

const FIELDS: { key: keyof Settings; label: string; unit: string; step: number }[] = [
  { key: 'defence_length_m', label: 'Defence length', unit: 'm', step: 10 },
  { key: 'bags_high', label: 'Bags high', unit: 'bags', step: 1 },
  { key: 'crews', label: 'Crews', unit: '', step: 1 },
  { key: 'fill_rate_bags_per_crew_hour', label: 'Fill rate', unit: 'bags/crew·h', step: 10 },
  { key: 'cost_fill_unneeded_per_bag', label: 'Wasted bag cost', unit: '€', step: 0.5 },
  { key: 'cost_short', label: 'Cost if unprotected', unit: '€', step: 1000 },
]

function SettingsForm({ initial }: { initial?: Settings }) {
  const [form, setForm] = useState<Settings>(initial ?? DEFAULT_SETTINGS)
  const save = useSaveSettings()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(form)
      }}
      className="flex flex-col gap-3"
    >
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/50">
            {f.label}
            <span className="flex items-center rounded-lg border border-white/15 bg-white/5 focus-within:ring-2 focus-within:ring-sky-300/40">
              <input
                type="number"
                step={f.step}
                min={0}
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                className="w-full bg-transparent px-2 py-1.5 text-[13px] font-medium normal-case tracking-normal text-white focus:outline-none"
              />
              {f.unit && <span className="pr-2 text-[10px] font-normal normal-case tracking-normal text-white/45">{f.unit}</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={save.isPending} className="rounded-full bg-sky-400/90 px-4 py-1.5 text-[12px] font-semibold text-[#0B2A4A] transition hover:bg-sky-300 disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save & recompute'}
        </button>
        <button type="button" onClick={() => setForm(initial ?? DEFAULT_SETTINGS)} className="text-[12px] text-white/55 hover:text-white">
          Reset
        </button>
        <span className="text-[11px] text-white/40">Posts to /settings and refetches risk, lead times and station decisions.</span>
      </div>
    </form>
  )
}
