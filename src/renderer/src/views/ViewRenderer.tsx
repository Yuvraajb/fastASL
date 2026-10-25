import { useApp } from '../app/store'
import { isChatCard, type ChatCardView, type View } from '../app/types'
import { CollapsedView } from './CollapsedView'
import { ReadyView } from './ReadyView'
import { RecognizingView } from './RecognizingView'
import { BuildingView } from './BuildingView'
import { DictationView } from './DictationView'
import { ChatView } from './ChatView'
import { WorkingView } from './WorkingView'
import { ConfirmView } from './ConfirmView'
import { ToastView } from './ToastView'
import { DidYouMeanView } from './DidYouMeanView'
import { QuickMenuView } from './QuickMenuView'
import { SettingsView } from './SettingsView'

/**
 * Renders the body of the card for the current view. In Command mode, Ready, the phrase being
 * signed, the exchange with the agent and its inline Confirm are one chat card (ChatView).
 */
export function ViewRenderer({ view }: { view: View }): React.JSX.Element {
  const mode = useApp((s) => s.mode)
  const onCall = useApp((s) => s.onCall)
  // On a video call the agent card is the compact pill; the view underneath is unchanged, so signing is still read.
  if (onCall && isChatCard(view, mode)) return <CollapsedView view={{ kind: 'collapsed' }} />
  if (isChatCard(view, mode)) return <ChatView view={view as ChatCardView} />
  switch (view.kind) {
    case 'collapsed':
      return <CollapsedView view={view} />
    case 'ready':
      return <ReadyView view={view} />
    case 'recognizing':
      return <RecognizingView view={view} />
    case 'building':
      return <BuildingView view={view} />
    case 'dictation':
      return <DictationView view={view} />
    case 'conversation':
      return <ChatView view={view} />
    case 'working':
      return <WorkingView view={view} />
    case 'confirm':
      return <ConfirmView view={view} />
    case 'toast':
      return <ToastView view={view} />
    case 'didYouMean':
      return <DidYouMeanView view={view} />
    case 'quickMenu':
      return <QuickMenuView view={view} />
    case 'settings':
      return <SettingsView view={view} />
  }
}
