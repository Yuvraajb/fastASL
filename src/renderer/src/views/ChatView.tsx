import { useEffect, useRef } from 'react'
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { controller } from '../app/context'
import { useApp } from '../app/store'
import { Feed, Footer, Header, IconButton, Notice, Stack } from '../ui'
import './ChatView.css'

/**
 * Chat with the AI. Signed words land in the draft (hold the mic and sign); the draft is a real
 * text field, so it can be edited with the keyboard before sending. Thumbs up or Enter sends.
 */
export function ChatView(): React.JSX.Element {
  const chat = useApp((s) => s.chat)
  const log = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  // Keep the newest text in view while a reply streams in.
  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages])

  // The overlay never takes focus from the app being controlled; typing here needs it for a moment.
  useEffect(() => () => window.fastasl?.setFocusable(false), [])

  const send = (): void => controller.chatSend()

  return (
    <Stack>
      <Header view={{ kind: 'chat' }} />
      <Feed />
      <div className="chat">
        <div className="chat__log" ref={log} aria-live="polite">
          {chat.messages.length === 0 ? (
            <p className="chat__empty">Hold the mic and sign. Your words appear below.</p>
          ) : (
            chat.messages.map((m) => (
              <p key={m.id} className={`chat__msg chat__msg--${m.role}${m.status === 'error' ? ' chat__msg--error' : ''}`}>
                {m.text || (m.status === 'streaming' ? <span className="chat__dots" aria-label="Thinking">...</span> : null)}
              </p>
            ))
          )}
        </div>
        <div className="chat__composer">
          <textarea
            ref={field}
            className="chat__input"
            value={chat.draft}
            rows={2}
            placeholder="Sign to type, or click to edit..."
            spellCheck={false}
            aria-label="Message"
            onFocus={() => window.fastasl?.setFocusable(true)}
            onBlur={() => window.fastasl?.setFocusable(false)}
            onChange={(e) => controller.chatEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                field.current?.blur()
              }
            }}
          />
          {chat.busy ? (
            <IconButton icon={Square} label="Stop" variant="filled" size={30} iconSize={14} onClick={() => controller.chatStop()} />
          ) : (
            <IconButton
              icon={ArrowUp}
              label="Send (thumbs up or Enter)"
              variant="filled"
              size={30}
              iconSize={16}
              tone={chat.draft.trim() ? 'light' : 'dim'}
              onClick={send}
            />
          )}
        </div>
        <div className="chat__row">
          <IconButton icon={Plus} label="New chat" size={26} iconSize={15} onClick={() => controller.chatClear()} />
          <span className="chat__hint">thumbs up send · swipe ← delete word · fist leave</span>
          <IconButton icon={X} label="Close chat" size={26} iconSize={15} onClick={() => controller.tap('close')} />
        </div>
      </div>
      <Notice />
      <Footer listen />
    </Stack>
  )
}
