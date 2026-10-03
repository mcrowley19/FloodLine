import { useStore } from './store'
import MapView from './map/MapView'
import Navbar from './components/Navbar'
import Sidebar from './components/Sidebar'
import SatelliteBadge from './components/SatelliteBadge'
import DemoPill from './components/DemoPill'
import LeadTimesTab from './components/LeadTimesTab'
import DataTab from './components/DataTab'
import AskTab from './components/AskTab'
import Toasts from './components/Toasts'

export default function App() {
  const tab = useStore((s) => s.tab)
  return (
    <div className="relative h-full w-full overflow-hidden bg-sea text-white">
      {/* Map stays mounted across tabs so its state (zoom, layers) survives */}
      <div className="absolute inset-0" style={{ visibility: tab === 'map' ? 'visible' : 'hidden' }} aria-hidden={tab !== 'map'}>
        <MapView />
      </div>
      {tab === 'map' && (
        <>
          <Sidebar />
          <SatelliteBadge />
        </>
      )}
      {tab === 'lead' && <LeadTimesTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'ask' && <AskTab />}
      <Navbar />
      <DemoPill />
      <Toasts />
    </div>
  )
}
