import type { Map as MLMap } from 'maplibre-gl'

/** Module-level handle so UI components (sidebar rows etc.) can fly the map without prop drilling. */
let current: MLMap | null = null
export const setMapRef = (m: MLMap | null) => (current = m)
export const getMap = () => current
