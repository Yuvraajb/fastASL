import { describe, expect, it } from 'vitest'
import type { Handedness, Landmark } from '@shared/types'
import { makeHand, seededRandom, Timeline, type HandSpec, type PoseName } from '../../gestures/synthetic'
import type { FrameSample, HandSample } from '../../types'
import { poseLandmarks, type Handshape } from '../synthetic'
import { faceBoxOf, faceFor } from './face'
import { call, dad, FACE_RULES, mom, no, swings, thankYou, tomorrow, yes } from './faceSigns'
import { measure, onFace } from './handTracks'
import type { FaceBox, StreamContext, StreamRule } from './types'

/*
 * Each face rule on synthetic signs: the sign fires it, and the same hand without the sign's
 * movement or contact (a held shape, the wrong place, no face, another hand) does not. Then every
 * control gesture, held at the chest and at the face, switched into another or swiped, fires
 * nothing. faceSigns.eval.test.ts has the numbers on real signers.
 */

const ASPECT = 4 / 3
const FPS = 30
const DT = 1000 / FPS
const FACE: FaceBox = { cx: 0.5, cy: 0.35, w: 0.2, h: 0.3 }
const CTX: StreamContext = { aspect: ASPECT, face: FACE }
/** Palm length (wrist to middle knuckle) as a fraction of the frame height: half a face height. */
const SIZE = 0.15

/** Four mesh points whose bounding box is the face box (like FaceLandmarker's mesh). */
function faceMesh(box: FaceBox): Landmark[] {
  const { cx, cy, w, h } = box
  return [
    { x: cx, y: cy - h / 2, z: 0 },
    { x: cx + w / 2, y: cy, z: 0 },
    { x: cx, y: cy + h / 2, z: 0 },
    { x: cx - w / 2, y: cy, z: 0 }
  ]
}

interface Pose {
  shape: Handshape
  handedness?: Handedness
  roll?: number
  pitch?: number
  yaw?: number
}

/** The posed hand moved so that landmark `at` sits on (u, v) in face units. */
function placed(pose: Pose, at: number, u: number, v: number): HandSample {
  const handedness = pose.handedness ?? 'Right'
  const base = { shape: pose.shape, handedness, x: 0.5, y: 0.5, size: SIZE, roll: pose.roll ?? 0, pitch: pose.pitch ?? 0, yaw: pose.yaw ?? 0 }
  const raw = poseLandmarks(base, ASPECT)
  const dx = FACE.cx + u * FACE.w - raw[at].x
  const dy = FACE.cy + v * FACE.h - raw[at].y
  return { handedness, score: 0.95, landmarks: raw.map((p) => ({ x: p.x + dx, y: p.y + dy, z: p.z })) }
}

const shifted = (hand: HandSample, du: number, dv: number): HandSample => ({
  ...hand,
  landmarks: hand.landmarks.map((p) => ({ x: p.x + du * FACE.w, y: p.y + dv * FACE.h, z: p.z }))
})

/** A clip built frame by frame at 30 fps. */
class Clip {
  readonly frames: FrameSample[] = []
  constructor(private readonly face: Landmark[] | undefined = undefined) {}
  private push(hands: HandSample[]): void {
    const t = 1000 + this.frames.length * DT
    this.frames.push(this.face ? { t, hands, face: this.face } : { t, hands })
  }
  none(ms: number): this {
    for (let i = 0; i < ms / DT; i++) this.push([])
    return this
  }
  /** `hand(u)` for u from 0 to 1 over `ms`. */
  over(ms: number, hand: (u: number) => HandSample | HandSample[]): this {
    const n = Math.max(1, Math.round(ms / DT))
    for (let i = 0; i < n; i++) {
      const h = hand(n === 1 ? 1 : i / (n - 1))
      this.push(Array.isArray(h) ? h : [h])
    }
    return this
  }
  hold(ms: number, hand: HandSample | HandSample[]): this {
    return this.over(ms, () => hand)
  }
  /** The hand rises into view from below the frame to `hand`. */
  rise(ms: number, hand: HandSample): this {
    const drop = (1.15 - hand.landmarks[0].y) / FACE.h
    return this.over(ms, (u) => shifted(hand, 0, drop * (1 - u * u * (3 - 2 * u))))
  }
}

/** Fire times (ms into the clip), the way the streaming matcher runs a rule: 1.5 s of history, reset after a fire. */
function fires(rule: StreamRule, frames: readonly FrameSample[], ctx: StreamContext = CTX): number[] {
  let history: FrameSample[] = []
  const out: number[] = []
  let cooldown = -Infinity
  for (const f of frames) {
    history.push(f)
    while (history.length > 1 && f.t - history[0].t > 1500) history.shift()
    if (!f.hands.length || f.t < cooldown) continue
    if (rule.fires(history, ctx)) {
      out.push(f.t - frames[0].t)
      cooldown = f.t + 900
      history = []
    }
  }
  return out
}

const lerp = (a: Handshape, b: Handshape, k: number): Handshape => ({
  curls: a.curls.map((c, i) => c + (b.curls[i] - c) * k) as Handshape['curls'],
  spread: a.spread + (b.spread - a.spread) * k,
  thumbOut: a.thumbOut + (b.thumbOut - a.thumbOut) * k,
  thumbFlex: a.thumbFlex + (b.thumbFlex - a.thumbFlex) * k
})

// Handshapes (recognition/synthetic.ts parameters).
const A_AT_CHEEK: Handshape = { curls: [1, 1, 1, 1], spread: 0.2, thumbOut: 0.2, thumbFlex: 0.5 }
const A_THUMB_OUT: Handshape = { curls: [1, 1, 1, 1], spread: 0.2, thumbOut: 0.25, thumbFlex: 0 }
const FIVE: Handshape = { curls: [0, 0, 0, 0], spread: 2, thumbOut: 1, thumbFlex: 0 }
const B: Handshape = { curls: [0, 0, 0, 0], spread: 0.2, thumbOut: 0.1, thumbFlex: 0.7 }
const S: Handshape = { curls: [1, 1, 1, 1], spread: 0.2, thumbOut: 0.2, thumbFlex: 0.9 }
const Y: Handshape = { curls: [1, 1, 1, 0], spread: 1, thumbOut: 1, thumbFlex: 0 }
const NO_OPEN: Handshape = { curls: [0, 0, 1, 1], spread: 0.2, thumbOut: 0.9, thumbFlex: 0 }
const NO_SHUT: Handshape = { curls: [0.5, 0.5, 1, 1], spread: 0.2, thumbOut: 0.5, thumbFlex: 0.4 }
const THUMB_TIP = 4
const MIDDLE_TIP = 12

describe('swings', () => {
  it('counts alternating moves of at least the amount', () => {
    expect(swings([0, 0.3, 0, 0.3], 0.25)).toBe(3)
    expect(swings([0, -0.3, 0], 0.25)).toBe(2)
    expect(swings([0, 0.1, 0, 0.1, 0], 0.25)).toBe(0)
    expect(swings([0, 0.2, 0.4, 0.6], 0.25)).toBe(1)
  })
})

describe('face box', () => {
  it('is the bounding box of the mesh, and comes from the history when the context has none', () => {
    const close = (box: FaceBox | null | undefined): void => {
      for (const k of ['cx', 'cy', 'w', 'h'] as const) expect(box?.[k]).toBeCloseTo(FACE[k], 9)
    }
    close(faceBoxOf(faceMesh(FACE)))
    expect(faceBoxOf(undefined)).toBeNull()
    const history: FrameSample[] = [{ t: 0, hands: [], face: faceMesh(FACE) }, { t: 500, hands: [] }]
    close(faceFor(history, { aspect: ASPECT }))
    expect(faceFor([{ t: 0, hands: [], face: faceMesh(FACE) }, { t: 1500, hands: [] }], { aspect: ASPECT })).toBeUndefined()
    const other = { cx: 0.4, cy: 0.3, w: 0.1, h: 0.2 }
    expect(faceFor(history, { aspect: ASPECT, face: other })).toBe(other)
  })
})

describe('TOMORROW: A hand, thumb at the cheek, then the fist pivots forward on the thumb', () => {
  // The signer's right hand on the left of the raw image; the thumb tip on the cheek. The forward
  // arc tips the fist toward the camera (pitch) around the thumb: the palm drops, the thumb barely.
  const CHEEK: [number, number] = [-0.35, 0.25]
  const arc = (k: number, shape = A_AT_CHEEK, handedness: Handedness = 'Right'): HandSample =>
    placed({ shape, handedness, pitch: -70 * k }, THUMB_TIP, handedness === 'Right' ? CHEEK[0] : -CHEEK[0], CHEEK[1] + 0.08 * k)
  const sign = (shape = A_AT_CHEEK, handedness: Handedness = 'Right', face?: Landmark[]): Clip =>
    new Clip(face)
      .rise(300, arc(0, shape, handedness))
      .hold(200, arc(0, shape, handedness))
      .over(250, (u) => arc(u, shape, handedness))
      .hold(300, arc(1, shape, handedness))

  it('fires once, during the arc', () => {
    const palm = (k: number): number => onFace(measure(arc(k), 0, ASPECT)!.palm, FACE).v
    expect(palm(1) - palm(0)).toBeGreaterThan(0.25)
    const t = fires(tomorrow, sign().frames)
    expect(t).toHaveLength(1)
    expect(t[0]).toBeGreaterThan(500)
    expect(t[0]).toBeLessThan(800)
  })

  it('works with either hand, and finds the face in the frames when the context has none', () => {
    expect(fires(tomorrow, sign(A_AT_CHEEK, 'Left').frames)).toHaveLength(1)
    expect(fires(tomorrow, sign(A_AT_CHEEK, 'Right', faceMesh(FACE)).frames, { aspect: ASPECT })).toHaveLength(1)
  })

  it('does not fire when the fist is just lowered from the cheek (thumb and palm drop together)', () => {
    const clip = new Clip().rise(300, arc(0)).hold(200, arc(0)).over(300, (u) => shifted(arc(0), 0, 0.8 * u))
    expect(fires(tomorrow, clip.frames)).toEqual([])
  })

  it('does not fire for a thumb sticking straight out (YESTERDAY, thumbs-up), a held fist, no face, or another hand', () => {
    expect(fires(tomorrow, sign(A_THUMB_OUT).frames)).toEqual([])
    expect(fires(tomorrow, new Clip().rise(300, arc(0)).hold(1200, arc(0)).frames)).toEqual([])
    expect(fires(tomorrow, sign().frames, { aspect: ASPECT })).toEqual([])
    const other = placed({ shape: B, handedness: 'Left' }, 0, -0.35, 0.95)
    const both = new Clip().over(300, () => [arc(0), other]).hold(200, [arc(0), other]).over(250, (u) => [arc(u), other]).hold(300, [arc(1), other])
    expect(fires(tomorrow, both.frames)).toEqual([])
  })
})

describe('MOM and DAD: a 5 hand arrives and the thumb rests on the chin / forehead', () => {
  // A spread 5, turned sideways (yaw 45: |palmFacing| about 0.7), fingers up.
  const five = (v: number, yaw = 45): HandSample => placed({ shape: FIVE, yaw }, THUMB_TIP, -0.1, v)
  const CHIN = 0.45
  const FOREHEAD = -0.35

  it('MOM fires on the chin, DAD on the forehead, each once', () => {
    const chin = new Clip().rise(350, five(CHIN)).hold(600, five(CHIN))
    expect(fires(mom, chin.frames)).toHaveLength(1)
    expect(fires(dad, chin.frames)).toEqual([])
    const forehead = new Clip().rise(350, five(FOREHEAD)).hold(600, five(FOREHEAD))
    expect(fires(dad, forehead.frames)).toHaveLength(1)
    expect(fires(mom, forehead.frames)).toEqual([])
  })

  it('fires within a few frames of the hand reaching the chin', () => {
    const t = fires(mom, new Clip().rise(350, five(CHIN)).hold(600, five(CHIN)).frames)
    expect(t[0]).toBeGreaterThan(150)
    expect(t[0]).toBeLessThan(350 + 250)
  })

  it('needs an arrival: a hand already resting there when the history starts does not fire', () => {
    expect(fires(mom, new Clip().hold(1400, five(CHIN)).frames)).toEqual([])
  })

  it('a palm squarely facing the camera (a raised open palm) is not MOM or DAD', () => {
    expect(fires(mom, new Clip().rise(350, five(CHIN, 0)).hold(600, five(CHIN, 0)).frames)).toEqual([])
    expect(fires(dad, new Clip().rise(350, five(FOREHEAD, 0)).hold(600, five(FOREHEAD, 0)).frames)).toEqual([])
  })

  it('a bunched hand at the mouth (EAT, flat O) or no face does not fire', () => {
    const flatO: Handshape = { curls: [0.55, 0.55, 0.55, 0.55], spread: 0.2, thumbOut: 0.5, thumbFlex: 0.5 }
    const eat = placed({ shape: flatO, yaw: 45 }, THUMB_TIP, -0.1, 0.3)
    expect(fires(mom, new Clip().rise(350, eat).hold(600, eat).frames)).toEqual([])
    expect(fires(mom, new Clip().rise(350, five(CHIN)).hold(600, five(CHIN)).frames, { aspect: ASPECT })).toEqual([])
  })
})

describe('CALL: Y hand at the side of the face, thumb by the ear, pinky by the mouth', () => {
  // The signer's left hand on the left of the image, rolled so the thumb is up and the pinky points at the mouth.
  const phone = placed({ shape: Y, handedness: 'Left', roll: 60 }, THUMB_TIP, -0.45, 0)

  it('fires once after the hand arrives and holds', () => {
    const f = measure(phone, 0, ASPECT)!
    expect(onFace(f.pinky, FACE).v - onFace(f.thumb, FACE).v).toBeGreaterThan(0.3)
    expect(fires(call, new Clip().rise(350, phone).hold(600, phone).frames)).toHaveLength(1)
  })

  it('does not fire for a Y hand in front of the chest, a held hand with no arrival, or no face', () => {
    const chest = shifted(phone, 0, 1.2)
    expect(fires(call, new Clip().rise(350, chest).hold(600, chest).frames)).toEqual([])
    expect(fires(call, new Clip().hold(1400, phone).frames)).toEqual([])
    expect(fires(call, new Clip().rise(350, phone).hold(600, phone).frames, { aspect: ASPECT })).toEqual([])
  })
})

describe('THANK YOU: flat hand, fingertips at the lips, back of the hand out, then forward and down', () => {
  // Back of the hand to the camera (yaw 180), fingers slanting in toward the mouth (roll 30).
  const at = (yaw = 180, roll = 30): HandSample => placed({ shape: B, yaw, roll }, MIDDLE_TIP, 0, 0.4)
  const sign = (start = at(), end = shifted(at(), 0, 0.7)): Clip =>
    new Clip()
      .rise(300, start)
      .hold(250, start)
      .over(250, (u) => (u < 1 ? shifted(start, 0, 0.7 * u * u * (3 - 2 * u)) : end))
      .hold(300, end)

  it('fires once as the hand moves off the chin', () => {
    const t = fires(thankYou, sign().frames)
    expect(t).toHaveLength(1)
    expect(t[0]).toBeGreaterThan(550)
    expect(t[0]).toBeLessThan(850)
  })

  it('does not fire for a palm facing the camera, upright fingers, or a hand that never pauses at the lips', () => {
    const palm = at(0, 30)
    expect(fires(thankYou, sign(palm, shifted(palm, 0, 0.7)).frames)).toEqual([])
    const upright = at(180, 0)
    expect(fires(thankYou, sign(upright, shifted(upright, 0, 0.7)).frames)).toEqual([])
    const sweep = new Clip().over(500, (u) => shifted(at(), 0, -0.6 + 1.6 * u))
    expect(fires(thankYou, sweep.frames)).toEqual([])
  })

  it('does not fire for BAD: the hand turns palm down (toward the camera) as it moves off', () => {
    const start = at()
    const clip = new Clip()
      .rise(300, start)
      .hold(250, start)
      .over(250, (u) => shifted(at(180 - 180 * u, 30), 0, 0.7 * u))
      .hold(300, shifted(at(0, 30), 0, 0.7))
    expect(fires(thankYou, clip.frames)).toEqual([])
  })
})

describe('YES: an S fist nods at the wrist', () => {
  const fist = (pitch: number, shape = S): HandSample => placed({ shape, pitch }, 0, -0.9, 1.6)
  const nods = (shape = S, n = 2): Clip =>
    new Clip().rise(300, fist(0, shape)).hold(200, fist(0, shape)).over(n * 330, (u) => fist(40 * Math.abs(Math.sin(Math.PI * n * u)), shape)).hold(200, fist(0, shape))

  it('fires once on two nods, with or without a face', () => {
    expect(fires(yes, nods().frames)).toHaveLength(1)
    expect(fires(yes, nods().frames, { aspect: ASPECT })).toHaveLength(1)
  })

  it('does not fire for one nod, a held fist, a fist raised and lowered, or a thumbs-up A hand nodding', () => {
    expect(fires(yes, nods(S, 1).frames)).toEqual([])
    expect(fires(yes, new Clip().rise(300, fist(0)).hold(1200, fist(0)).frames)).toEqual([])
    const bob = new Clip().rise(300, fist(0)).over(900, (u) => shifted(fist(0), 0, 0.6 * Math.abs(Math.sin(2 * Math.PI * u))))
    expect(fires(yes, bob.frames)).toEqual([])
    expect(fires(yes, nods(A_THUMB_OUT).frames)).toEqual([])
  })
})

describe('NO: index and middle fingers snap shut onto the thumb', () => {
  const hand = (shape: Handshape): HandSample => placed({ shape }, 0, -1, 1.5)
  const snap = (ms = 150): Clip =>
    new Clip()
      .rise(300, hand(NO_OPEN))
      .hold(200, hand(NO_OPEN))
      .over(ms, (u) => hand(lerp(NO_OPEN, NO_SHUT, u)))
      .hold(200, hand(NO_SHUT))

  it('fires once on the snap, with or without a face', () => {
    const t = fires(no, snap().frames)
    expect(t).toHaveLength(1)
    expect(t[0]).toBeGreaterThan(500)
    expect(t[0]).toBeLessThan(700)
    expect(fires(no, snap().frames, { aspect: ASPECT })).toHaveLength(1)
  })

  it('does not fire for a slow close, the open or shut shape held, or two fingers curling into a fist', () => {
    expect(fires(no, snap(1600).frames)).toEqual([])
    expect(fires(no, new Clip().rise(300, hand(NO_OPEN)).hold(1000, hand(NO_OPEN)).frames)).toEqual([])
    expect(fires(no, new Clip().rise(300, hand(NO_SHUT)).hold(1000, hand(NO_SHUT)).frames)).toEqual([])
    const fist: Handshape = { curls: [1, 1, 1, 1], spread: 0.2, thumbOut: 0.2, thumbFlex: 0.9 }
    const curl = new Clip().rise(300, hand(NO_OPEN)).hold(200, hand(NO_OPEN)).over(150, (u) => hand(lerp(NO_OPEN, fist, u))).hold(200, hand(fist))
    expect(fires(no, curl.frames)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Control gestures: fastASL's own hand gestures must never read as a face sign.

const CONTROL_POSES: PoseName[] = ['fist', 'openPalm', 'five', 'one', 'peace', 'twoTogether', 'three', 'threeAsl', 'four', 'thumbsUp']
/** A face where streaming.test.ts puts it (upper middle of a 4:3 frame). */
const CONTROL_FACE: FaceBox = { cx: 0.5, cy: 0.3, w: 0.16, h: 0.27 }

/** Each pose raised into view, held 1.5 s and lowered, at the chest, the chin, beside the face and high; and swipes. */
function controlClips(): { name: string; frames: FrameSample[] }[] {
  const out: { name: string; frames: FrameSample[] }[] = []
  const rng = seededRandom(7)
  const mesh = faceMesh(CONTROL_FACE)
  const segment = (frames: FrameSample[], ms: number, at: (u: number) => HandSpec[]): void => {
    const n = Math.max(1, Math.round(ms / DT))
    for (let i = 0; i < n; i++) {
      const hands = at(i / (n - 1 || 1)).map((s) => makeHand({ noise: 0.002, ...s }, { aspect: ASPECT, rng }))
      frames.push({ t: (frames.at(-1)?.t ?? 0) + DT, hands: hands.filter((h) => h.landmarks[0].y <= 1), face: mesh })
    }
  }
  const ease = (u: number): number => u * u * (3 - 2 * u)
  const places: [string, number, number][] = [
    ['chest', 0.5, 0.78],
    ['chin', 0.5, 0.62],
    ['face-side', 0.68, 0.45],
    ['high', 0.32, 0.38],
    ['shoulder', 0.25, 0.7]
  ]
  for (const pose of CONTROL_POSES)
    for (const handedness of ['Right', 'Left'] as const)
      for (const [where, x, y] of places)
        for (const roll of [-20, 0, 20]) {
          const frames: FrameSample[] = []
          const spec = (yy: number): HandSpec[] => [{ pose, handedness, x, y: yy, roll }]
          segment(frames, 300, () => [])
          segment(frames, 450, (u) => spec(1.2 + (y - 1.2) * ease(u)))
          segment(frames, 1500, () => spec(y))
          segment(frames, 450, (u) => spec(y + (1.2 - y) * ease(u)))
          out.push({ name: `${pose} ${handedness} ${where} roll ${roll}`, frames })
        }
  const swipes: [string, [number, number], [number, number]][] = [
    ['swipeRight', [0.72, 0.7], [0.28, 0.7]],
    ['swipeLeft', [0.28, 0.7], [0.72, 0.7]],
    ['swipeRight at the face', [0.72, 0.42], [0.28, 0.42]],
    ['swipeLeft at the face', [0.28, 0.42], [0.72, 0.42]],
    ['swipeUp', [0.6, 0.85], [0.6, 0.45]]
  ]
  for (const [name, [x0, y0], [x1, y1]] of swipes) {
    const frames: FrameSample[] = []
    const palm = (x: number, y: number): HandSpec[] => [{ pose: 'openPalm', x, y }]
    segment(frames, 450, (u) => palm(x0, 1.2 + (y0 - 1.2) * ease(u)))
    segment(frames, 400, () => palm(x0, y0))
    segment(frames, 250, (u) => palm(x0 + (x1 - x0) * ease(u), y0 + (y1 - y0) * ease(u)))
    segment(frames, 500, () => palm(x1, y1))
    segment(frames, 450, (u) => palm(x1, y1 + (1.2 - y1) * ease(u)))
    out.push({ name, frames })
  }
  return out
}

/** One control pose held, switched to another and back, at the chest, the shoulder and beside the face. */
function switchClips(): { name: string; frames: FrameSample[] }[] {
  const out: { name: string; frames: FrameSample[] }[] = []
  let seed = 1
  for (const a of CONTROL_POSES)
    for (const b of CONTROL_POSES) {
      if (a === b) continue
      for (const [x, y] of [
        [0.5, 0.78],
        [0.3, 0.62]
      ]) {
        const tl = new Timeline({ aspect: ASPECT, seed: seed++ })
        const spec = (pose: PoseName): HandSpec => ({ pose, x, y, noise: 0.002 })
        tl.hold(600, spec(a)).hold(600, spec(b)).hold(600, spec(a))
        out.push({ name: `${a} -> ${b} -> ${a} at (${x}, ${y})`, frames: tl.frames.map((f) => ({ ...f, face: faceMesh(CONTROL_FACE) })) })
      }
    }
  return out
}

describe('control gestures are never face signs', () => {
  const ctx: StreamContext = { aspect: ASPECT }

  it('no rule fires on a control gesture raised, held and lowered, at the chest, the chin or beside the face, or on a swipe', () => {
    const clips = controlClips()
    const fired = FACE_RULES.flatMap((rule) => clips.filter((c) => fires(rule, c.frames, ctx).length > 0).map((c) => `${rule.word}: ${c.name}`))
    expect(fired).toEqual([])
  })

  it('no rule fires when one control gesture changes into another (peace to fist is not NO)', () => {
    const clips = switchClips()
    const fired = FACE_RULES.flatMap((rule) => clips.filter((c) => fires(rule, c.frames, ctx).length > 0).map((c) => `${rule.word}: ${c.name}`))
    expect(fired).toEqual([])
  })
})

describe('FACE_RULES', () => {
  it('lists every rule once, most specific first, with lower-case one-handed words', () => {
    expect(FACE_RULES.map((r) => r.word)).toEqual(['tomorrow', 'call', 'thank you', 'mom', 'dad', 'no', 'yes'])
    expect(new Set(FACE_RULES)).toEqual(new Set([tomorrow, call, thankYou, mom, dad, no, yes]))
    for (const r of FACE_RULES) expect(r.hands).toBe(1)
  })

  it('a rule never throws on empty, handless or malformed frames', () => {
    const odd: FrameSample[] = [
      { t: 0, hands: [] },
      { t: 33, hands: [{ handedness: 'Right', score: 1, landmarks: [] }] },
      { t: 66, hands: [{ handedness: 'Left', score: 1, landmarks: Array.from({ length: 21 }, () => ({ x: NaN, y: NaN, z: NaN })) }] }
    ]
    for (const r of FACE_RULES) for (let i = 1; i <= odd.length; i++) expect(r.fires(odd.slice(0, i), CTX)).toBe(false)
  })
})
