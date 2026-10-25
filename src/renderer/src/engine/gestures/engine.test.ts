import { describe, expect, it, vi } from 'vitest'
import type { GestureInput, GestureName } from '../../app/controller'
import { SENSITIVITY, type FrameSample } from '../types'
import {
  BUILTIN_PEACE_ID,
  GestureEngine,
  HANDS_DOWN_MS,
  HOLD_MS,
  REFRACTORY_MS,
  RELEASE_MS,
  REPEAT_MS,
  SWIPE_RETURN_MS
} from './engine'
import { Timeline, type HandSpec } from './synthetic'

const FPS = 30
const FRAME = 1000 / FPS
const PALM: HandSpec = { pose: 'openPalm', noise: 0.002 }
const FIST: HandSpec = { pose: 'fist', noise: 0.002 }
const THUMBS_UP: HandSpec = { pose: 'thumbsUp', noise: 0.002 }

interface Fired {
  t: number
  input: GestureInput
}

function play(engine: GestureEngine, frames: FrameSample[], each?: (t: number) => void): Fired[] {
  const fired: Fired[] = []
  for (const frame of frames) {
    for (const input of engine.update(frame)) fired.push({ t: frame.t, input })
    each?.(frame.t)
  }
  return fired
}

function engineFor(gestures: GestureName[], opts?: ConstructorParameters<typeof GestureEngine>[0]): GestureEngine {
  const engine = new GestureEngine(opts)
  engine.setActive(new Set(gestures))
  return engine
}

const only = (fired: Fired[], gesture: GestureName): Fired[] => fired.filter((f) => f.input.gesture === gesture)

/** Expect exactly one event, `ms` after `start` (to within a frame). */
function expectOnceAt(fired: Fired[], start: number, ms: number): void {
  expect(fired).toHaveLength(1)
  expect(fired[0].t - start).toBeGreaterThanOrEqual(ms - 0.01)
  expect(fired[0].t - start).toBeLessThan(ms + FRAME)
}

describe('holds', () => {
  const cases: [GestureName, HandSpec, GestureInput, number][] = [
    ['palmHold', PALM, { gesture: 'palmHold' }, HOLD_MS.palmHold],
    ['thumbsUp', THUMBS_UP, { gesture: 'thumbsUp' }, HOLD_MS.thumbsUp],
    ['fist', FIST, { gesture: 'fist' }, HOLD_MS.fist],
    ['fingers', { pose: 'one', noise: 0.002 }, { gesture: 'fingers', count: 1 }, HOLD_MS.fingers],
    ['fingers', { pose: 'peace', noise: 0.002 }, { gesture: 'fingers', count: 2 }, HOLD_MS.fingers],
    ['fingers', { pose: 'threeAsl', noise: 0.002 }, { gesture: 'fingers', count: 3 }, HOLD_MS.fingers],
    ['fingers', { pose: 'four', noise: 0.002 }, { gesture: 'fingers', count: 4 }, HOLD_MS.fingers],
    ['fingers', PALM, { gesture: 'fingers', count: 5 }, HOLD_MS.fingers],
    ['shape', { pose: 'peace', noise: 0.002 }, { gesture: 'shape', shapeId: BUILTIN_PEACE_ID }, HOLD_MS.shape]
  ]
  for (const [gesture, hand, input, ms] of cases) {
    it(`fires ${JSON.stringify(input)} once after ${ms} ms still`, () => {
      const tl = new Timeline().hold(3000, hand)
      const fired = play(engineFor([gesture]), tl.frames)
      expectOnceAt(fired, 1000, ms)
      expect(fired[0].input).toEqual(input)
    })
  }

  it('reports progress while holding and nothing once fired', () => {
    const engine = engineFor(['palmHold'])
    const seen: number[] = []
    play(engine, new Timeline().hold(1500, PALM).frames, () => seen.push(engine.progress().palmHold))
    expect(seen[15]).toBeCloseTo(0.5, 1)
    expect(seen.slice(0, 29).every((p, i) => i === 0 || p >= seen[i - 1])).toBe(true)
    expect(seen.at(-1)).toBe(0)
  })

  it('reports finger-pick and shape progress with their parameters', () => {
    const pick = engineFor(['fingers'])
    play(pick, new Timeline().hold(400, { pose: 'three', noise: 0.002 }).frames)
    expect(pick.progress().pick?.count).toBe(3)
    expect(pick.progress().pick?.progress).toBeCloseTo(0.5, 1)
    expect(pick.progress().shape).toBeNull()
    expect(pick.progress().palmHold).toBe(0)

    const shape = engineFor(['shape'])
    play(shape, new Timeline().hold(400, { pose: 'peace' }).frames)
    expect(shape.progress().shape?.id).toBe(BUILTIN_PEACE_ID)
    expect(shape.progress().shape?.progress).toBeCloseTo(0.5, 1)
  })

  it('prefers palmHold over fingers{5} and fingers{2} over the peace shape when both are active', () => {
    expect(play(engineFor(['palmHold', 'fingers']), new Timeline().hold(1500, PALM).frames)[0].input).toEqual({
      gesture: 'palmHold'
    })
    const peace = new Timeline().hold(1500, { pose: 'peace' }).frames
    expect(play(engineFor(['fingers', 'shape']), peace)[0].input).toEqual({ gesture: 'fingers', count: 2 })
  })

  it('does not fire anything for a relaxed hand, ASL A or C', () => {
    for (const pose of ['relaxed', 'aslA', 'aslC'] as const) {
      expect(play(new GestureEngine(), new Timeline().hold(3000, { pose, noise: 0.002 }).frames)).toEqual([])
    }
  })
})

describe('flicker tolerance', () => {
  it('ignores 1-2 frames of another shape or a dropped hand', () => {
    const tl = new Timeline()
      .hold(300, PALM)
      .hold(2 * FRAME, { pose: 'relaxed' })
      .hold(300, PALM)
      .none(2 * FRAME)
      .hold(150, PALM)
      .hold(FRAME, FIST)
      .hold(1000, PALM)
    expectOnceAt(play(engineFor(['palmHold']), tl.frames), 1000, HOLD_MS.palmHold)
  })

  it('restarts the hold when a different shape is stable for 3 frames', () => {
    const tl = new Timeline().hold(600, PALM).hold(3 * FRAME, { pose: 'relaxed' })
    const restart = tl.now
    tl.hold(2000, PALM)
    expectOnceAt(play(engineFor(['palmHold']), tl.frames), restart, HOLD_MS.palmHold)
  })

  it('switches to a new stable gesture and times it from when it appeared', () => {
    const tl = new Timeline().hold(300, THUMBS_UP)
    const fistStart = tl.now
    tl.hold(2000, FIST)
    const fired = play(engineFor(['thumbsUp', 'fist']), tl.frames)
    expect(fired.map((f) => f.input.gesture)).toEqual(['fist'])
    expectOnceAt(fired, fistStart, HOLD_MS.fist)
  })
})

describe('stillness', () => {
  it('never fires a hold while the hand drifts, and fires once it has been still long enough', () => {
    const tl = new Timeline().segment(2000, (u) => [{ ...PALM, x: 0.3 + 0.4 * u }])
    const stop = tl.now
    tl.hold(2000, { ...PALM, x: 0.7 })
    const fired = play(engineFor(['palmHold']), tl.frames)
    expect(fired).toHaveLength(1)
    expect(fired[0].t - stop).toBeGreaterThanOrEqual(HOLD_MS.palmHold)
    expect(fired[0].t - stop).toBeLessThan(HOLD_MS.palmHold + 250)
  })

  it('never fires on a moving frame, even when the hold completes just as the hand starts to move', () => {
    const tl = new Timeline()
      .hold(HOLD_MS.palmHold - FRAME, { ...PALM, x: 0.3 })
      .segment(300, (u) => [{ ...PALM, x: 0.3 + 0.3 * u }])
    const stop = tl.now
    tl.hold(2000, { ...PALM, x: 0.6 })
    const fired = play(engineFor(['palmHold']), tl.frames)
    expect(fired).toHaveLength(1)
    expect(fired[0].t).toBeGreaterThan(stop + HOLD_MS.palmHold)
  })

  it('does not complete a fist on a still base hand while the other hand signs', () => {
    const base = { ...FIST, x: 0.7 }
    const signing = new Timeline().segment(3000, (u) => [
      base,
      { pose: 'relaxed', handedness: 'Left', x: 0.3 + 0.08 * Math.sin(2 * Math.PI * 6 * u) }
    ])
    expect(play(engineFor(['fist']), signing.frames)).toEqual([])

    const resting = new Timeline().hold(3000, base, { pose: 'relaxed', handedness: 'Left', x: 0.3 })
    expect(only(play(engineFor(['fist']), resting.frames), 'fist')).toHaveLength(1)
  })
})

describe('release and cooldowns', () => {
  it('fires a hold once however long it is held', () => {
    expect(play(engineFor(['palmHold']), new Timeline().hold(6000, PALM).frames)).toHaveLength(1)
  })

  it('fires again after the hand leaves and comes back', () => {
    const tl = new Timeline().hold(1500, PALM).none(400)
    const back = tl.now
    tl.hold(1500, PALM)
    const fired = play(engineFor(['palmHold']), tl.frames)
    expect(fired).toHaveLength(2)
    expect(fired[1].t - back).toBeGreaterThanOrEqual(HOLD_MS.palmHold)
    expect(fired[1].t - back).toBeLessThan(HOLD_MS.palmHold + FRAME)
  })

  it('fires again after the shape changes, even to an inactive shape', () => {
    const tl = new Timeline().hold(1500, PALM).hold(400, FIST).hold(1500, PALM)
    expect(play(engineFor(['palmHold']), tl.frames)).toHaveLength(2)
  })

  it(`releases a fired hold only once no hand has shown it for ${RELEASE_MS} ms`, () => {
    const away = (ms: number): Fired[] =>
      play(engineFor(['palmHold']), new Timeline().hold(1500, PALM).none(ms).hold(1500, PALM).frames)
    expect(away(RELEASE_MS - 50)).toHaveLength(1)
    expect(away(RELEASE_MS + 50)).toHaveLength(2)
  })

  it('does not count a tracking dropout or a brief misread as letting go', () => {
    // Held for 6 s: 100 ms with no hand, then 200 ms read as ASL A (no gesture).
    const tl = new Timeline()
      .hold(1000, THUMBS_UP)
      .none(100)
      .hold(1500, THUMBS_UP)
      .hold(200, { pose: 'aslA', noise: 0.002 })
      .hold(3200, THUMBS_UP)
    expect(play(engineFor(['thumbsUp', 'fist']), tl.frames)).toHaveLength(1)
  })

  it('spendShown(): a gesture already up when the view changes must be made again', () => {
    // A thumbs-up raised while it means nothing, lost for 2 frames just as the view starts accepting it.
    const engine = engineFor(['fist'])
    const before = new Timeline().hold(1000, THUMBS_UP).none(2 * FRAME)
    play(engine, before.frames)
    engine.setActive(new Set<GestureName>(['thumbsUp', 'fist']))
    engine.spendShown()
    const after = new Timeline({ t0: before.now }).hold(2000, THUMBS_UP)
    expect(play(engine, after.frames)).toEqual([])

    const again = new Timeline({ t0: after.now }).none(RELEASE_MS + 100)
    const back = again.now
    again.hold(1000, THUMBS_UP)
    expectOnceAt(play(engine, again.frames), back, HOLD_MS.thumbsUp)
  })

  it('does not refire a spent hold when the view changes while it is still held', () => {
    const engine = engineFor(['fist', 'thumbsUp'])
    play(engine, new Timeline().hold(1200, FIST).frames)
    engine.setActive(new Set<GestureName>(['fist', 'swipeLeft']))
    expect(play(engine, new Timeline({ t0: 2200 }).hold(3000, FIST).frames)).toEqual([])
  })

  it('blocks the same gesture for 1.5 s, then lets a completed hold fire', () => {
    const tl = new Timeline().hold(700, THUMBS_UP).none(RELEASE_MS + 100).hold(2500, THUMBS_UP)
    const fired = play(engineFor(['thumbsUp']), tl.frames)
    expect(fired).toHaveLength(2)
    expect(fired[1].t - fired[0].t).toBeGreaterThanOrEqual(REPEAT_MS)
    expect(fired[1].t - fired[0].t).toBeLessThan(REPEAT_MS + FRAME)
  })

  it('ignores everything for 700 ms after any event', () => {
    const swipeRight = (tl: Timeline): Timeline =>
      tl.hold(300, { ...PALM, x: 0.7 }).move(250, { ...PALM, x: 0.7 }, { x: 0.3 }).hold(300, { ...PALM, x: 0.3 })

    const soon = swipeRight(new Timeline().hold(HOLD_MS.thumbsUp + 2 * FRAME, THUMBS_UP))
    const quick = play(engineFor(['thumbsUp', 'swipeRight']), soon.frames)
    expect(quick.map((f) => f.input.gesture)).toEqual(['thumbsUp'])

    const later = swipeRight(new Timeline().hold(HOLD_MS.thumbsUp + 2 * FRAME, THUMBS_UP).none(REFRACTORY_MS))
    const fired = play(engineFor(['thumbsUp', 'swipeRight']), later.frames)
    expect(fired.map((f) => f.input.gesture)).toEqual(['thumbsUp', 'swipeRight'])
  })

  it('reset() clears spent holds and cooldowns', () => {
    const engine = engineFor(['palmHold'])
    play(engine, new Timeline().hold(1500, PALM).frames)
    engine.reset()
    const tl = new Timeline({ t0: 2500 }).hold(1500, PALM)
    expectOnceAt(play(engine, tl.frames), 2500, HOLD_MS.palmHold)
  })
})

describe('gating', () => {
  it('never fires or shows progress for inactive gestures', () => {
    const engine = engineFor(['fist'])
    const progress: number[] = []
    const fired = play(engine, new Timeline().hold(3000, PALM).frames, () => progress.push(engine.progress().palmHold))
    expect(fired).toEqual([])
    expect(progress.every((p) => p === 0)).toBe(true)
  })

  it('drops a hold in progress when its gesture is deactivated', () => {
    const engine = engineFor(['palmHold'])
    play(engine, new Timeline().hold(800, PALM).frames)
    engine.setActive(new Set<GestureName>(['fist']))
    expect(engine.progress().palmHold).toBe(0)
    engine.setActive(new Set<GestureName>(['palmHold']))
    const tl = new Timeline({ t0: 1800 }).hold(1500, PALM)
    expectOnceAt(play(engine, tl.frames), 1800, HOLD_MS.palmHold)
  })

  it('ignores swipes that are not active', () => {
    const tl = new Timeline().hold(300, { ...PALM, x: 0.3 }).move(250, { ...PALM, x: 0.3 }, { x: 0.7 })
    expect(play(engineFor(['swipeRight', 'swipeUp']), tl.frames)).toEqual([])
  })
})

/** Hand still for 300 ms, a stroke, then still again. */
function stroke(hand: HandSpec, from: { x: number; y: number }, to: { x?: number; y?: number }, ms = 250, opts = {}): Timeline {
  const start = { ...hand, ...from }
  return new Timeline(opts)
    .hold(300, start)
    .move(ms, start, to)
    .hold(400, { ...start, ...to })
}

const SWIPES: GestureName[] = ['swipeLeft', 'swipeRight', 'swipeUp']
const gestures = (fired: Fired[]): GestureName[] => fired.map((f) => f.input.gesture)

describe('swipes', () => {
  it('maps motion toward the left of the mirrored preview (raw +x) to swipeLeft', () => {
    const mirrored = (displayX: number): number => 1 - displayX
    const tl = stroke(PALM, { x: mirrored(0.7), y: 0.75 }, { x: mirrored(0.3) })
    expect(gestures(play(engineFor(SWIPES), tl.frames))).toEqual(['swipeLeft'])
  })

  it('maps raw -x to swipeRight and upward motion to swipeUp; downward is nothing', () => {
    expect(gestures(play(engineFor(SWIPES), stroke(PALM, { x: 0.7, y: 0.75 }, { x: 0.3 }).frames))).toEqual([
      'swipeRight'
    ])
    expect(gestures(play(engineFor(SWIPES), stroke(PALM, { x: 0.5, y: 0.9 }, { y: 0.55 }).frames))).toEqual([
      'swipeUp'
    ])
    expect(play(engineFor(SWIPES), stroke(PALM, { x: 0.5, y: 0.5 }, { y: 0.9 }).frames)).toEqual([])
  })

  it('fires mid-stroke, without waiting for the hand to stop', () => {
    const tl = stroke(PALM, { x: 0.3, y: 0.75 }, { x: 0.7 })
    const fired = play(engineFor(SWIPES), tl.frames)
    expect(fired[0].t).toBeLessThan(1000 + 300 + 250)
  })

  it('ignores a slow drift over the same distance', () => {
    expect(play(engineFor(SWIPES), stroke(PALM, { x: 0.3, y: 0.75 }, { x: 0.7 }, 1500).frames)).toEqual([])
  })

  it('ignores a steady sweep that covers the distance without reaching the peak speed', () => {
    const sweep = new Timeline()
      .hold(300, { ...PALM, x: 0.2 })
      .segment(600, (u) => [{ ...PALM, x: 0.2 + 0.54 * u }])
      .hold(300, { ...PALM, x: 0.74 })
    expect(play(engineFor(SWIPES), sweep.frames)).toEqual([])
  })

  it('ignores short flicks and diagonal strokes', () => {
    expect(play(engineFor(SWIPES), stroke(PALM, { x: 0.45, y: 0.75 }, { x: 0.58 }, 120).frames)).toEqual([])
    expect(play(engineFor(SWIPES), stroke(PALM, { x: 0.3, y: 0.85 }, { x: 0.65, y: 0.55 }).frames)).toEqual([])
  })

  it('requires a flat hand: a moving fist or pointing hand is not a swipe', () => {
    expect(play(engineFor(SWIPES), stroke(FIST, { x: 0.3, y: 0.75 }, { x: 0.7 }).frames)).toEqual([])
    expect(play(engineFor(SWIPES), stroke({ pose: 'one' }, { x: 0.3, y: 0.75 }, { x: 0.7 }).frames)).toEqual([])
  })

  it('ignores two hands moving at once (two-handed signing)', () => {
    const both = new Timeline()
      .hold(300, { ...PALM, x: 0.55 }, { ...PALM, handedness: 'Left', x: 0.45 })
      .segment(250, (u) => [
        { ...PALM, x: 0.55 + 0.35 * u },
        { ...PALM, handedness: 'Left', x: 0.45 - 0.35 * u }
      ])
    expect(play(engineFor(SWIPES), both.frames)).toEqual([])
  })

  it('ignores the return stroke but allows a deliberate repeat after the cooldown', () => {
    const tl = stroke(PALM, { x: 0.7, y: 0.75 }, { x: 0.3 })
    tl.move(300, { ...PALM, x: 0.3 }, { x: 0.7 }).hold(1200, { ...PALM, x: 0.7 })
    tl.move(250, { ...PALM, x: 0.7 }, { x: 0.3 }).hold(300, { ...PALM, x: 0.3 })
    const fired = play(engineFor(SWIPES), tl.frames)
    expect(gestures(fired)).toEqual(['swipeRight', 'swipeRight'])
  })

  it('ignores a return stroke after a pause until 1.2 s after the swipe motion ended', () => {
    const swipeThenReturn = (pause: number): Timeline =>
      new Timeline()
        .hold(300, { ...PALM, x: 0.7 })
        .move(250, { ...PALM, x: 0.7 }, { x: 0.3 })
        .hold(pause, { ...PALM, x: 0.3 })
        .move(300, { ...PALM, x: 0.3 }, { x: 0.7 })
        .hold(1000, { ...PALM, x: 0.7 })
    // The return is detected inside the lockout and consumed, not fired when the lockout ends.
    for (const pause of [700, 900, 1100]) {
      expect(gestures(play(engineFor(SWIPES), swipeThenReturn(pause).frames))).toEqual(['swipeRight'])
    }
    const deliberate = play(engineFor(SWIPES), swipeThenReturn(SWIPE_RETURN_MS + 300).frames)
    expect(gestures(deliberate)).toEqual(['swipeRight', 'swipeLeft'])
  })

  it('ignores a hand moving into view until it has been seen at rest', () => {
    const easeOut = (u: number): number => 1 - (1 - u) ** 2
    const fromBelow = new Timeline()
      .none(500)
      .segment(300, (u) => [{ ...PALM, y: 0.95 - 0.3 * easeOut(u) }])
      .hold(500, { ...PALM, y: 0.65 })
    expect(play(engineFor(SWIPES), fromBelow.frames)).toEqual([])

    const fromSide = new Timeline()
      .none(500)
      .segment(300, (u) => [{ ...PALM, x: 0.95 - 0.3 * easeOut(u), y: 0.6 }])
      .hold(500, { ...PALM, x: 0.65, y: 0.6 })
    expect(play(engineFor(SWIPES), fromSide.frames)).toEqual([])
    fromSide.move(250, { ...PALM, x: 0.65, y: 0.6 }, { x: 0.3 })
    expect(gestures(play(engineFor(SWIPES), fromSide.frames))).toEqual(['swipeRight'])
  })

  it('does not read a second hand appearing (listed first) as a jump of the first hand', () => {
    for (const aspect of [1, 16 / 9]) {
      for (const at of [{ x: 0.35 }, { y: 0.5 }]) {
        const tl = new Timeline({ aspect })
          .hold(600, { ...PALM, x: 0.6 })
          .hold(1500, { pose: 'relaxed', handedness: 'Left', noise: 0.002, x: 0.6, ...at }, { ...PALM, x: 0.6 })
        const fired = play(engineFor([...SWIPES, 'palmHold'], { aspect }), tl.frames)
        expectOnceAt(fired, 1000, HOLD_MS.palmHold)
        expect(fired[0].input).toEqual({ gesture: 'palmHold' })
      }
    }
  })

  it("does not let the swiping hand's follow-through start a hold", () => {
    const settings: GestureName[] = ['fingers', 'fist', 'swipeLeft', 'swipeRight']
    const tl = stroke(PALM, { x: 0.7, y: 0.75 }, { x: 0.3 }).hold(1500, { ...PALM, x: 0.3 })
    expect(gestures(play(engineFor(settings), tl.frames))).toEqual(['swipeRight'])

    tl.none(400).hold(1500, { ...PALM, x: 0.3 })
    const fired = play(engineFor(settings), tl.frames)
    expect(fired.map((f) => f.input)).toEqual([{ gesture: 'swipeRight' }, { gesture: 'fingers', count: 5 }])
  })

  it('measures peak speed over 60 ms, so a 15 fps stream tracked twice per frame does not double it', () => {
    // Each frame seen again 33 ms later: frame to frame the speed would read 0, then 2×.
    const twice = (frames: FrameSample[]): FrameSample[] => frames.flatMap((f) => [f, { ...f, t: f.t + FRAME }])
    const sweep = (fps: number): Timeline =>
      new Timeline({ fps })
        .hold(400, { ...PALM, x: 0.3 })
        .segment(300, (u) => [{ ...PALM, x: 0.3 + 0.3 * u }])
        .hold(400, { ...PALM, x: 0.6 })
    // A steady move of about 1 frame width/s (repositioning, signing) is not a swipe.
    expect(play(engineFor(SWIPES), sweep(30).frames)).toEqual([])
    expect(play(engineFor(SWIPES), sweep(15).frames)).toEqual([])
    expect(play(engineFor(SWIPES), twice(sweep(15).frames))).toEqual([])
    const swipe = stroke(PALM, { x: 0.3, y: 0.75 }, { x: 0.7 }, 250, { fps: 15 })
    expect(gestures(play(engineFor(SWIPES), twice(swipe.frames)))).toEqual(['swipeLeft'])
  })

  it('measures horizontal travel in frame widths on a 16:9 source', () => {
    const wide = { aspect: 16 / 9 }
    const engine = engineFor(SWIPES, wide)
    expect(gestures(play(engine, stroke(PALM, { x: 0.35, y: 0.75 }, { x: 0.62 }, 250, wide).frames))).toEqual([
      'swipeLeft'
    ])
    const short = stroke(PALM, { x: 0.4, y: 0.75 }, { x: 0.55 }, 250, wide)
    expect(play(engineFor(SWIPES, wide), short.frames)).toEqual([])
  })

  it('discards a stroke that interrupts a nearly complete hold', () => {
    // At 10 fps a fast stroke crosses the threshold within the 2 tolerated motion frames.
    const tl = new Timeline({ fps: 10 })
      .hold(800, { ...PALM, x: 0.3 })
      .move(200, { ...PALM, x: 0.3 }, { x: 0.6 })
      .hold(1500, { ...PALM, x: 0.6 })
    expect(gestures(play(engineFor(['palmHold', 'swipeLeft']), tl.frames))).toEqual(['palmHold'])
    expect(gestures(play(engineFor(['swipeLeft']), tl.frames))).toEqual(['swipeLeft'])
  })
})

describe('handsDown', () => {
  it('fires once, HANDS_DOWN_MS after the last hand leaves', () => {
    const tl = new Timeline().hold(500, PALM)
    const lastSeen = tl.now - FRAME
    tl.none(5000)
    expectOnceAt(play(engineFor(['handsDown']), tl.frames), lastSeen, HANDS_DOWN_MS)
  })

  it('re-arms when hands come back', () => {
    const tl = new Timeline().hold(500, PALM).none(HANDS_DOWN_MS + 500).hold(300, PALM).none(HANDS_DOWN_MS + 500)
    expect(play(engineFor(['handsDown']), tl.frames)).toHaveLength(2)
  })

  it('needs hands to have been visible for a few frames', () => {
    expect(play(engineFor(['handsDown']), new Timeline().none(3000).frames)).toEqual([])
    const blip = new Timeline().none(500).hold(2 * FRAME, PALM).none(3000)
    expect(play(engineFor(['handsDown']), blip.frames)).toEqual([])
  })

  it('ignores 1-2 dropped frames while hands are up', () => {
    const tl = new Timeline().hold(500, PALM).none(2 * FRAME).hold(500, PALM).none(FRAME).hold(500, PALM)
    expect(play(engineFor(['handsDown']), tl.frames)).toEqual([])
  })

  it('does not fire when activated while the hands are already down', () => {
    const engine = engineFor(['fist'])
    play(engine, new Timeline().hold(500, PALM).none(300).frames)
    engine.setActive(new Set<GestureName>(['handsDown']))
    expect(play(engine, new Timeline({ t0: 1800 }).none(3000).frames)).toEqual([])
  })
})

describe('sensitivity', () => {
  it('scales hold times', () => {
    for (const level of ['low', 'high'] as const) {
      const engine = engineFor(['palmHold'], { sensitivity: SENSITIVITY[level] })
      const ms = HOLD_MS.palmHold * SENSITIVITY[level].holdScale
      expectOnceAt(play(engine, new Timeline().hold(3000, PALM).frames), 1000, ms)
    }
  })

  it('scales the hands-down delay', () => {
    const engine = engineFor(['handsDown'], { sensitivity: SENSITIVITY.low })
    const tl = new Timeline().hold(500, PALM)
    const lastSeen = tl.now - FRAME
    tl.none(HANDS_DOWN_MS * 2)
    expectOnceAt(play(engine, tl.frames), lastSeen, HANDS_DOWN_MS * SENSITIVITY.low.holdScale)
  })

  it('scales swipe distance and speed', () => {
    const borderline = stroke(PALM, { x: 0.35, y: 0.75 }, { x: 0.6 }).frames
    expect(play(engineFor(SWIPES), borderline)).toHaveLength(1)
    expect(play(engineFor(SWIPES, { sensitivity: SENSITIVITY.low }), borderline)).toEqual([])

    const small = stroke(PALM, { x: 0.4, y: 0.75 }, { x: 0.6 }).frames
    expect(play(engineFor(SWIPES), small)).toEqual([])
    const engine = engineFor(SWIPES)
    engine.setSensitivity(SENSITIVITY.high)
    expect(play(engine, small)).toHaveLength(1)
  })
})

describe('custom shapes', () => {
  it('fires shape{id} for a custom matcher hit and passes it the raw hand', () => {
    const engine = engineFor(['shape'])
    const matcher = vi.fn(() => ({ id: 'custom-1' }))
    engine.setShapeMatcher(matcher)
    const tl = new Timeline().hold(2000, { pose: 'relaxed', noise: 0.002 })
    const fired = play(engine, tl.frames)
    expectOnceAt(fired, 1000, HOLD_MS.shape)
    expect(fired[0].input).toEqual({ gesture: 'shape', shapeId: 'custom-1' })
    expect(matcher).toHaveBeenCalledWith(tl.frames[0].hands[0])
  })

  it('lets a custom shape win over the built-in peace sign', () => {
    const engine = engineFor(['shape'])
    engine.setShapeMatcher(() => ({ id: 'my-v' }))
    expect(play(engine, new Timeline().hold(1500, { pose: 'peace' }).frames)[0].input.shapeId).toBe('my-v')
  })

  it('keeps built-in control shapes ahead of custom shapes', () => {
    const engine = engineFor(['fist', 'shape'])
    engine.setShapeMatcher(() => ({ id: 'anything' }))
    expect(play(engine, new Timeline().hold(1500, FIST).frames)[0].input).toEqual({ gesture: 'fist' })
  })

  it('keeps a fired custom shape spent through a view where shapes are inactive', () => {
    const engine = engineFor(['palmHold', 'shape'])
    engine.setShapeMatcher(() => ({ id: 'custom-1' }))
    const hand: HandSpec = { pose: 'relaxed', noise: 0.002 }
    expect(play(engine, new Timeline().hold(1500, hand).frames)).toHaveLength(1)
    engine.setActive(new Set<GestureName>(['fist']))
    expect(play(engine, new Timeline({ t0: 2500 }).hold(2600, hand).frames)).toEqual([])
    engine.setActive(new Set<GestureName>(['palmHold', 'shape']))
    expect(play(engine, new Timeline({ t0: 5100 }).hold(2000, hand).frames)).toEqual([])

    const again = play(engine, new Timeline({ t0: 7100 }).none(400).hold(1500, hand).frames)
    expect(again.map((f) => f.input)).toEqual([{ gesture: 'shape', shapeId: 'custom-1' }])
  })

  it('does not call the matcher while shapes are inactive, and falls back to peace when cleared', () => {
    const engine = engineFor(['fist'])
    const matcher = vi.fn(() => null)
    engine.setShapeMatcher(matcher)
    play(engine, new Timeline().hold(500, PALM).frames)
    expect(matcher).not.toHaveBeenCalled()

    engine.setShapeMatcher(null)
    engine.setActive(new Set<GestureName>(['shape']))
    const fired = play(engine, new Timeline({ t0: 2000 }).hold(1500, { pose: 'peace' }).frames)
    expect(fired[0].input).toEqual({ gesture: 'shape', shapeId: BUILTIN_PEACE_ID })
  })
})
