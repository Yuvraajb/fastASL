import { ChevronRight } from 'lucide-react'
import type { Token, View } from '../app/types'
import { controller } from '../app/context'
import { ActivityBars, Divider, Feed, Footer, Header, IconButton, Notice, QuoteBox, Stack, TokenPill, TokenStrip } from '../ui'
import './BuildingView.css'

type BuildingState = Extract<View, { kind: 'building' }>
type Props = { view: BuildingState }

/** Fingerspelling shows the letter strip; anything with words shows the phrase strip. */
export function BuildingView({ view }: Props): React.JSX.Element {
  const spelling = view.tokens.length > 0 && view.tokens.every((t) => t.kind === 'letter')
  return spelling ? <LettersBuilding view={view} /> : <WordsBuilding view={view} />
}

/** Reference image 3, panel 3: big current letter over a strip of underlined letters. */
function LettersBuilding({ view }: Props): React.JSX.Element {
  const letters = view.tokens.map((t) => t.text)
  const last = letters.length - 1
  const current = view.current !== null && letters[last] === view.current ? last : null
  return (
    <Stack>
      <Header view={view} />
      <Feed brackets />
      <Stack gap={8}>
        <TokenPill variant="bare" text={view.current} />
        <Divider />
      </Stack>
      <TokenStrip variant="letters" items={letters} current={current} className="building__letters" />
      <Notice />
      <Footer listen />
    </Stack>
  )
}

/** Consecutive fingerspelled letters read as one word chip ("K R I S" -> "KRIS"). */
function phraseWords(tokens: readonly Token[]): string[] {
  const words: string[] = []
  let spelled = ''
  for (const t of tokens) {
    if (t.kind === 'letter') {
      spelled += t.text
      continue
    }
    if (spelled) words.push(spelled)
    spelled = ''
    words.push(t.text)
  }
  if (spelled) words.push(spelled)
  return words
}

/** Reference image 2, panel 3: word chips, the running sentence, activity bars and ">" to finish. */
function WordsBuilding({ view }: Props): React.JSX.Element {
  const words = phraseWords(view.tokens)
  return (
    <Stack>
      <Header view={view} />
      <Feed aspect={2} />
      <TokenStrip variant="words" items={words} current={view.current !== null ? words.length - 1 : null} />
      <QuoteBox text={view.sentence} />
      <div className="building__actions">
        <span />
        <ActivityBars />
        <IconButton icon={ChevronRight} variant="filled" label="Done signing" onClick={() => controller.tap('proceed')} />
      </div>
      <Notice />
    </Stack>
  )
}
