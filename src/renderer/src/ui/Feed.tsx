import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { CameraOff } from 'lucide-react'
import { useApp } from '../app/store'
import { live } from '../app/live'
import { animateMockHands, MOCK_FRAME } from './mockHands'
import { createMockCache, drawBrackets, drawFrame, drawLandmarks, drawMockFrame } from './feedDraw'
import { prefersReducedMotion, useAnimationFrame } from './useAnimationFrame'
import './Feed.css'

export type FeedVariant = 'full' | 'thumb' | 'round'

export interface FeedProps {
  /** full = card-wide feed (default), thumb = small rounded tile, round = circle (collapsed pill). */
  variant?: FeedVariant
  /** full only: width / height. Default 16 / 10. */
  aspect?: number
  /** thumb only: px. Default 96 x 96. */
  width?: number
  height?: number
  /** round only: diameter px. Default 28. */
  size?: number
  /** Viewfinder corner marks. */
  brackets?: boolean
  /** Red recording dot top-left (dictation). */
  recording?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * Live camera feed: grayscale, mirrored, MediaPipe landmarks on top. Without a
 * camera (live.mock) it renders a mock hand for live.mockPose. Draws in rAF from
 * the mutable `live` object, never through React state.
 */
export function Feed({
  variant = 'full',
  aspect = 16 / 10,
  width = 96,
  height,
  size = 28,
  brackets = false,
  recording = false,
  className,
  style
}: FeedProps): React.JSX.Element {
  const cameraOn = useApp((s) => s.cameraOn)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const box = useRef({ w: 0, h: 0 })
  const cache = useRef(createMockCache())
  const [error, setError] = useState<string | null>(live.error)

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      box.current = { w: entry.contentRect.width, h: entry.contentRect.height }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [cameraOn])

  useAnimationFrame((t) => {
    if (live.error !== error) setError(live.error)
    const el = canvasRef.current
    const { w, h } = box.current
    if (!el || !w || !h) return
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(w * dpr)
    const ph = Math.round(h * dpr)
    if (el.width !== pw || el.height !== ph) {
      el.width = pw
      el.height = ph
    }
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // Thinner skeleton on small tiles; none on the tiny round thumbnail.
    const k = Math.min(1, Math.max(0.5, w / 240))
    const marks = { lineWidth: 1.5 * k, dotRadius: 1.6 * k }
    const showLandmarks = variant !== 'round'
    if (live.mock) {
      const hands = animateMockHands(live.mockPose, prefersReducedMotion() ? 0 : t)
      const rect = drawMockFrame(ctx, hands, w, h, { dpr, frame: MOCK_FRAME, cache: cache.current })
      if (showLandmarks) drawLandmarks(ctx, hands, w, h, { rect, ...marks })
    } else if (live.source && live.sourceWidth > 0) {
      const rect = drawFrame(ctx, live.source, live.sourceWidth, live.sourceHeight, w, h)
      if (showLandmarks) drawLandmarks(ctx, live.hands, w, h, { rect, ...marks })
    }
    if (brackets) drawBrackets(ctx, w, h)
  }, cameraOn)

  const sizeStyle: CSSProperties =
    variant === 'full'
      ? { aspectRatio: String(aspect) }
      : variant === 'thumb'
        ? { width, height: height ?? width }
        : { width: size, height: size }

  return (
    <div className={`feed feed--${variant}${className ? ` ${className}` : ''}`} style={{ ...sizeStyle, ...style }}>
      {cameraOn ? (
        <canvas ref={canvasRef} className="feed__canvas" aria-label="Camera feed" />
      ) : (
        <div className="feed__off">
          <CameraOff size={variant === 'round' ? 12 : variant === 'thumb' ? 18 : 22} strokeWidth={1.75} />
          {variant === 'full' ? <span>Camera off</span> : null}
        </div>
      )}
      {cameraOn && error && variant !== 'round' ? <div className="feed__error">{error}</div> : null}
      {recording ? <span className="feed__rec" aria-label="Recording" /> : null}
    </div>
  )
}
