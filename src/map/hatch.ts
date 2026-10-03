import type { Map as MLMap } from 'maplibre-gl'

export const HATCH_IMAGE_ID = 'hatch-cyan'

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path d="M-4,4 L4,-4 M0,16 L16,0 M12,20 L20,12" stroke="#7FE3FF" stroke-width="1.6" stroke-linecap="square" fill="none"/>
</svg>`

let loading: Promise<void> | null = null

/** Registers a small diagonal-hatch SVG pattern as a map image (idempotent). */
export function ensureHatchImage(map: MLMap): Promise<void> {
  if (map.hasImage(HATCH_IMAGE_ID)) return Promise.resolve()
  if (loading) return loading
  loading = new Promise<void>((resolve) => {
    const img = new Image(32, 32)
    img.onload = () => {
      if (!map.hasImage(HATCH_IMAGE_ID)) map.addImage(HATCH_IMAGE_ID, img, { pixelRatio: 2 })
      loading = null
      resolve()
    }
    img.onerror = () => {
      loading = null
      resolve()
    }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SVG)
  })
  return loading
}
