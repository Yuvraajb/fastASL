import { ArrowUpRight, CalendarPlus, Copy, Ellipsis, Languages, Mail, NotebookPen, Reply, Search, Send, TextCursorInput } from 'lucide-react'
import type { View } from '../app/types'
import { Feed, Header, Notice, OptionList, Stack, type OptionItem } from '../ui'
import { iconFor, type IconRules } from './signing-menus-parts'
import './ContextActionsView.css'

type Props = { view: Extract<View, { kind: 'contextActions' }> }

/** Actions come from the agent, so icons are matched by keyword. */
const ACTION_ICONS: IconRules = [
  [/\bmore\b/i, Ellipsis],
  [/\b(insert|type|paste|write)\b/i, TextCursorInput],
  [/\breply\b/i, Reply],
  [/\b(e-?mail|mail)\b/i, Mail],
  [/\b(send|message|text)\b/i, Send],
  [/\bcopy\b/i, Copy],
  [/\b(search|look up|google)\b/i, Search],
  [/\b(event|meeting|schedule|calendar)\b/i, CalendarPlus],
  [/\bnotes?\b/i, NotebookPen],
  [/\btranslate\b/i, Languages]
]

/** Reference image 1, panel 11: what to do with the signed sentence, picked by finger count. */
export function ContextActionsView({ view }: Props): React.JSX.Element {
  const items = view.actions.map((label): OptionItem => ({
    label,
    icon: iconFor(label, ACTION_ICONS, ArrowUpRight),
    muted: /^more\b/i.test(label)
  }))
  return (
    <Stack>
      <Header view={view} close />
      <Feed aspect={2} />
      <Stack gap={8}>
        <p className="ctx__quote">“{view.sentence}”</p>
        <OptionList options={items} iconStyle="circle" badge="trailing" />
      </Stack>
      <Notice />
    </Stack>
  )
}
