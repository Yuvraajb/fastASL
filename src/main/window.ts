import { BrowserWindow, screen, systemPreferences } from 'electron'
import { join } from 'path'
import type { CardSize } from '@shared/ipc'

/** Gap between the card and the menu bar / right screen edge. */
const EDGE_GAP = 12
const DEFAULT_SIZE: CardSize = { width: 300, height: 268 }

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function prefersReducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}

/** Bounds for a card of `size`, anchored top-right of the display the window is on. */
function anchoredBounds(win: BrowserWindow | null, size: CardSize): Rect {
  const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  const area = display.workArea
  const width = Math.round(size.width)
  const height = Math.round(size.height)
  return {
    x: Math.round(area.x + area.width - width - EDGE_GAP),
    y: Math.round(area.y + EDGE_GAP),
    width,
    height
  }
}

/**
 * Critically damped spring on the window bounds (~200ms settle). macOS's own
 * `setBounds(_, true)` animation is linear and can't be interrupted cleanly, so
 * we step it ourselves at 60Hz.
 */
class BoundsSpring {
  private current: Rect
  private velocity: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private target: Rect
  private timer: NodeJS.Timeout | null = null
  private lastTick = 0
  private static readonly OMEGA = 29 // rad/s -> ~98% settled after 200ms
  onSettle: (() => void) | null = null

  constructor(private readonly win: BrowserWindow) {
    this.current = win.getBounds()
    this.target = this.current
  }

  animateTo(target: Rect): void {
    this.target = target
    if (prefersReducedMotion() || !this.win.isVisible()) {
      this.stop()
      this.current = target
      this.velocity = { x: 0, y: 0, width: 0, height: 0 }
      this.win.setBounds(target)
      this.onSettle?.()
      return
    }
    if (!this.timer) {
      this.current = this.win.getBounds()
      this.lastTick = performance.now()
      this.timer = setInterval(() => this.tick(), 1000 / 60)
    }
  }

  private tick(): void {
    if (this.win.isDestroyed()) return this.stop()
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastTick) / 1000)
    this.lastTick = now
    const w = BoundsSpring.OMEGA
    let settled = true
    const keys: (keyof Rect)[] = ['x', 'y', 'width', 'height']
    const next = { ...this.current }
    for (const k of keys) {
      const x = this.current[k] - this.target[k]
      const v = this.velocity[k]
      // Exact critically-damped step: x(t) = (x0 + (v0 + w x0) t) e^{-wt}
      const e = Math.exp(-w * dt)
      const nx = (x + (v + w * x) * dt) * e
      const nv = (v - w * (v + w * x) * dt) * e
      next[k] = this.target[k] + nx
      this.velocity[k] = nv
      if (Math.abs(nx) > 0.5 || Math.abs(nv) > 5) settled = false
    }
    this.current = next
    if (settled) {
      this.current = this.target
      this.win.setBounds(this.target)
      this.stop()
      this.onSettle?.()
      return
    }
    // Keep the right edge pinned exactly so the card never "wobbles" horizontally.
    const right = this.target.x + this.target.width
    const width = Math.round(next.width)
    this.win.setBounds({ x: right - width, y: Math.round(next.y), width, height: Math.round(next.height) })
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export interface OverlayWindow {
  win: BrowserWindow
  setCardSize(size: CardSize): void
  setFocusable(focusable: boolean): void
}

export function createOverlayWindow(opts: { dev: boolean; screenshots: boolean; mockServices: boolean }): OverlayWindow {
  // Native vibrancy is opt-in: Electron masks the vibrancy view with a fixed 9pt
  // corner radius, which can't match the 22px card. See DECISIONS.md.
  const vibrancy = process.env.FASTASL_VIBRANCY?.trim()
  const useVibrancy = vibrancy === 'hud' || vibrancy === 'popover' || vibrancy === '1'
  const initial = anchoredBounds(null, DEFAULT_SIZE)
  const additionalArguments: string[] = []
  if (opts.dev) additionalArguments.push('--fastasl-dev')
  if (opts.screenshots) additionalArguments.push('--fastasl-screenshots')
  if (useVibrancy) additionalArguments.push('--fastasl-vibrancy')
  if (opts.mockServices) additionalArguments.push('--fastasl-mock')

  const win = new BrowserWindow({
    ...initial,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // NSPanel: floats over full-screen apps and never steals focus from the app you're using.
    type: 'panel',
    ...(useVibrancy
      ? { vibrancy: vibrancy === 'popover' ? ('popover' as const) : ('hud' as const), visualEffectState: 'active' as const }
      : {}),
    roundedCorners: true,
    hasShadow: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    title: 'fastASL',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      additionalArguments
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  // skipTransformProcessType: the dock icon is already hidden via app.dock.hide().
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

  const spring = new BoundsSpring(win)
  // Transparent windows get their native shadow from the content's alpha; recompute it
  // whenever the card settles at a new size.
  spring.onSettle = () => {
    if (!win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.invalidateShadow(), 30)
  }
  let lastSize: CardSize = DEFAULT_SIZE

  // Keep the anchor correct when displays / the menu bar change.
  const reanchor = (): void => {
    if (!win.isDestroyed()) win.setBounds(anchoredBounds(win, lastSize))
  }
  screen.on('display-metrics-changed', reanchor)
  screen.on('display-added', reanchor)
  screen.on('display-removed', reanchor)
  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', reanchor)
    screen.removeListener('display-added', reanchor)
    screen.removeListener('display-removed', reanchor)
  })

  win.once('ready-to-show', () => win.showInactive())

  return {
    win,
    setCardSize(size) {
      if (!size || !(size.width > 0) || !(size.height > 0)) return
      if (Math.abs(size.width - lastSize.width) < 1 && Math.abs(size.height - lastSize.height) < 1) return
      lastSize = size
      spring.animateTo(anchoredBounds(win, size))
    },
    setFocusable(focusable) {
      win.setFocusable(focusable)
      if (focusable) win.focus()
    }
  }
}

/** Opaque window used only by `npm run screens`: renders the card over a fake desktop. */
export function createStageWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 640,
    height: 440,
    x: 40,
    y: 60,
    show: true,
    frame: false,
    resizable: false,
    backgroundColor: '#101114',
    useContentSize: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      additionalArguments: ['--fastasl-dev', '--fastasl-screenshots']
    }
  })
}
