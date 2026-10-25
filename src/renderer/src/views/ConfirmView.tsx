import {
  Calendar,
  Check,
  FileText,
  HandFist,
  Mail,
  MessageSquare,
  ThumbsUp,
  type LucideIcon
} from 'lucide-react'
import type { ConfirmDetails } from '@shared/types'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { Button, ButtonRow, Feed, Header, Hint, Notice, Stack } from '../ui'
import { DetailPanel } from './agent-parts'
import './ConfirmView.css'

type Props = { view: Extract<View, { kind: 'confirm' }> }

const ICONS: Record<ConfirmDetails['kind'], LucideIcon> = {
  event: Calendar,
  mail: Mail,
  message: MessageSquare,
  generic: FileText
}

/** Title + lines for each kind of action the agent wants approved. */
function DetailLines({ details }: { details: ConfirmDetails }): React.JSX.Element {
  switch (details.kind) {
    case 'event':
      return (
        <>
          <p className="detail__title">{details.title}</p>
          {[details.dateLabel, details.timeLabel, details.guestsLabel, details.videoLabel]
            .filter((line): line is string => Boolean(line))
            .map((line, i) => (
              <p key={i} className="detail__line">
                {line}
              </p>
            ))}
        </>
      )
    case 'mail':
      return (
        <>
          <p className="detail__title detail__title--addr" title={`To ${details.to}`}>
            {details.to}
          </p>
          {details.subject ? <p className="detail__line">{details.subject}</p> : null}
          <p className="detail__line detail__line--clamp detail__line--dim">{details.body}</p>
          {details.attachments?.length ? <p className="detail__line">Attached: {details.attachments.join(', ')}</p> : null}
        </>
      )
    case 'message':
      return (
        <>
          <p className="detail__title detail__title--addr" title={`To ${details.to}`}>
            {details.to}
          </p>
          <p className="detail__line detail__line--clamp confirm__message">{details.text}</p>
        </>
      )
    case 'generic':
      return (
        <>
          <p className="detail__title">{details.title}</p>
          {details.lines.map((line, i) => (
            <p key={i} className="detail__line">
              {line}
            </p>
          ))}
        </>
      )
  }
}

/** Reference image 3, panel 7: details box + thumbnail feed side by side, Cancel / Confirm. */
export function ConfirmView({ view }: Props): React.JSX.Element {
  return (
    <Stack>
      <Header view={view} />
      <div className="confirm__row">
        <DetailPanel icon={ICONS[view.details.kind]} className="confirm__details">
          <DetailLines details={view.details} />
        </DetailPanel>
        <Feed variant="thumb" width={104} className="confirm__feed" style={{ height: 'auto' }} />
      </div>
      <Notice />
      <ButtonRow>
        <Button variant="secondary" stretch="flex" onClick={() => controller.tap('secondary')}>
          Cancel
        </Button>
        <Button icon={Check} stretch="flex" onClick={() => controller.tap('primary')}>
          Confirm
        </Button>
      </ButtonRow>
      <Hint
        items={[
          { icon: ThumbsUp, label: 'confirm' },
          { icon: HandFist, label: 'cancel' }
        ]}
      />
    </Stack>
  )
}
