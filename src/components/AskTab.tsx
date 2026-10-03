import { useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import type { AskMessage, AskToolUse } from '../api/types'
import { useStore, selectDemoAt } from '../store'

interface Turn extends AskMessage {
  tools?: AskToolUse[]
  model?: string
  error?: boolean
}

interface Chat {
  turns: Turn[]
  pending: boolean
  set: (p: Partial<Pick<Chat, 'turns' | 'pending'>>) => void
  /** update the last (in-progress assistant) turn */
  patchLast: (f: (t: Turn) => Turn) => void
}

/** Conversation lives outside the component so it survives switching tabs. */
const useChat = create<Chat>((set) => ({
  turns: [],
  pending: false,
  set: (p) => set(p),
  patchLast: (f) => set((s) => ({ turns: [...s.turns.slice(0, -1), f(s.turns[s.turns.length - 1])] })),
}))

const SUGGESTIONS = [
  'Which gauges need sandbags filled now?',
  'Is the data up to date?',
  'How is the fill deadline calculated?',
  'How accurate is the 48-hour model?',
  'Any flood alerts in Cork?',
  'What does surface water risk mean?',
]

const TOOL_LABEL: Record<string, string> = {
  system_status: 'data status',
  river_risk: 'river risk',
  station_detail: 'gauge detail',
  alerts: 'alerts',
  search_docs: 'documentation',
}

/** Minimal markdown: paragraphs, bullet / numbered lists, **bold**, `code`. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} className="font-semibold text-white">{part.slice(2, -2)}</strong>
    ) : part.startsWith('`') && part.endsWith('`') ? (
      <code key={i} className="rounded bg-white/10 px-1 text-[12px]">{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  )
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length} className="ml-4 list-disc space-y-0.5">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>)
    list = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (item) list.push(item[1])
    else {
      flush()
      if (line) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</p>)
    }
  }
  flush()
  return <div className="space-y-2">{blocks}</div>
}

export default function AskTab() {
  const { turns, pending, set } = useChat()
  const demoAt = useStore(selectDemoAt)
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  // Braces matter: newer Chrome returns a Promise from scrollIntoView, which React would call as a cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length, pending])

  async function send(question: string) {
    const q = question.trim()
    if (!q || pending) return
    const history: AskMessage[] = turns.filter((t) => !t.error && t.content).map(({ role, content }) => ({ role, content }))
    set({ turns: [...turns, { role: 'user', content: q }, { role: 'assistant', content: '', tools: [] }], pending: true })
    setDraft('')
    const { patchLast } = useChat.getState()
    try {
      await api.ask({ question: q, history, at: demoAt }, (e) => {
        if (e.type === 'delta') patchLast((t) => ({ ...t, content: t.content + e.text }))
        else if (e.type === 'reset') patchLast((t) => ({ ...t, content: '' }))
        else if (e.type === 'tool') patchLast((t) => ({ ...t, tools: [...(t.tools ?? []), { tool: e.tool, args: e.args }] }))
        else if (e.type === 'done') patchLast((t) => ({ ...t, content: t.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '(no answer)', model: e.model }))
        else if (e.type === 'error') patchLast((t) => ({ ...t, content: e.detail, error: true }))
      })
    } catch (e) {
      patchLast((t) => ({ ...t, content: e instanceof Error ? e.message : 'Request failed', error: true }))
    } finally {
      set({ pending: false })
    }
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-sea px-4 pb-4 pt-20 md:px-8">
      <div className="mx-auto flex min-h-0 w-full max-w-[820px] flex-1 flex-col">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Ask Floodline</h1>
            <p className="text-[12px] text-white/55">
              Questions about the current data and how the system works. Answered by Qwen, an open-weights model running locally, using Floodline's own data.
              {demoAt && <span className="text-amber-200/80"> Answering about the Storm Chandra replay.</span>}
            </p>
          </div>
          {turns.length > 0 && (
            <button onClick={() => set({ turns: [] })} disabled={pending} className="glass rounded-full px-3 py-1.5 text-[12px] text-white/70 hover:text-white disabled:opacity-40">
              New conversation
            </button>
          )}
        </div>

        <div className="glass min-h-0 flex-1 overflow-y-auto rounded-2xl p-4">
          {turns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <p className="text-[13px] text-white/60">Try one of these, or type your own question.</p>
              <div className="flex max-w-[600px] flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/10 hover:text-white">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {turns.map((t, i) =>
                t.role === 'user' ? (
                  <div key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-sky-400/20 px-3.5 py-2 text-[13px] text-white">
                    {t.content}
                  </div>
                ) : (
                  <div key={i} className={`max-w-[92%] rounded-2xl rounded-bl-md px-3.5 py-2.5 text-[13px] leading-relaxed ${t.error ? 'border border-red-400/30 bg-red-500/10 text-red-100' : 'bg-white/[0.06] text-white/90'}`}>
                    {t.content ? (
                      <Markdown text={t.content} />
                    ) : (
                      <div className="flex items-center gap-2 text-white/60">
                        <span className="live-dot inline-block h-2 w-2 rounded-full bg-sky-300" />
                        {t.tools?.length ? `Reading ${TOOL_LABEL[t.tools[t.tools.length - 1].tool] ?? 'data'}…` : 'Thinking…'}
                      </div>
                    )}
                    {!t.error && (!!t.model || !!t.tools?.length) && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-white/40">
                        {t.tools?.length ? (
                          <>
                            <span>Looked up:</span>
                            {[...new Set(t.tools.map((x) => TOOL_LABEL[x.tool] ?? x.tool))].map((n) => (
                              <span key={n} className="rounded-full border border-white/10 px-1.5 py-px">{n}</span>
                            ))}
                          </>
                        ) : (
                          <span>No data lookups</span>
                        )}
                        {t.model && <span className="ml-auto">{t.model}</span>}
                      </div>
                    )}
                  </div>
                ),
              )}
              {pending && (
                <div className="flex max-w-[92%] items-center gap-2 rounded-2xl rounded-bl-md bg-white/[0.06] px-3.5 py-2.5 text-[13px] text-white/60">
                  Checking Floodline data…
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            send(draft)
          }}
          className="mt-3 flex items-end gap-2"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(draft)
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder="Ask about gauges, alerts, data sources or how the model works…"
            className="glass max-h-32 min-h-[42px] flex-1 resize-none rounded-2xl px-4 py-2.5 text-[13px] placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
          />
          <button type="submit" disabled={!draft.trim() || pending} className="h-[42px] rounded-full bg-sky-400/80 px-4 text-[13px] font-medium text-sea hover:bg-sky-300 disabled:opacity-40">
            Ask
          </button>
        </form>
        <p className="mt-1.5 text-center text-[10px] text-white/35">Decision support, not an official warning. Check Met Éireann and your local authority.</p>
      </div>
    </div>
  )
}
