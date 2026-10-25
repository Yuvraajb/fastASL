import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useApp } from '../app/store'
import { cardWidth, isChatCard, type View } from '../app/types'
import './card.css'

interface Props {
  view: View
  stage?: boolean
  children: ReactNode
}

/**
 * The floating card. Its measured size drives the native window size (the
 * window is always exactly the card), so the main process can spring-animate it.
 */
export function CardShell({ view, stage, children }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || stage) return
    const report = (): void => {
      window.fastasl?.setCardSize({ width: Math.ceil(el.offsetWidth), height: Math.ceil(el.offsetHeight) })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [stage])

  const mode = useApp((s) => s.mode)
  const fixedWidth = view.kind === 'collapsed' ? undefined : cardWidth(view, mode)
  // Command mode's chat card stays mounted through its phases (Ready, signing, working, Confirm,
  // reply): no fade-in, feed restart or scroll reset as each word or step arrives.
  const layout = isChatCard(view, mode) ? 'chat' : view.kind
  return (
    <div
      ref={ref}
      className={`card card--${layout}${stage ? ' card--stage' : ''}`}
      style={fixedWidth ? { width: fixedWidth } : undefined}
    >
      <div className="card__content" key={layout}>
        {children}
      </div>
    </div>
  )
}
