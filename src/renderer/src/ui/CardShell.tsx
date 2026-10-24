import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { cardWidth, type View } from '../app/types'
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

  const fixedWidth = view.kind === 'collapsed' ? undefined : cardWidth(view)
  return (
    <div
      ref={ref}
      className={`card card--${view.kind}${stage ? ' card--stage' : ''}`}
      style={fixedWidth ? { width: fixedWidth } : undefined}
    >
      <div className="card__content" key={view.kind}>
        {children}
      </div>
    </div>
  )
}
