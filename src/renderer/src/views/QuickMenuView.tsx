import { AppWindow, CalendarPlus, MessageSquare, NotebookPen, Search, Sparkles } from 'lucide-react'
import type { View } from '../app/types'
import { ActivityBars, Header, Hint, Notice, OptionList, SectionTitle, Stack, type OptionItem } from '../ui'
import { iconFor, type IconRules } from './signing-menus-parts'
import './QuickMenuView.css'

type Props = { view: Extract<View, { kind: 'quickMenu' }> }

const MENU_ICONS: IconRules = [
  [/\b(event|meeting|calendar)\b/i, CalendarPlus],
  [/\b(message|text|chat)\b/i, MessageSquare],
  [/\bsearch\b/i, Search],
  [/\bnotes?\b/i, NotebookPen],
  [/\b(open|app)\b/i, AppWindow]
]

/** Reference image 2, panel 9: thumbs-up from Ready opens the shortcuts, picked by finger count. */
export function QuickMenuView({ view }: Props): React.JSX.Element {
  const items = view.options.map((label): OptionItem => ({ label, icon: iconFor(label, MENU_ICONS, Sparkles) }))
  return (
    <Stack>
      <Header view={view} close />
      <Stack gap={8}>
        <SectionTitle>What would you like to do?</SectionTitle>
        <OptionList options={items} badge="trailing" />
      </Stack>
      <Notice />
      <Stack gap={6} align="center" className="qmenu__footer">
        <ActivityBars height={16} />
        <Hint items={[`hold up 1–${items.length} fingers`]} />
      </Stack>
    </Stack>
  )
}
