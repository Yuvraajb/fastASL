import type { CaptionState } from '@shared/types'
import { useApp, type AppState } from '../app/store'

/** What the caption camera should show, from the overlay's chat state. */
export function captionStateOf(s: Pick<AppState, 'composing' | 'chat'>, lastAt: number): CaptionState {
  const live = s.composing.tokens.map((t) => t.text).join(' ')
  const you = [...s.chat].reverse().find((m) => m.from === 'you' && m.kind === 'text')
  const last = you && you.kind === 'text' ? you.text : ''
  return { live, last, lastAt }
}

/**
 * Overlay: sends the captions to the caption camera window whenever the words being signed or the
 * last sent message change. Returns the unsubscribe.
 */
export function publishCaptions(): () => void {
  const send = window.fastasl?.sendCaptions
  if (typeof send !== 'function') return () => {}
  let prev = captionStateOf(useApp.getState(), 0)
  let lastAt = 0
  return useApp.subscribe((s) => {
    const next = captionStateOf(s, lastAt)
    if (next.last !== prev.last) {
      lastAt = Date.now()
      next.lastAt = lastAt
    }
    if (next.live === prev.live && next.last === prev.last) return
    prev = next
    send(next)
  })
}
