import type { View } from '../app/types'
import { ActivityBars, Feed, Footer, Header, Notice, Stack, TokenPill } from '../ui'

type Props = { view: Extract<View, { kind: 'recognizing' }> }

/**
 * Listening (no token yet): activity bars in the token pill (reference image 2, panel 2).
 * Letter: big letter in the pill (reference image 3, panel 2).
 * Word: quoted word with activity bars under it (reference image 1, panel 2).
 * The viewfinder brackets stay on from ready through the signing states (ref1).
 */
export function RecognizingView({ view }: Props): React.JSX.Element {
  const { token, isWord } = view
  return (
    <Stack>
      <Header view={view} />
      <Feed aspect={4 / 3} brackets />
      {token === null ? (
        <TokenPill>
          <ActivityBars />
        </TokenPill>
      ) : isWord ? (
        <Stack gap={8} align="center">
          <TokenPill text={token} quoted fit />
          <ActivityBars height={24} />
        </Stack>
      ) : (
        <TokenPill text={token} />
      )}
      <Notice />
      <Footer micOff />
    </Stack>
  )
}
