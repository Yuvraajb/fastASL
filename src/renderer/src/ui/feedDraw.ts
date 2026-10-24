import type { Landmark } from '@shared/types'
import { FINGERS, HAND_CONNECTIONS } from './handConnections'

/**
 * Pure canvas drawing for the camera feed. All functions draw in CSS pixels: the
 * caller sets `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` once per frame.
 * Landmarks are MediaPipe normalized image coordinates (0..1, NOT mirrored).
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface HandLandmarks {
  landmarks: readonly Landmark[]
}

/** Where a srcW x srcH frame lands when cover-fit into dstW x dstH (centered, cropped). */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  const s = Math.max(dstW / srcW, dstH / srcH)
  const w = srcW * s
  const h = srcH * s
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h }
}

/** Landmark -> canvas point, given the rect the full source frame was drawn into. */
export function projectLandmark(p: Landmark, rect: Rect, mirrored: boolean): [number, number] {
  return [rect.x + (mirrored ? 1 - p.x : p.x) * rect.w, rect.y + p.y * rect.h]
}

export interface FrameOptions {
  mirrored?: boolean
  grayscale?: boolean
}

/** Draws a camera frame cover-fit (grayscale, mirrored by default). Returns the frame rect for drawLandmarks. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  w: number,
  h: number,
  { mirrored = true, grayscale = true }: FrameOptions = {}
): Rect {
  const rect = coverRect(srcW, srcH, w, h)
  ctx.save()
  if (grayscale) ctx.filter = 'grayscale(1) contrast(1.04)'
  if (mirrored) {
    // The cover rect is centered, so flipping the canvas keeps it in place.
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h)
  ctx.restore()
  return rect
}

export interface LandmarkOptions {
  mirrored?: boolean
  /** Rect the full source frame occupies on the canvas (from drawFrame / drawMockFrame). Defaults to the canvas. */
  rect?: Rect
  lineWidth?: number
  dotRadius?: number
  color?: string
}

/** Thin white skeleton (HAND_CONNECTIONS) and small dots for every hand. */
export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  hands: readonly HandLandmarks[],
  w: number,
  h: number,
  { mirrored = true, rect = { x: 0, y: 0, w, h }, lineWidth = 1.5, dotRadius = 1.5, color = '#ffffff' }: LandmarkOptions = {}
): void {
  if (!hands.length) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // A faint dark halo keeps the white lines readable over light skin.
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
  ctx.shadowBlur = 2 * lineWidth
  for (const hand of hands) {
    const pts = hand.landmarks.map((p) => projectLandmark(p, rect, mirrored))
    ctx.globalAlpha = 0.88
    ctx.beginPath()
    for (const [a, b] of HAND_CONNECTIONS) {
      if (!pts[a] || !pts[b]) continue
      ctx.moveTo(pts[a][0], pts[a][1])
      ctx.lineTo(pts[b][0], pts[b][1])
    }
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.beginPath()
    for (const [x, y] of pts) {
      ctx.moveTo(x + dotRadius, y)
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2)
    }
    ctx.fill()
  }
  ctx.restore()
}

export interface BracketOptions {
  inset?: number
  length?: number
  radius?: number
  lineWidth?: number
  color?: string
}

/** Viewfinder corner marks (reference image 1). */
export function drawBrackets(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  { inset = 10, length = 15, radius = 5, lineWidth = 2, color = 'rgba(255, 255, 255, 0.85)' }: BracketOptions = {}
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.beginPath()
  const corners: [number, number, number, number][] = [
    [inset, inset, 1, 1],
    [w - inset, inset, -1, 1],
    [inset, h - inset, 1, -1],
    [w - inset, h - inset, -1, -1]
  ]
  for (const [x, y, sx, sy] of corners) {
    ctx.moveTo(x, y + sy * length)
    ctx.arcTo(x, y, x + sx * length, y, radius)
    ctx.lineTo(x + sx * length, y)
  }
  ctx.stroke()
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Mock camera: a grayscale "photo" of a hand in a room, for screenshots and for
// running without a camera. Phase 2 replaces it with drawFrame(live.source).

export interface MockHandShape extends HandLandmarks {
  /** Finger thickness as a fraction of the frame width. */
  fingerWidth: number
  /** Per-finger thickness multipliers (thumb..pinky) on top of FINGER_SCALE. */
  fingerScale?: readonly number[]
}

/** Offscreen canvases reused between frames (one per Feed). */
export interface MockRenderCache {
  key: string
  backdrop: HTMLCanvasElement | null
  /** Shaded hands, the silhouette mask, its blurred copy, and contour lines. */
  layers: Record<'hand' | 'mask' | 'soft' | 'lines', HTMLCanvasElement> | null
  grain: CanvasPattern | null
}

export function createMockCache(): MockRenderCache {
  return { key: '', backdrop: null, layers: null, grain: null }
}

export interface MockFrameOptions {
  mirrored?: boolean
  dpr?: number
  /** Size of the virtual camera frame the landmarks live in. */
  frame?: { width: number; height: number }
  cache?: MockRenderCache
}

// Grayscale skin: the silhouette starts at SKIN_EDGE and a blurred copy of itself lightens
// the interior, so fingers and palm read as rounded forms.
const SKIN_EDGE = '#959597'
const CONTOUR = 'rgba(38, 38, 40, 0.42)'
/** Relative finger thickness: thumb, index, middle, ring, pinky. */
const FINGER_SCALE = [1.1, 1, 1.03, 0.96, 0.84]

type V = [number, number]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]]
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k]
const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1]
const len = (a: V): number => Math.hypot(a[0], a[1])
const unit = (a: V): V => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function prepareCache(cache: MockRenderCache, w: number, h: number, dpr: number): void {
  const key = `${w}x${h}@${dpr}`
  if (cache.key === key) return
  cache.key = key
  cache.backdrop = canvas(w * dpr, h * dpr)
  const b = cache.backdrop.getContext('2d')
  if (b) {
    b.setTransform(dpr, 0, 0, dpr, 0, 0)
    paintBackdrop(b, w, h)
  }
  cache.layers = {
    hand: canvas(w * dpr, h * dpr),
    mask: canvas(w * dpr, h * dpr),
    soft: canvas(w * dpr, h * dpr),
    lines: canvas(w * dpr, h * dpr)
  }
  if (!cache.grain) {
    const n = canvas(96, 96)
    const g = n.getContext('2d')
    if (g) {
      const img = g.createImageData(96, 96)
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v
        img.data[i + 3] = 255
      }
      g.putImageData(img, 0, 0)
      cache.grain = g.createPattern(n, 'repeat')
    }
  }
}

/** A plain room wall: mid gray, lit from the upper right, darker side wall and ceiling. */
function paintBackdrop(c: CanvasRenderingContext2D, w: number, h: number): void {
  const m = Math.max(w, h)
  const wall = c.createLinearGradient(0, 0, 0, h)
  wall.addColorStop(0, '#5b5d60')
  wall.addColorStop(0.45, '#77797c')
  wall.addColorStop(1, '#55575a')
  c.fillStyle = wall
  c.fillRect(0, 0, w, h)

  const light = c.createRadialGradient(w * 0.6, h * 0.32, 0, w * 0.6, h * 0.32, m * 0.75)
  light.addColorStop(0, 'rgba(255, 255, 255, 0.14)')
  light.addColorStop(1, 'rgba(255, 255, 255, 0)')
  c.fillStyle = light
  c.fillRect(0, 0, w, h)

  // Room corner: a darker side wall on the left, a lighter door frame on the right.
  const side = c.createLinearGradient(0, 0, w * 0.22, 0)
  side.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
  side.addColorStop(0.75, 'rgba(0, 0, 0, 0.16)')
  side.addColorStop(1, 'rgba(0, 0, 0, 0)')
  c.fillStyle = side
  c.fillRect(0, 0, w * 0.22, h)
  const frame = c.createLinearGradient(w * 0.84, 0, w, 0)
  frame.addColorStop(0, 'rgba(255, 255, 255, 0)')
  frame.addColorStop(0.35, 'rgba(255, 255, 255, 0.08)')
  frame.addColorStop(0.5, 'rgba(0, 0, 0, 0.08)')
  frame.addColorStop(1, 'rgba(0, 0, 0, 0.16)')
  c.fillStyle = frame
  c.fillRect(w * 0.84, 0, w * 0.16, h)

  const ceiling = c.createLinearGradient(0, 0, 0, h * 0.22)
  ceiling.addColorStop(0, 'rgba(0, 0, 0, 0.24)')
  ceiling.addColorStop(1, 'rgba(0, 0, 0, 0)')
  c.fillStyle = ceiling
  c.fillRect(0, 0, w, h * 0.22)

  // Out-of-focus chair back in the lower left.
  c.save()
  c.filter = `blur(${m * 0.03}px)`
  c.fillStyle = 'rgba(28, 28, 30, 0.45)'
  c.beginPath()
  c.roundRect(w * -0.02, h * 0.72, w * 0.2, h * 0.4, m * 0.04)
  c.fill()
  c.restore()
}

interface FingerShape {
  chain: V[]
  width: number
  thumb: boolean
}

/** Canvas-space shapes for one hand: palm polygon, forearm outline, fingers far-to-near. */
interface HandShape {
  palm: V[]
  puff: number
  /** See traceArm for the point order. */
  arm: V[]
  wrist: V
  far: V
  fingers: FingerShape[]
  fw: number
}

const TAPER = [1, 0.9, 0.78]
const THUMB_TAPER = [1.45, 1.02, 0.92]

function handShape(pts: V[], z: number[], fw: number, reach: number, fingerScale?: readonly number[]): HandShape {
  const wrist = pts[0]
  const toWrist = unit(sub(wrist, pts[9]))
  let side: V = [-toWrist[1], toWrist[0]]
  if (dot(sub(pts[1], wrist), side) < 0) side = mul(side, -1)
  const armW = fw * 2.9
  const puff = fw * 0.9
  const inset = armW / 2 - puff / 2
  // Web between thumb and index dips toward the wrist.
  const web = add(lerp(pts[2], pts[5], 0.5), mul(toWrist, 0.22 * len(sub(pts[2], pts[5]))))
  const palm = [add(wrist, mul(side, inset)), pts[1], pts[2], web, pts[5], pts[9], pts[13], pts[17], sub(wrist, mul(side, inset))]
  const far = add(wrist, mul(toWrist, reach))
  // Narrow at the wrist, a soft muscle swell over the first few finger widths, then
  // nearly parallel sides out of frame.
  const at = (d: number, half: number): V => add(add(wrist, mul(toWrist, d)), mul(side, half))
  const swell = armW / 2 + fw * 0.34
  const arm = [
    at(0, armW / 2),
    at(fw * 2.2, swell),
    at(fw * 5, swell),
    at(reach, armW * 0.7),
    at(reach, -armW * 0.7),
    at(fw * 5, -swell),
    at(fw * 2.2, -swell),
    at(0, -armW / 2)
  ]
  // Farthest first (MediaPipe z: smaller = nearer the camera).
  const fingers = FINGERS.map((idx, i) => ({
    chain: idx.map((j) => pts[j]),
    width: fw * FINGER_SCALE[i] * (fingerScale?.[i] ?? 1),
    thumb: i === 0,
    depth: idx.reduce((s, j) => s + (z[j] ?? 0), 0) / idx.length
  }))
    .sort((a, b) => b.depth - a.depth)
    .map(({ chain, width, thumb }) => ({ chain, width, thumb }))
  return { palm, puff, arm, wrist, far, fingers, fw }
}

function tracePolygon(c: CanvasRenderingContext2D, poly: V[]): void {
  c.beginPath()
  poly.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
  c.closePath()
}

/** Forearm: [wrist, swell control, swell end, far] down one side, then back up the other. */
function traceArm(c: CanvasRenderingContext2D, [w0, c0, m0, f0, f1, m1, c1, w1]: V[]): void {
  c.beginPath()
  c.moveTo(w0[0], w0[1])
  c.quadraticCurveTo(c0[0], c0[1], m0[0], m0[1])
  c.lineTo(f0[0], f0[1])
  c.lineTo(f1[0], f1[1])
  c.lineTo(m1[0], m1[1])
  c.quadraticCurveTo(c1[0], c1[1], w1[0], w1[1])
  c.closePath()
}

function strokeSegment(c: CanvasRenderingContext2D, a: V, b: V, width: number): void {
  c.lineWidth = width
  c.beginPath()
  c.moveTo(a[0], a[1])
  c.lineTo(b[0], b[1])
  c.stroke()
}

/**
 * Strokes a finger's three segments. `from` starts the first segment part-way along it;
 * `minLength` (in finger widths) skips foreshortened segments, e.g. a curled phalanx
 * pointing at the camera, whose round-capped outline would read as a ring.
 */
function strokeFinger(c: CanvasRenderingContext2D, f: FingerShape, extra = 0, from = 0, minLength = 0): void {
  const taper = f.thumb ? THUMB_TAPER : TAPER
  for (let k = 0; k < 3; k++) {
    const a = k === 0 && from ? lerp(f.chain[0], f.chain[1], from) : f.chain[k]
    const width = f.width * taper[k]
    if (minLength && len(sub(f.chain[k + 1], f.chain[k])) < minLength * width) continue
    strokeSegment(c, a, f.chain[k + 1], width + extra)
  }
}

/** The hand as one opaque shape in `color`. */
function fillSilhouette(c: CanvasRenderingContext2D, s: HandShape, color: string): void {
  c.fillStyle = color
  c.strokeStyle = color
  c.lineCap = 'round'
  c.lineJoin = 'round'
  traceArm(c, s.arm)
  c.fill()
  tracePolygon(c, s.palm)
  c.lineWidth = s.puff
  c.stroke()
  c.fill()
  for (const f of s.fingers) strokeFinger(c, f)
}

/**
 * Contours with occlusion: each nearer finger erases what it covers, then keeps its own outline.
 */
function drawContours(c: CanvasRenderingContext2D, s: HandShape, edge: number): void {
  c.lineCap = 'round'
  c.lineJoin = 'round'
  for (const f of s.fingers) {
    c.globalCompositeOperation = 'destination-out'
    c.strokeStyle = '#000'
    strokeFinger(c, f)
    c.globalCompositeOperation = 'source-over'
    // Outline only: draw a wider stroke, then cut the body back out of it.
    c.save()
    c.strokeStyle = CONTOUR
    strokeFinger(c, f, edge * 2, 0.5, 1.2)
    c.globalCompositeOperation = 'destination-out'
    c.strokeStyle = '#000'
    strokeFinger(c, f)
    c.restore()
  }
}

function clear(c: CanvasRenderingContext2D, dpr: number): void {
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalCompositeOperation = 'source-over'
  c.globalAlpha = 1
  c.filter = 'none'
  c.clearRect(0, 0, c.canvas.width, c.canvas.height)
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/**
 * Renders shaded hands into the cache's hand layer:
 * silhouette in a dark skin tone -> lightened by its own blurred copy (rounded forms)
 * -> contours -> top light / forearm falloff.
 */
function renderHands(layers: NonNullable<MockRenderCache['layers']>, shapes: HandShape[], w: number, h: number, dpr: number): boolean {
  const hand = layers.hand.getContext('2d')
  const mask = layers.mask.getContext('2d')
  const soft = layers.soft.getContext('2d')
  const lines = layers.lines.getContext('2d')
  if (!hand || !mask || !soft || !lines) return false
  for (const c of [hand, mask, soft, lines]) clear(c, dpr)

  for (const s of shapes) fillSilhouette(mask, s, '#ffffff')
  const fw = shapes[0].fw
  soft.filter = `blur(${Math.max(0.6, fw * 0.3) * dpr}px)` // device px, like shadows
  soft.drawImage(layers.mask, 0, 0, w, h)
  soft.filter = 'none'
  const edge = 1.3 * Math.min(1, fw / 8)
  for (const s of shapes) drawContours(lines, s, edge)

  // Canvas filters are never combined with source-atop here: Chromium would blur the whole layer.
  hand.drawImage(layers.mask, 0, 0, w, h)
  hand.globalCompositeOperation = 'source-in'
  hand.fillStyle = SKIN_EDGE
  hand.fillRect(0, 0, w, h)
  hand.globalCompositeOperation = 'source-atop'
  // Offset toward the light (upper left) so the far side of each form stays darker.
  hand.globalAlpha = 0.52
  hand.drawImage(layers.soft, -fw * 0.12, -fw * 0.16, w, h)
  hand.globalAlpha = 1
  hand.drawImage(layers.lines, 0, 0, w, h)

  const light = hand.createLinearGradient(0, 0, 0, h)
  light.addColorStop(0, 'rgba(255, 255, 255, 0.12)')
  light.addColorStop(0.5, 'rgba(255, 255, 255, 0)')
  light.addColorStop(1, 'rgba(0, 0, 0, 0.22)')
  hand.fillStyle = light
  hand.fillRect(0, 0, w, h)
  for (const s of shapes) {
    // The forearm falls off into shadow away from the hand.
    const along = hand.createLinearGradient(s.wrist[0], s.wrist[1], s.far[0], s.far[1])
    const d = len(sub(s.far, s.wrist))
    along.addColorStop(0, 'rgba(0, 0, 0, 0)')
    along.addColorStop(Math.min(1, (s.fw * 9) / d), 'rgba(0, 0, 0, 0.22)')
    along.addColorStop(1, 'rgba(0, 0, 0, 0.22)')
    hand.fillStyle = along
    traceArm(hand, s.arm)
    hand.fill()
  }
  hand.globalCompositeOperation = 'source-over'
  return true
}

/**
 * Draws the mock camera image (room + grayscale hands) for `hands`.
 * Returns the frame rect so landmarks can be drawn on top with drawLandmarks.
 */
export function drawMockFrame(
  ctx: CanvasRenderingContext2D,
  hands: readonly MockHandShape[],
  w: number,
  h: number,
  { mirrored = true, dpr = 1, frame = { width: 640, height: 480 }, cache = createMockCache() }: MockFrameOptions = {}
): Rect {
  const rect = coverRect(frame.width, frame.height, w, h)
  prepareCache(cache, w, h, dpr)
  if (cache.backdrop) ctx.drawImage(cache.backdrop, 0, 0, w, h)

  if (cache.layers && hands.length) {
    const shapes = hands.map((hand) =>
      handShape(
        hand.landmarks.map((p) => projectLandmark(p, rect, mirrored)),
        hand.landmarks.map((p) => p.z),
        hand.fingerWidth * rect.w,
        w + h,
        hand.fingerScale
      )
    )
    if (renderHands(cache.layers, shapes, w, h, dpr)) {
      ctx.save()
      // Shadow and filter sizes ignore the canvas transform, so they are given in device pixels.
      const fw = shapes[0].fw
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
      ctx.shadowBlur = Math.max(2, fw * 0.8) * dpr
      ctx.shadowOffsetY = Math.max(1, fw * 0.25) * dpr
      // A touch of lens softness so the silhouette doesn't read as a vector cutout.
      ctx.filter = `blur(${0.4 * dpr}px)`
      ctx.drawImage(cache.layers.hand, 0, 0, w, h)
      ctx.restore()
    }
  }

  // Lens vignette and a little grain so it reads as a photo.
  const m = Math.max(w, h)
  const vignette = ctx.createRadialGradient(w / 2, h * 0.45, m * 0.32, w / 2, h * 0.45, m * 0.85)
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.3)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, w, h)
  if (cache.grain) {
    ctx.save()
    ctx.globalAlpha = 0.035
    ctx.fillStyle = cache.grain
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }
  return rect
}
