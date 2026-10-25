import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Landmark } from '@shared/types'
import { evalIndex, loadFrames } from '../../model/evalData'
import type { FrameSample, HandSample } from '../../types'
import { faceBoxOf } from './face'
import { FACE_RULES } from './faceSigns'
import type { FaceBox, StreamRule } from './types'

/*
 * The face signs on real signers: ASL Citizen clips replayed frame by frame the way the streaming
 * matcher runs the rules (1.5 s of history, the face box held 1 s, history reset after a fire).
 * Per word: recall on its clips, false fires on every other gloss's clips (and on the demo
 * words'), the wrong word firing first when all rules run together, and how early it fires.
 *
 * Skipped unless FASTASL_FACE_DATA names one or more clip folders (comma separated), either
 *  - an evalData folder (index.json + <name>.bin, model/evalData.ts): MediaPipe Holistic poses,
 *    flat z, hands labelled by body side; or
 *  - a folder of tracked clips (<GLOSS>__<id>.json: { name, gloss, fps, width, height, frames:
 *    [{ h: [[label, score, x0, y0, z0, ...]], f: [face points] | null }] }), the app's own
 *    MediaPipe tasks on the ASL Citizen videos: real z, the tracker's labels, a face every other
 *    frame (the layout recognition/streamEval.ts reads in the main tree).
 * A clip already seen in an earlier folder of the same layout (same name) is skipped. e.g.
 *   FASTASL_FACE_DATA=~/data/citizen-bin/files,~/data/citizen-bin/test,~/data/tracked npx vitest run faceSigns.eval
 * ASL Citizen is non-commercial research data: it stays outside the repo.
 */

const DIRS = (process.env.FASTASL_FACE_DATA ?? '')
  .split(',')
  .map((d) => d.trim().replace(/^~/, process.env.HOME ?? ''))
  .filter((d) => d && existsSync(d))

/** ASL Citizen glosses as one spelling: THANK_YOU = THANKYOU, CALL1 = CALL, EAT1 = EAT. */
const norm = (gloss: string): string => gloss.replace(/_/g, '').replace(/1$/, '')

/** Each word's glosses. CALL is the Y hand at the ear (PHONE, CALL1). */
const TARGET: Record<string, string[]> = {
  tomorrow: ['TOMORROW'],
  call: ['PHONE', 'CALL'],
  'thank you': ['THANKYOU'],
  mom: ['MOTHER'],
  dad: ['FATHER'],
  no: ['NO'],
  yes: ['YES']
}
/** Same English word, another sign: CALL2 is the two-handed summon (H hands), not the phone. Neither hit nor false fire. */
const EXCLUDE: Record<string, string[]> = { call: ['CALL2'] }
/** The demo vocabulary (model/vocabulary.ts), plus MOM and DAD. */
const DEMO = ['HELLO', 'THANKYOU', 'YES', 'NO', 'PLEASE', 'PHONE', 'CALL', 'TOMORROW', 'TIME', 'OPEN', 'WHERE', 'NOW', 'LATER', 'BAD', 'WATER', 'EAT', 'EAT2', 'MOTHER', 'FATHER']
/**
 * Pass marks per folder, for words with enough clips there. Measured (October 2026): recall 50-100%
 * per word and false fires 0.1-3% (THANK YOU's mostly GOOD, the same sign); see the printed table.
 */
const MIN_CLIPS = 8
const MIN_RECALL = 0.4
const MAX_FALSE = 0.05

interface Clip {
  name: string
  gloss: string
  aspect: number
  frames: FrameSample[]
  /** Which tracker made it: the same video tracked twice is two clips, the same file twice is one. */
  layout: 'holistic' | 'tracked'
}

/** A tracked clip as the camera pipeline delivers it: up to 2 hands, the face reused for 150 ms. */
function trackedClip(file: string): Clip {
  const json = JSON.parse(readFileSync(file, 'utf8')) as {
    name: string
    gloss: string
    fps: number
    width: number
    height: number
    frames: { h: (string | number)[][]; f: number[] | null }[]
  }
  const points = (v: readonly number[]): Landmark[] => {
    const out: Landmark[] = []
    for (let k = 0; k + 2 < v.length; k += 3) out.push({ x: v[k], y: v[k + 1], z: v[k + 2] })
    return out
  }
  let face: { t: number; points: Landmark[] } | null = null
  const frames = json.frames.map((fr, i): FrameSample => {
    const t = Math.floor((i * 1000) / (json.fps || 30)) + 1
    const hands: HandSample[] = fr.h.map((h) => ({ handedness: h[0] === 'Left' ? 'Left' : 'Right', score: Number(h[1]), landmarks: points(h.slice(2) as number[]) }))
    if (fr.f) face = { t, points: points(fr.f) }
    const sample: FrameSample = { t, hands: hands.slice(0, 2) }
    if (face && t - face.t <= 150) sample.face = face.points
    return sample
  })
  return { name: json.name, gloss: json.gloss, aspect: json.width / json.height, frames, layout: 'tracked' }
}

/** The clips of a folder (either layout), one at a time. */
function* clipsIn(dir: string): Generator<Clip> {
  const index = evalIndex(dir)
  if (index) {
    for (const e of index) yield { name: e.name, gloss: e.gloss, aspect: e.width / e.height, frames: loadFrames(dir, e), layout: 'holistic' }
    return
  }
  for (const f of readdirSync(dir).sort()) if (f.endsWith('.json') && f.includes('__')) yield trackedClip(join(dir, f))
}

/** Words fired (ms after the clip's first hand), the streaming matcher's way, for these rules in order. */
function replay(clip: Clip, rules: readonly StreamRule[]): { word: string; ms: number }[] {
  let history: FrameSample[] = []
  let face: { box: FaceBox; t: number } | null = null
  const cooldown = new Map<string, number>()
  let lastFire = -Infinity
  const start = clip.frames.find((f) => f.hands.length > 0)?.t ?? 0
  const out: { word: string; ms: number }[] = []
  for (const frame of clip.frames) {
    const box = faceBoxOf(frame.face)
    if (box) face = { box, t: frame.t }
    else if (face && frame.t - face.t > 1000) face = null
    history.push(frame)
    while (history.length > 1 && frame.t - history[0].t > 1500) history.shift()
    if (!frame.hands.length) continue
    const ctx = face ? { aspect: clip.aspect, face: face.box } : { aspect: clip.aspect }
    const hit = rules.find((r) => frame.t - lastFire >= 300 && frame.t >= (cooldown.get(r.word) ?? -Infinity) && r.fires(history, ctx))
    if (!hit) continue
    out.push({ word: hit.word, ms: frame.t - start })
    lastFire = frame.t
    cooldown.set(hit.word, frame.t + 900)
    history = []
  }
  return out
}

interface Result {
  gloss: string
  /** Per rule, run alone: the first fire's time, or null. */
  alone: Record<string, number | null>
  /** All rules together: the first word fired. */
  first: string | null
}

describe.skipIf(DIRS.length === 0)('face signs on ASL Citizen clips', () => {
  it('reports recall, false fires and fire time per word, per folder', () => {
    const seen = new Set<string>()
    for (const dir of DIRS) {
      const results: Result[] = []
      for (const clip of clipsIn(dir)) {
        const key = `${clip.layout}:${clip.name}`
        if (seen.has(key)) continue
        seen.add(key)
        const alone: Record<string, number | null> = {}
        for (const rule of FACE_RULES) alone[rule.word] = replay(clip, [rule])[0]?.ms ?? null
        results.push({ gloss: norm(clip.gloss), alone, first: replay(clip, FACE_RULES)[0]?.word ?? null })
      }
      const lines: string[] = []
      for (const rule of FACE_RULES) {
        const word = rule.word
        const own = results.filter((r) => TARGET[word].includes(r.gloss))
        const others = results.filter((r) => !TARGET[word].includes(r.gloss) && !(EXCLUDE[word] ?? []).includes(r.gloss))
        const hits = own.filter((r) => r.alone[word] !== null)
        const wrong = own.filter((r) => r.first !== null && r.first !== word)
        const falseFires = others.filter((r) => r.alone[word] !== null)
        const demo = others.filter((r) => DEMO.includes(r.gloss))
        const demoFalse = demo.filter((r) => r.alone[word] !== null)
        const times = hits.map((r) => r.alone[word]!).sort((a, b) => a - b)
        const from = new Map<string, number>()
        for (const r of falseFires) from.set(r.gloss, (from.get(r.gloss) ?? 0) + 1)
        const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '-')
        lines.push(
          `${word.padEnd(10)} recall ${`${hits.length}/${own.length}`.padStart(6)} ${pct(hits.length, own.length).padStart(6)}  wrong-word ${wrong.length}  ` +
            `false ${`${falseFires.length}/${others.length}`.padStart(9)} ${pct(falseFires.length, others.length).padStart(5)}  demo ${pct(demoFalse.length, demo.length).padStart(5)}  ` +
            `fire ${times.length ? `${Math.round(times[Math.floor(times.length / 2)])} ms` : '-'}  ` +
            [...from.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
              .map(([g, n]) => `${g} ${n}`)
              .join(', ')
        )
        if (own.length >= MIN_CLIPS) expect(hits.length / own.length, `${word} recall in ${dir}`).toBeGreaterThanOrEqual(MIN_RECALL)
        if (others.length > 0) expect(falseFires.length / others.length, `${word} false fires in ${dir}`).toBeLessThanOrEqual(MAX_FALSE)
      }
      console.log(`\n== ${dir}: ${results.length} clips\n${lines.join('\n')}`)
    }
    expect(seen.size).toBeGreaterThan(0)
  }, 900_000)
})
