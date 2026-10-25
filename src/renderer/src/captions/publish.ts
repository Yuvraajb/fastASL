import type { CaptionState } from '@shared/types'
import { useApp, type AppState } from '../app/store'

/** What the caption camera should show, from the overlay's chat state. */
export function captionStateOf(s: Pick<AppState, 'composing' | 'chat'>, lastAt: number): CaptionState {
  const live = s.composing.tokens.map((t) => t.text).join(' ')
  const you = [...s.chat].reverse().find((m) => m.from === 'you' && m.kind === 'text')
  const last = you && you.kind === 'text' ? you.text : ''
  return { live, last, lastAt }
}

const lastSentId = (s: Pick<AppState, 'chat'>): string | undefined =>
  [...s.chat].reverse().find((m) => m.from === 'you' && m.kind === 'text')?.id

/**
 * Overlay: sends the captions to the caption camera window whenever the words being signed change
 * or a message is sent (the same words signed again show again). Returns the unsubscribe.
 */
export function publishCaptions(): () => void {
  const send = window.fastasl?.sendCaptions
  if (typeof send !== 'function') return () => {}
  let prev = captionStateOf(useApp.getState(), 0)
  let prevId = lastSentId(useApp.getState())
  let lastAt = 0
  return useApp.subscribe((s) => {
    const id = lastSentId(s)
    if (id !== prevId) {
      prevId = id
      lastAt = Date.now()
    }
    const next = captionStateOf(s, lastAt)
    if (next.live === prev.live && next.last === prev.last && next.lastAt === prev.lastAt) return
    prev = next
    send(next)
  })
}

/**
 * Overlay: calls `onChange` with whether the caption camera window is open, now and whenever it
 * opens or closes. Returns the unsubscribe.
 */
export function followCaptionWindow(onChange: (open: boolean) => void): () => void {
  const api = window.fastasl
  if (typeof api?.onCaptionsOpen !== 'function') return () => {}
  let stopped = false
  const stop = api.onCaptionsOpen(onChange)
  void api.captionsOpen().then(
    (open) => {
      if (!stopped) onChange(open)
    },
    () => {}
  )
  return () => {
    stopped = true
    stop()
  }
}
