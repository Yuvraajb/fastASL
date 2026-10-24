import type { View } from '../app/types'
import { GestureDetailPage, GesturesPage, NewGestureHoldPage, NewGesturePickPage } from './settings/GesturePages'
import { CameraPage, RootPage, SensitivityPage } from './settings/PreferencePages'
import { TeachPickPage, TeachRecordPage, TeachShowPage, TeachSpellPage } from './settings/TeachPages'

type Props = { view: Extract<View, { kind: 'settings' }> }

/** Settings, operated by finger count (1-5) with a fist to go back. One component per page. */
export function SettingsView({ view }: Props): React.JSX.Element {
  const page = view.settings
  switch (page.page) {
    case 'root':
      return <RootPage view={view} page={page} />
    case 'teachPick':
      return <TeachPickPage view={view} page={page} />
    case 'teachSpell':
      return <TeachSpellPage view={view} page={page} />
    case 'teachRecord':
      return <TeachRecordPage view={view} page={page} />
    case 'teachShow':
      return <TeachShowPage view={view} page={page} />
    case 'newGesturePick':
      return <NewGesturePickPage view={view} page={page} />
    case 'newGestureHold':
      return <NewGestureHoldPage view={view} page={page} />
    case 'gestures':
      return <GesturesPage view={view} page={page} />
    case 'gestureDetail':
      return <GestureDetailPage view={view} page={page} />
    case 'camera':
      return <CameraPage view={view} page={page} />
    case 'sensitivity':
      return <SensitivityPage view={view} page={page} />
  }
}
