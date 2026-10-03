import { useStore } from '../store'

export default function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-50 flex w-[min(92vw,420px)] -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`toast-in glass pointer-events-auto flex items-start gap-3 rounded-xl px-3 py-2 text-[12px] ${t.kind === 'error' ? 'border-red-300/40 text-red-50' : 'text-white/90'}`}
        >
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${t.kind === 'error' ? 'bg-red-400' : 'bg-emerald-400'}`} />
          <span className="flex-1">{t.message}</span>
          <button onClick={() => dismiss(t.id)} className="text-white/50 hover:text-white" aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
