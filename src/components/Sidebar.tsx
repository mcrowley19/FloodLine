import { useStore } from '../store'
import { useIsMobile } from '../hooks/useMedia'
import MapPanel from './sidebar/MapPanel'
import StationDetail from './sidebar/StationDetail'

/** Right-hand frosted panel on desktop; bottom sheet on mobile. */
export default function Sidebar() {
  const selectedId = useStore((s) => s.selectedStationId)
  const sheetOpen = useStore((s) => s.sheetOpen)
  const setSheetOpen = useStore((s) => s.setSheetOpen)
  const isMobile = useIsMobile()

  const content = selectedId ? <StationDetail id={selectedId} /> : <MapPanel />

  if (isMobile) {
    return (
      <aside
        className="glass fixed inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-b-0 transition-[height] duration-300"
        style={{ height: sheetOpen ? '72vh' : '220px' }}
        aria-label="Station panel"
      >
        <button className="flex w-full items-center justify-center py-2" onClick={() => setSheetOpen(!sheetOpen)} aria-label={sheetOpen ? 'Collapse panel' : 'Expand panel'}>
          <span className="h-1 w-10 rounded-full bg-white/35" />
        </button>
        <div className="scroll-thin flex-1 overflow-y-auto px-4 pb-6">{content}</div>
      </aside>
    )
  }

  return (
    <aside className="glass fixed bottom-4 right-4 top-4 z-20 flex w-[380px] flex-col rounded-2xl xl:top-4 max-xl:top-[72px]" aria-label="Station panel">
      <div className="scroll-thin flex-1 overflow-y-auto p-4">{content}</div>
    </aside>
  )
}
