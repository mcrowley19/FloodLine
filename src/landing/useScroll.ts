import { useSyncExternalStore } from 'react'

/**
 * Window scroll position, throttled to one update per animation frame and shared
 * by every subscriber. Each component that reads it re-renders on its own, so the
 * rest of the page stays still while the hero, gauge and motes track the scroll.
 */
let y = typeof window === 'undefined' ? 0 : window.scrollY
let raf = 0
const listeners = new Set<() => void>()

function onScroll() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    y = window.scrollY
    listeners.forEach((l) => l())
  })
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

export function useScrollY() {
  return useSyncExternalStore(subscribe, () => y, () => 0)
}
