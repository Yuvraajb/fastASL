import { useEffect, useRef, useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { Feed, Header, Hint, IconButton, Notice, Spinner, Stack } from '../ui'
import './SentenceView.css'

type Props = { view: Extract<View, { kind: 'sentence' }> }

/** Reference image 3, panel 4: the finished sentence, editable with the pencil. */
export function SentenceView({ view }: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  return (
    <Stack>
      <Header view={view} />
      <Feed />
      <div className="sentence">
        <div className="sentence__meta">
          <span className="sentence__label">Sentence</span>
          {view.thinking ? (
            <span className="sentence__thinking">
              <Spinner size={12} />
              Understanding...
            </span>
          ) : null}
        </div>
        {editing ? (
          <SentenceEditor initial={view.sentence} onDone={() => setEditing(false)} />
        ) : (
          <div className="sentence__row">
            <p className="sentence__text">{view.sentence}</p>
            <IconButton
              icon={Pencil}
              label="Edit sentence"
              variant="filled"
              size={30}
              iconSize={15}
              onClick={() => setEditing(true)}
            />
          </div>
        )}
      </div>
      <Notice />
      <Hint items={['swipe ← delete', 'swipe → continue']} />
    </Stack>
  )
}

interface EditorProps {
  initial: string
  onDone: () => void
}

/**
 * Inline keyboard edit. The overlay window is normally non-focusable (it must
 * never steal focus from the app being controlled), so it is made focusable only
 * while this editor is mounted. Enter or blur commits, Escape cancels.
 */
function SentenceEditor({ initial, onDone }: EditorProps): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const closed = useRef(false)
  const [draft, setDraft] = useState(initial)

  useEffect(() => {
    window.fastasl?.setFocusable(true)
    const el = ref.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
    return () => window.fastasl?.setFocusable(false)
  }, [])

  const finish = (commit: boolean): void => {
    if (closed.current) return
    closed.current = true
    const text = draft.trim().replace(/\s+/g, ' ')
    // An emptied field reverts instead of discarding the whole phrase.
    if (commit && text && text !== initial) controller.editSentence(text)
    onDone()
  }

  return (
    <div className="sentence__row">
      <textarea
        ref={ref}
        className="sentence__text sentence__input"
        value={draft}
        rows={1}
        spellCheck={false}
        aria-label="Edit sentence"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            finish(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(false)
          }
        }}
      />
      {/* mousedown would blur the field first; keep focus and commit on click. */}
      <span className="sentence__save" onMouseDown={(e) => e.preventDefault()}>
        <IconButton icon={Check} label="Save (Enter)" variant="filled" size={30} iconSize={16} onClick={() => finish(true)} />
      </span>
    </div>
  )
}
