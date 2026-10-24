import type { View } from '../app/types'
import { CollapsedView } from './CollapsedView'
import { ReadyView } from './ReadyView'
import { RecognizingView } from './RecognizingView'
import { BuildingView } from './BuildingView'
import { SentenceView } from './SentenceView'
import { DictationView } from './DictationView'
import { AgentReadyView } from './AgentReadyView'
import { WorkingView } from './WorkingView'
import { ConfirmView } from './ConfirmView'
import { DoneView } from './DoneView'
import { ToastView } from './ToastView'
import { DidYouMeanView } from './DidYouMeanView'
import { ContextActionsView } from './ContextActionsView'
import { QuickMenuView } from './QuickMenuView'
import { SettingsView } from './SettingsView'

/** Renders the body of the card for the current view. */
export function ViewRenderer({ view }: { view: View }): React.JSX.Element {
  switch (view.kind) {
    case 'collapsed':
      return <CollapsedView view={view} />
    case 'ready':
      return <ReadyView view={view} />
    case 'recognizing':
      return <RecognizingView view={view} />
    case 'building':
      return <BuildingView view={view} />
    case 'sentence':
      return <SentenceView view={view} />
    case 'dictation':
      return <DictationView view={view} />
    case 'agentReady':
      return <AgentReadyView view={view} />
    case 'working':
      return <WorkingView view={view} />
    case 'confirm':
      return <ConfirmView view={view} />
    case 'done':
      return <DoneView view={view} />
    case 'toast':
      return <ToastView view={view} />
    case 'didYouMean':
      return <DidYouMeanView view={view} />
    case 'contextActions':
      return <ContextActionsView view={view} />
    case 'quickMenu':
      return <QuickMenuView view={view} />
    case 'settings':
      return <SettingsView view={view} />
  }
}
