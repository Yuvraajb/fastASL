import { Calendar, Mail, MessageSquare, Sparkles, ThumbsUp } from 'lucide-react'
import type { ConfirmDetails } from '@shared/types'
import { controller } from '../app/context'
import { useApp, type ChatAgent } from '../app/store'
import { CheckBadge, StepsList } from '../ui'
import './ChatAgent.css'

/** SIGN -> ENGLISH -> ACTION: lights up as the idea moves through the app, so a viewer sees it at a glance. */
export function PipelineStrip(): React.JSX.Element {
  const listening = useApp((s) => s.listening)
  const draft = useApp((s) => s.chat.draft)
  const busy = useApp((s) => s.chat.busy)
  const acting = useApp((s) => s.chat.messages.at(-1)?.agent)
  const waiting = Boolean(acting && (acting.ask || acting.confirm))
  const stage = busy || waiting ? 2 : draft.trim() ? 1 : listening ? 0 : -1
  const stages = ['SIGN', 'ENGLISH', 'ACTION']
  return (
    <ol className="pipeline" aria-label="Sign to English to action">
      {stages.map((name, i) => (
        <li key={name} className={`pipeline__stage${i === stage ? ' pipeline__stage--live' : ''}${i < stage ? ' pipeline__stage--past' : ''}`}>
          <span className="pipeline__dot" aria-hidden />
          {name}
        </li>
      ))}
    </ol>
  )
}

function ConfirmIcon({ details }: { details: ConfirmDetails }): React.JSX.Element {
  const Icon = details.kind === 'event' ? Calendar : details.kind === 'mail' ? Mail : details.kind === 'message' ? MessageSquare : Sparkles
  return <Icon size={18} strokeWidth={1.9} aria-hidden />
}

function confirmLines(d: ConfirmDetails): { title: string; sub: string } {
  switch (d.kind) {
    case 'event':
      return { title: d.title, sub: `${d.dateLabel} · ${d.timeLabel}${d.guestsLabel ? ` · ${d.guestsLabel}` : ''}` }
    case 'mail':
      return { title: `Email to ${d.to}`, sub: d.subject }
    case 'message':
      return { title: `Message to ${d.to}`, sub: d.text }
    default:
      return { title: d.title, sub: d.lines.join(' · ') }
  }
}

/** What the agent is doing for one chat message: live steps, its question, the one-line confirm, the result. */
export function AgentBubble({ agent, live }: { agent: ChatAgent; live: boolean }): React.JSX.Element | null {
  const { steps, ask, confirm, result } = agent
  if (!steps.length && !ask && !confirm && !result) return null
  return (
    <div className={`agent${live ? ' agent--live' : ''}`}>
      {steps.length > 0 ? <StepsList steps={steps} className="agent__steps" /> : null}
      {ask ? (
        <div className="agent__ask" role="group" aria-label={ask.question}>
          {ask.options.map((option, i) => (
            <button key={option} type="button" className="agent__option" onClick={() => controller.chatAnswer(i)}>
              <span className="agent__num">{i + 1}</span>
              <span className="agent__optlabel">{option}</span>
            </button>
          ))}
          <span className="agent__askhint">sign the number</span>
        </div>
      ) : null}
      {confirm ? (
        <div className="agent__confirm">
          <span className="agent__ficon">
            <ConfirmIcon details={confirm.details} />
          </span>
          <span className="agent__ftext">
            <span className="agent__ftitle">{confirmLines(confirm.details).title}</span>
            <span className="agent__fsub">{confirmLines(confirm.details).sub}</span>
          </span>
          <button type="button" className="agent__go" onClick={() => controller.chatRespond(true)} aria-label="Go (thumbs up)">
            <ThumbsUp size={14} strokeWidth={2} aria-hidden /> Go
          </button>
        </div>
      ) : null}
      {result ? (
        <div className={`agent__result${result.ok ? '' : ' agent__result--fail'}`}>
          <CheckBadge size={22} ok={result.ok} />
          <span className="agent__ftext">
            <span className="agent__ftitle">{result.title}</span>
            {result.subtitle ? <span className="agent__fsub">{result.subtitle}</span> : null}
          </span>
        </div>
      ) : null}
    </div>
  )
}
