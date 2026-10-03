import { useEffect, useRef, useState } from 'react'
import { Map as MLMap, AttributionControl, NavigationControl } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import irelandUrl from '../geo/ireland.json?url'
import riversUrl from '../geo/rivers.json?url'
import { useStore, selectDemoAt } from '../store'
import { useRisk, useSatellite, useWms } from '../api/queries'
import { useBaseLayers, SEA } from './baseLayers'
import { useCountyLabels } from './countyLabels'
import { useRiversLayer } from './riversLayer'
import { useRiskLayer } from './riskLayer'
import { useObservedFloodLayer } from './observedFloodLayer'
import { useDemoSatelliteLayer } from './demoSatelliteLayer'
import { useSentinel2Layer } from './sentinel2Layer'
import { setMapRef } from './mapRef'
import { IRELAND_BBOX } from '../lib/geo'
import { parseIso } from '../lib/time'
import { useIsMobile } from '../hooks/useMedia'

const BASE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors · OPW · Open-Meteo'

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<MLMap | null>(null)
  const [ireland, setIreland] = useState<FeatureCollection | null>(null)
  const [rivers, setRivers] = useState<FeatureCollection | null>(null)
  const isMobile = useIsMobile()
  const setViewBbox = useStore((s) => s.setViewBbox)

  // bundled geo data
  useEffect(() => {
    fetch(irelandUrl).then((r) => r.json()).then(setIreland).catch(() => setIreland({ type: 'FeatureCollection', features: [] }))
    fetch(riversUrl).then((r) => r.json()).then(setRivers).catch(() => setRivers({ type: 'FeatureCollection', features: [] }))
  }, [])

  // map init
  useEffect(() => {
    if (!containerRef.current) return
    const m = new MLMap({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'sea', type: 'background', paint: { 'background-color': SEA } }],
      },
      center: [-8.0, 53.4],
      zoom: 6,
      minZoom: 4.5,
      maxZoom: 16,
      attributionControl: false,
      maxBounds: [[-20, 46], [4, 60]],
    })
    m.addControl(new AttributionControl({ compact: true, customAttribution: BASE_ATTRIBUTION }), 'bottom-left')
    m.addControl(new NavigationControl({ showCompass: false }), 'top-left')

    let bboxTimer: number | undefined
    const emitBbox = () => {
      const b = m.getBounds()
      setViewBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(3)).join(','))
    }
    const onMoveEnd = () => {
      window.clearTimeout(bboxTimer)
      bboxTimer = window.setTimeout(emitBbox, 800)
    }
    m.on('moveend', onMoveEnd)
    m.on('load', () => {
      setMap(m)
      setMapRef(m)
      emitBbox()
    })
    return () => {
      window.clearTimeout(bboxTimer)
      setMapRef(null)
      m.remove()
    }
  }, [setViewBbox])

  // fit Ireland once, with padding for the sidebar / bottom sheet
  useEffect(() => {
    if (!map) return
    map.fitBounds(
      [[IRELAND_BBOX[0], IRELAND_BBOX[1]], [IRELAND_BBOX[2], IRELAND_BBOX[3]]],
      { padding: isMobile ? { top: 90, bottom: 260, left: 16, right: 16 } : { top: 90, bottom: 90, left: 60, right: 420 }, duration: 0 },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
      {map && <Layers map={map} ireland={ireland} rivers={rivers} />}
    </div>
  )
}

/** Mounts every map layer hook once the map has loaded. */
function Layers({ map, ireland, rivers }: { map: MLMap; ireland: FeatureCollection | null; rivers: FeatureCollection | null }) {
  const layers = useStore((s) => s.layers)
  const mode = useStore((s) => s.mode)
  const selectedId = useStore((s) => s.selectedStationId)
  const selectStation = useStore((s) => s.selectStation)
  const viewBbox = useStore((s) => s.viewBbox)
  const demoAt = useStore(selectDemoAt)

  const risk = useRisk()
  const sat = useSatellite(mode === 'live' ? viewBbox : null)
  const wms = useWms()

  useBaseLayers(map, ireland)
  useCountyLabels(map, ireland)
  useSentinel2Layer(map, wms.data, layers.imagery)
  useRiversLayer(map, rivers, layers.rivers)
  useObservedFloodLayer(map, mode === 'live' ? sat.data?.features : null, layers.observed && mode === 'live')
  useDemoSatelliteLayer(map, mode === 'demo' ? sat.data?.features : null, demoAt ? parseIso(demoAt) : null, layers.observed && mode === 'demo')
  useRiskLayer(map, risk.data?.stations, selectedId, selectStation)

  return null
}
