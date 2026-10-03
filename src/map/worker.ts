/**
 * MapLibre v6 locates its web worker with `new URL(<computed>, import.meta.url)`,
 * which bundlers cannot resolve statically, so the worker is missing from a
 * production build. Import the worker through Vite (`?worker&url` bundles it
 * together with maplibre-gl-shared.mjs) and point MapLibre at that URL.
 * maplibre-gl only exports "." from its package.json, hence the file path.
 */
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from '../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)
