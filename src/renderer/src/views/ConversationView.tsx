import { Hand, HandFist, ThumbsUp } from 'lucide-react'
import type { AgentStep, ViewAction } from '@shared/types'
import type { Answer, View } from '../app/types'
import { controller } from '../app/context'
import { imagePath } from '../app/controller'
import { CheckBadge, Feed, Header, Hint, Notice, Stack, StepsList, type HintItem } from '../ui'
import { visibleSteps } from './visibleSteps'
import './ConversationView.css'

type Conversation = Extract<View, { kind: 'conversation' }>
type Props = { view: Conversation }

/** While the interpreter reads the phrase, before the agent's own steps. */
const UNDERSTANDING: AgentStep[] = [{ id: 'understanding', label: 'Understanding', status: 'current' }]
/** A reply longer than this drops to the result size, so two sentences still fit. */
const LONG_REPLY = 90

/**
 * Command mode's exchange with the agent, in the Working and Done cards' language: header, feed,
 * what the user signed (small, "You"), then the agent's live steps and, once it answers, its reply
 * in large type, or the result of what it did with its own line under it.
 */
export function ConversationView({ view }: Props): React.JSX.Element {
  const answer = view.phase === 'reply' ? view.answer : undefined
  return (
    <Stack>
      <Header view={view} close />
      <Feed aspect={2.4} />
      <div className="conv__said">
        <span className="conv__who">{view.prefix ? `You · ${view.prefix}` : 'You'}</span>
        <p className="conv__said-text" title={view.said}>
          “{view.said}”
        </p>
      </div>
      {answer ? (
        <AnswerBlock answer={answer} />
      ) : (
        <StepsList steps={view.phase === 'understanding' ? UNDERSTANDING : visibleSteps(view.steps)} className="conv__steps" />
      )}
      <Notice />
      <Hint items={hintFor(view, answer)} />
    </Stack>
  )
}

/** The agent's words (no tool ran), or what it did: badge, title and subtitle from the tools, a screenshot, its own line. */
function AnswerBlock({ answer }: { answer: Answer }): React.JSX.Element {
  if (answer.title === undefined) {
    const text = answer.text ?? ''
    return (
      <div className="conv__reply">
        <span className="conv__who">Agent</span>
        <p className={`conv__reply-text${text.length > LONG_REPLY ? ' conv__reply-text--long' : ''}`} role="status">
          {text}
        </p>
      </div>
    )
  }
  // A screenshot takes the badge's place, the Done card's thumbnail row: the picture, then what it is.
  return (
    <div className="conv__answer">
      <div className="conv__result" role="status">
        {answer.thumb ? (
          <button type="button" className="conv__thumb" title="Open in Preview" onClick={() => controller.tap('primary')}>
            <img src={answer.thumb} alt="Screenshot" draggable={false} />
          </button>
        ) : (
          <CheckBadge ok={answer.ok} size={26} />
        )}
        <div className="conv__result-body">
          <p className="conv__title">{answer.title}</p>
          {answer.subtitle ? (
            <p className={`conv__subtitle${answer.thumb ? ' conv__subtitle--file' : ''}`} title={answer.subtitle}>
              {answer.subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {answer.text ? <p className={`conv__note${answer.thumb ? '' : ' conv__note--under-title'}`}>{answer.text}</p> : null}
    </div>
  )
}

/** What a thumbs up opens, in the hint. */
function openLabel(view: ViewAction): string {
  switch (view.kind) {
    case 'openFile':
      return imagePath(view) ? 'open in Preview' : 'open the file'
    case 'openApp':
      return `open ${view.app}`
    case 'openUrl':
      return 'open in the browser'
  }
}

function hintFor(view: Conversation, answer: Answer | undefined): HintItem[] {
  if (view.phase !== 'reply') return [{ icon: HandFist, label: 'fist to stop' }]
  const reply: HintItem = { icon: Hand, label: 'sign to reply' }
  if (answer?.view) return [{ icon: ThumbsUp, label: openLabel(answer.view) }, reply]
  return [reply, { icon: HandFist, label: 'hide' }]
}
