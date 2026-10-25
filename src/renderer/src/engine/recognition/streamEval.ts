/**
 * Test-only: replays clips frame by frame through the streaming signs (StreamingSignMatcher, or
 * the whole RecognitionSession) and reports, per word, recall, false fires on other clips and how
 * early the word fires. Used by aslcitizen.eval.test.ts (real signers, local data only) and by
 * streaming.test.ts (the synthetic control gestures, always).
 *
 * Clip folders (never committed: ASL Citizen is non-commercial research data):
 *  - an evalData folder: `index.json` + `<name>.bin` (engine/model/evalData.ts), ASL Citizen's
 *    MediaPipe Holistic poses. Their z is flat and the hands are labelled by body side.
 *  - a folder of tracked clips, `<GLOSS>__<id>.json`: the app's own MediaPipe tasks (hand and
 *    face landmarker, same options as handTracker.ts) run on the ASL Citizen videos, so real z,
 *    the tracker's own hand labels and the face on every other frame, like the live app:
 *    `{ name, gloss, fps, width, height, frames: [{ h: [[label, score, x0, y0, z0, ...]], f: [x, y, z, ...] | null }] }`
 *    (`f` is the 468 face points, present on even frames).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Dictionary } from '@shared/dictionary'
import type { Landmark } from '@shared/types'
import { evalIndex, loadFrames, wordForGloss } from '../model/evalData'
import { makeHand, seededRandom, type HandSpec, type PoseName } from '../gestures/synthetic'
import type { FrameSample, HandSample } from '../types'
import { RecognitionSession, type SessionOptions } from './session'
import type { StreamRule } from './streamRules/types'
import { StreamingSignMatcher } from './streaming'
import { syntheticFace } from './synthetic'

export interface EvalClip {
  name: string
  gloss: string
  /** Image width / height. */
  aspect: number
  frames: FrameSample[]
}

/** A word that fired: frame time, and ms since the clip's first frame with a hand. */
export interface StreamHit {
  word: string
  t: number
  ms: number
}

export interface StreamOptions {
  dictionary?: Dictionary
  rules?: readonly StreamRule[]
}

/** The app reuses a face result this long on frames that skip the face (handTracker EXTRA_MAX_AGE_MS). */
const FACE_REUSE_MS = 150

/** A tracked clip as the camera pipeline would deliver it: up to 2 hands, the face reused for 150 ms. */
export function trackedClip(json: {
  name: string
  gloss: string
  fps: number
  width: number
  height: number
  frames: { h: (string | number)[][]; f: number[] | null }[]
}): EvalClip {
  let face: { t: number; points: Landmark[] } | null = null
  const frames = json.frames.map((fr, i): FrameSample => {
    const t = Math.floor((i * 1000) / (json.fps || 30)) + 1
    const hands: HandSample[] = fr.h.map((h) => {
      const v = h.slice(2) as number[]
      const landmarks: Landmark[] = []
      for (let k = 0; k + 2 < v.length; k += 3) landmarks.push({ x: v[k], y: v[k + 1], z: v[k + 2] })
      return { landmarks, handedness: h[0] === 'Left' ? 'Left' : 'Right', score: Number(h[1]) }
    })
    if (fr.f) {
      const points: Landmark[] = []
      for (let k = 0; k + 2 < fr.f.length; k += 3) points.push({ x: fr.f[k], y: fr.f[k + 1], z: fr.f[k + 2] })
      face = { t, points }
    }
    const sample: FrameSample = { t, hands: hands.slice(0, 2) }
    if (face && t - face.t <= FACE_REUSE_MS) sample.face = face.points
    return sample
  })
  return { name: json.name, gloss: json.gloss, aspect: json.width / json.height, frames }
}

/**
 * The clips in a folder (either layout, see above), loaded one at a time: thousands of clips with
 * face meshes don't fit in memory at once. `keep` filters by gloss before loading.
 */
export function* clipsIn(dir: string, keep: (gloss: string) => boolean = () => true): Generator<EvalClip> {
  if (!existsSync(dir)) return
  const index = evalIndex(dir)
  if (index) {
    for (const e of index) {
      if (keep(e.gloss)) yield { name: e.name, gloss: e.gloss, aspect: e.width / e.height, frames: loadFrames(dir, e) }
    }
    return
  }
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.json') && f.includes('__') && keep(f.split('__')[0])) yield trackedClip(JSON.parse(readFileSync(join(dir, f), 'utf8')))
  }
}

/** What a replay leaves of a clip: its name, gloss and the words that fired. */
export interface ClipResult {
  name: string
  gloss: string
  hits: StreamHit[]
}

/** Replays every clip in the folders (see clipsIn) and keeps only the results. */
export function replayAll(dirs: readonly string[], replay: (clip: EvalClip) => StreamHit[], keep?: (gloss: string) => boolean): ClipResult[] {
  const out: ClipResult[] = []
  for (const dir of dirs) for (const clip of clipsIn(dir, keep)) out.push({ name: clip.name, gloss: clip.gloss, hits: replay(clip) })
  return out
}

const firstHandT = (frames: readonly FrameSample[]): number => frames.find((f) => f.hands.length > 0)?.t ?? frames[0]?.t ?? 0

/** Feeds a clip frame by frame through a StreamingSignMatcher: each word that fired, and when. */
export function replayStream(clip: EvalClip, options: StreamOptions = {}): StreamHit[] {
  const matcher = new StreamingSignMatcher(options)
  const start = firstHandT(clip.frames)
  const hits: StreamHit[] = []
  for (const frame of clip.frames) {
    const word = matcher.update(frame, clip.aspect)
    if (word) hits.push({ word, t: frame.t, ms: frame.t - start })
  }
  return hits
}

/**
 * The same through a whole RecognitionSession in Command mode (streaming signs, numbers when
 * asked, the segmenter): the streamed tokens, and how many movements still got an outcome.
 */
export function replaySession(
  clip: EvalClip,
  options: StreamOptions & { numbers?: boolean; session?: SessionOptions } = {}
): { hits: StreamHit[]; outcomes: number } {
  const session = new RecognitionSession({ ...options.session, aspect: clip.aspect, dictionary: options.dictionary, streamRules: options.rules })
  session.setMode('command')
  if (options.numbers) session.setNumbers(true)
  const start = firstHandT(clip.frames)
  const hits: StreamHit[] = []
  let outcomes = 0
  for (const frame of clip.frames) {
    for (const e of session.update(frame)) {
      if (e.type === 'token' && e.streamed) hits.push({ word: e.text, t: frame.t, ms: frame.t - start })
      else if (e.type === 'rejected' || (e.type !== 'signStart' && e.kind === 'word')) outcomes++
    }
  }
  return { hits, outcomes }
}

export interface WordRow {
  word: string
  /** Clips of this word, and how many fired it. */
  clips: number
  hits: number
  /** Its clips where another streaming word fired. */
  wrong: number
  /** Median and 90th percentile ms from the first hand in view to the word. */
  medianMs: number | null
  p90Ms: number | null
  /** Clips of other glosses (any word, or none) where this word fired. */
  falseFires: number
  others: number
  /** Which glosses those false fires came from. */
  falseFrom: Record<string, number>
}

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

/**
 * Per word: recall on its own clips and false fires on everyone else's. `targetOf` names the word
 * a clip's gloss is (default: the app's ASL Citizen gloss mapping, wordForGloss); clips whose
 * gloss maps to no streaming word only count as others.
 */
export function streamReport(
  results: readonly ClipResult[],
  words: readonly string[],
  targetOf: (gloss: string) => string | null = wordForGloss
): WordRow[] {
  return words.map((word) => {
    const mine = results.filter((r) => targetOf(r.gloss) === word)
    const others = results.filter((r) => targetOf(r.gloss) !== word)
    const latencies = mine.flatMap((r) => r.hits.filter((h) => h.word === word).slice(0, 1).map((h) => h.ms))
    const falseFrom: Record<string, number> = {}
    let falseFires = 0
    for (const r of others) {
      if (!r.hits.some((h) => h.word === word)) continue
      falseFires++
      falseFrom[r.gloss] = (falseFrom[r.gloss] ?? 0) + 1
    }
    return {
      word,
      clips: mine.length,
      hits: mine.filter((r) => r.hits.some((h) => h.word === word)).length,
      wrong: mine.filter((r) => r.hits.some((h) => h.word !== word)).length,
      medianMs: quantile(latencies, 0.5),
      p90Ms: quantile(latencies, 0.9),
      falseFires,
      others: others.length,
      falseFrom
    }
  })
}

/** The report as a plain-text table. */
export function formatReport(rows: readonly WordRow[]): string {
  const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '-')
  const lines = rows.map((r) => {
    const from = Object.entries(r.falseFrom)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([g, n]) => `${g} ${n}`)
      .join(', ')
    return (
      `${r.word.padEnd(12)} recall ${`${r.hits}/${r.clips}`.padStart(7)} ${pct(r.hits, r.clips).padStart(6)}  ` +
      `wrong-word ${String(r.wrong).padStart(2)}  false ${`${r.falseFires}/${r.others}`.padStart(9)} ${pct(r.falseFires, r.others).padStart(6)}  ` +
      `fire ${r.medianMs === null ? '-' : `${Math.round(r.medianMs)} ms`} (p90 ${r.p90Ms === null ? '-' : `${Math.round(r.p90Ms)} ms`})` +
      (from ? `  from ${from}` : '')
    )
  })
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Control gestures: the app's own hand gestures, made in front of a face. No streaming word may
// fire on any of them (streaming.test.ts checks every dictionary sign and stream rule).

/** The control gestures' hand poses (engine/gestures): fist, open palm, finger counts 1-5, thumbs up, peace. */
export const CONTROL_POSES: readonly PoseName[] = ['fist', 'openPalm', 'five', 'one', 'peace', 'twoTogether', 'three', 'threeAsl', 'four', 'thumbsUp']
const FACE = { cx: 0.5, cy: 0.3, w: 0.16, h: 0.27 }
const ASPECT = 4 / 3
const FPS = 30

/** One hand over time: its spec at progress u (0..1) of `ms`. */
function segment(ms: number, at: (u: number) => HandSpec[] | null, frames: FrameSample[], random: () => number): void {
  const n = Math.max(1, Math.round((ms * FPS) / 1000))
  for (let i = 0; i < n; i++) {
    const t = (frames.at(-1)?.t ?? 0) + 1000 / FPS
    const specs = at(i / (n - 1 || 1)) ?? []
    const hands = specs.map((s) => makeHand({ noise: 0.002, ...s }, { aspect: ASPECT, rng: random }))
    // The tracker loses a hand whose wrist is below the frame.
    frames.push({ t, hands: hands.filter((h) => h.landmarks[0].y <= 1), face: syntheticFace(FACE) })
  }
}

const ease = (u: number): number => u * u * (3 - 2 * u)

/**
 * Synthetic clips of every control gesture: each pose raised into view to the chest, the chin
 * and beside the face (either hand), held 1.5 s and lowered; and open-palm swipes left, right and
 * up at chest and face height. 4:3 frames with a face in the upper middle.
 */
export function controlGestureClips(): EvalClip[] {
  const clips: EvalClip[] = []
  const random = seededRandom(7)
  const places: [string, number, number][] = [
    ['chest', 0.5, 0.78],
    ['chin', 0.5, 0.62],
    ['face-side', 0.68, 0.45],
    ['high', 0.32, 0.38]
  ]
  for (const pose of CONTROL_POSES) {
    for (const handedness of ['Right', 'Left'] as const) {
      for (const [where, x, y] of places) {
        const frames: FrameSample[] = []
        const hand = (yy: number): HandSpec[] => [{ pose, handedness, x, y: yy }]
        segment(300, () => null, frames, random)
        segment(450, (u) => hand(1.2 + (y - 1.2) * ease(u)), frames, random)
        segment(1500, () => hand(y), frames, random)
        segment(450, (u) => hand(y + (1.2 - y) * ease(u)), frames, random)
        segment(300, () => null, frames, random)
        clips.push({ name: `${pose}-${handedness}-${where}`, gloss: `CONTROL:${pose}`, aspect: ASPECT, frames })
      }
    }
  }
  const swipes: [string, [number, number], [number, number]][] = [
    ['swipeRight', [0.72, 0.7], [0.28, 0.7]],
    ['swipeLeft', [0.28, 0.7], [0.72, 0.7]],
    ['swipeRight-face', [0.72, 0.42], [0.28, 0.42]],
    ['swipeLeft-face', [0.28, 0.42], [0.72, 0.42]],
    ['swipeUp', [0.6, 0.85], [0.6, 0.45]]
  ]
  for (const [name, [x0, y0], [x1, y1]] of swipes) {
    const frames: FrameSample[] = []
    const palm = (x: number, y: number): HandSpec[] => [{ pose: 'openPalm', x, y }]
    segment(300, () => null, frames, random)
    segment(450, (u) => palm(x0, 1.2 + (y0 - 1.2) * ease(u)), frames, random)
    segment(400, () => palm(x0, y0), frames, random)
    segment(250, (u) => palm(x0 + (x1 - x0) * ease(u), y0 + (y1 - y0) * ease(u)), frames, random)
    segment(500, () => palm(x1, y1), frames, random)
    segment(450, (u) => palm(x1, y1 + (1.2 - y1) * ease(u)), frames, random)
    clips.push({ name, gloss: `CONTROL:${name}`, aspect: ASPECT, frames })
  }
  return clips
}

// ---------------------------------------------------------------------------------------------
// Phrases: several clips signed back to back, as one would sign a command.

/**
 * Who signed each clip, when the folder says: an evalData index's `signer` field, or a
 * `signers.json` ({ name: { signer } }) beside tracked clips.
 */
export function signersIn(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const index = evalIndex(dir) as ({ name: string; signer?: string }[] | null)
  if (index) {
    for (const e of index) if (e.signer && e.signer !== '?') out.set(e.name, e.signer)
    return out
  }
  const file = join(dir, 'signers.json')
  if (!existsSync(file)) return out
  const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { signer?: string }>
  for (const [name, v] of Object.entries(map)) if (v.signer && v.signer !== '?') out.set(name, v.signer)
  return out
}

/** One clip by name from a folder (either layout). */
export function clipNamed(dir: string, name: string): EvalClip | null {
  const index = evalIndex(dir)
  if (index) {
    const e = index.find((x) => x.name === name)
    return e ? { name: e.name, gloss: e.gloss, aspect: e.width / e.height, frames: loadFrames(dir, e) } : null
  }
  const file = join(dir, `${name}.json`)
  return existsSync(file) ? trackedClip(JSON.parse(readFileSync(file, 'utf8'))) : null
}

/**
 * Clips joined into one phrase: each trimmed to its frames from the first to the last with a
 * hand (so the raise and the lowering of each word stay, but the long stretches with the hands
 * down are gone), then re-timed back to back. A clip's own stretch with no hands longer than
 * `maxGapMs` (a signer who lowered their hands and signed again) is cut to that long, so the
 * hands are never out of view long enough to end the phrase (hands down, 1.2 s), as when
 * signing a command.
 */
export function chainClips(clips: readonly EvalClip[], maxGapMs = 300): EvalClip {
  const frames: FrameSample[] = []
  let t = 0
  for (const clip of clips) {
    const first = clip.frames.findIndex((f) => f.hands.length > 0)
    let last = clip.frames.length - 1
    while (last > first && clip.frames[last].hands.length === 0) last--
    if (first < 0) continue
    let prev: FrameSample | null = null
    let gapSince: number | null = null
    for (const f of clip.frames.slice(first, last + 1)) {
      const dt = prev ? f.t - prev.t : 0
      prev = f
      if (f.hands.length === 0) {
        gapSince ??= f.t
        if (f.t - gapSince > maxGapMs) continue
      } else gapSince = null
      t += dt
      frames.push({ ...f, t })
    }
    t += 33
  }
  return { name: clips.map((c) => c.name).join('+'), gloss: clips.map((c) => c.gloss).join(' '), aspect: clips[0]?.aspect ?? 4 / 3, frames }
}

/** How many of `expected` came out in order (longest common subsequence), and whether exactly them. */
export function inOrder(words: readonly string[], expected: readonly string[]): { matched: number; exact: boolean } {
  const n = words.length
  const m = expected.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) lcs[i][j] = words[i - 1] === expected[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1])
  }
  return { matched: lcs[n][m], exact: n === m && lcs[n][m] === m }
}
