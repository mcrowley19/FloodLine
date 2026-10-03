import { useEffect, useState } from 'react'
import { useStore, selectDemoAt } from '../store'
import { parseIso } from '../lib/time'

/** "Now" in ms: the demo scrubber time in demo mode, else the wall clock (ticks every 30 s). */
export function useNow(): number {
  const demoAt = useStore(selectDemoAt)
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return demoAt ? (parseIso(demoAt) ?? clock) : clock
}
