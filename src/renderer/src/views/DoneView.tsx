import { ChevronRight } from 'lucide-react'
import type { View } from '../app/types'
import { controller } from '../app/context'
import { Button, ButtonRow, CheckBadge, Feed, Header, Hint, Notice, ProgressLine, Stack } from '../ui'
import { PickLabel, useHeld, useViewInstance } from './agent-parts'
import './DoneView.css'

type Props = { view: Extract<View, { kind: 'done' }> }

/** Matches the controller's auto-collapse (DONE_AUTO_COLLAPSE_MS; failures stay twice as long). */
const AUTO_COLLAPSE_MS = 4000

const heldClass = (progress: number | null): string | undefined => (progress !== null ? 'done__btn--held' : undefined)

/**
 * Reference image 3, panel 8: thumbnail + result, View / New command.
 * Fingers 1 / 2 / 3 pick View / New command / Save as gesture (controller.optionsFor).
 */
export function DoneView({ view }: Props): React.JSX.Element {
  const instance = useViewInstance(view)
  const viewHeld = useHeld(1)
  const newHeld = useHeld(2)
  const saveHeld = useHeld(3)
  return (
    <Stack>
      <Header view={view} />
      <div className="done__row">
        <Feed variant="thumb" width={112} height={124} />
        <div className="done__result">
          <CheckBadge ok={view.ok} size={34} />
          <p className="done__title">{view.title}</p>
          {view.subtitle ? (
            <p className="done__subtitle" title={view.subtitle}>
              {view.subtitle}
            </p>
          ) : null}
          {/* Auto-collapse countdown, same line and placement as the toast's. */}
          <ProgressLine
            key={instance}
            duration={view.ok ? AUTO_COLLAPSE_MS : AUTO_COLLAPSE_MS * 2}
            width={96}
            className="done__timer"
          />
        </div>
      </div>
      <Notice />
      <ButtonRow>
        {view.view ? (
          <Button
            variant="secondary"
            stretch="flex"
            className={heldClass(viewHeld)}
            onClick={() => controller.tap('secondary')}
          >
            <PickLabel progress={viewHeld}>View</PickLabel>
          </Button>
        ) : null}
        <Button
          variant="secondary"
          // The hold ring takes the chevron's place so the label never truncates.
          icon={newHeld === null ? ChevronRight : undefined}
          stretch="flex"
          className={heldClass(newHeld)}
          onClick={() => controller.tap('primary')}
        >
          <PickLabel progress={newHeld}>New command</PickLabel>
        </Button>
      </ButtonRow>
      {view.ok ? (
        <Hint className="done__hint">
          <PickLabel progress={saveHeld}>hold 3 fingers to save as a gesture</PickLabel>
        </Hint>
      ) : null}
    </Stack>
  )
}
