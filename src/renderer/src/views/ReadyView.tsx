import type { View } from '../app/types'
import { Feed, Footer, Header, Notice, Stack } from '../ui'
import './ReadyView.css'

type Props = { view: Extract<View, { kind: 'ready' }> }

/** Reference image 3, panel 1: header, framed feed, camera + collapse. */
export function ReadyView({ view }: Props): React.JSX.Element {
  return (
    <Stack>
      <Header view={view} />
      <Feed aspect={6 / 5} brackets />
      {view.hint ? <p className="ready__hint">{view.hint}</p> : null}
      <Notice />
      <Footer />
    </Stack>
  )
}
