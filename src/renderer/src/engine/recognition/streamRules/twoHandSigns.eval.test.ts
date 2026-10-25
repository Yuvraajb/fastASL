/**
 * The two-hand stream rules on REAL signers (ASL Citizen), streamed frame by frame the way
 * StreamingSignMatcher runs them: per word, recall on its clips, false fires on every other clip
 * (other demo words and out-of-vocabulary signs) and how soon it fires.
 *
 * Skipped unless FASTASL_STREAM_DATA names one or more clip folders (comma separated). ASL Citizen
 * is research data and never committed. Two layouts:
 *  - evalData folders (`index.json` + `<name>.bin`, engine/model/evalData.ts): MediaPipe Holistic
 *    poses, z flat. loadFrames labels the signer's right hand 'Left'; the app's HandLandmarker
 *    labels it 'Right', so the labels are flipped here to match the live app.
 *  - tracked folders (`<GLOSS>__<id>.json`): the app's own hand and face landmarkers run on the
 *    videos (real z, the tracker's labels, the face on every other frame).
 * e.g. FASTASL_STREAM_DATA=~/data/citizen-bin/files,~/data/citizen-bin/test,~/data/tracked
 * The `files` folder is the tuning split; the others were held out (see the printed table).
 * FRIEND clips in the folders (friend.eval.test.ts says where they come from) are checked on their
 * own too: two X hands hooking look like TIME's tap, so TIME must stay off them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Landmark } from '@shared/types'
import { evalIndex, loadFrames } from '../../model/evalData'
import type { FrameSample, HandSample } from '../../types'
import { TWO_HAND_RULES } from './twoHandSigns'
import type { FaceBox, StreamRule } from './types'

const DIRS = (process.env.FASTASL_STREAM_DATA ?? '')
  .split(',')
  .map((d) => d.trim().replace(/^~/, process.env.HOME ?? ''))
  .filter((d) => d && existsSync(d))

/** ASL Citizen gloss (underscores dropped) → the rule word it is. Both WHAT forms are "what". */
const WORD_OF: Record<string, string> = {
  OPEN: 'open',
  MUSIC: 'music',
  PLAY: 'play',
  STOP: 'stop',
  TIME: 'time',
  EMAIL: 'email',
  WHAT1: 'what',
  WHAT2: 'what',
  PLEASE: 'please'
}

interface Clip {
  name: string
  gloss: string
  aspect: number
  frames: FrameSample[]
}

function faceBox(points: readonly Landmark[] | undefined): FaceBox | undefined {
  if (!points?.length) return undefined
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i < Math.min(points.length, 468); i++) {
    const { x, y } = points[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    ;[x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]
  }
  return x1 > x0 && y1 > y0 ? { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 } : undefined
}

const flip = (h: HandSample): HandSample => ({ ...h, handedness: h.handedness === 'Left' ? 'Right' : 'Left' })

/** A folder's clips, one at a time (face meshes for thousands of clips don't fit in memory). */
function* clipsIn(dir: string): Generator<Clip> {
  const index = evalIndex(dir)
  if (index) {
    for (const e of index) {
      const frames = loadFrames(dir, e).map((f) => ({ ...f, hands: f.hands.map(flip) }))
      yield { name: e.name, gloss: e.gloss.replace(/_/g, ''), aspect: e.width / e.height, frames }
    }
    return
  }
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || !file.includes('__')) continue
    const json = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      name: string
      gloss: string
      fps: number
      width: number
      height: number
      frames: { h: (string | number)[][]; f: number[] | null }[]
    }
    let face: { t: number; points: Landmark[] } | null = null
    const frames = json.frames.map((fr, i): FrameSample => {
      const t = Math.floor((i * 1000) / (json.fps || 30)) + 1
      const hands: HandSample[] = fr.h.slice(0, 2).map((h) => {
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
      // The app reuses a face result for 150 ms on frames that skip the face.
      return face && t - face.t <= 150 ? { t, hands, face: face.points } : { t, hands }
    })
    yield { name: json.name, gloss: json.gloss.replace(/_/g, ''), aspect: json.width / json.height, frames }
  }
}

/** StreamingSignMatcher's loop: ≤ 1.5 s history, face box held 1 s, first rule wins, history cleared, cooldowns. */
function stream(clip: Clip, rules: readonly StreamRule[]): { word: string; ms: number }[] {
  const out: { word: string; ms: number }[] = []
  const start = clip.frames.find((f) => f.hands.length)?.t ?? 0
  let history: FrameSample[] = []
  let face: { box: FaceBox; t: number } | null = null
  let lastFire = -Infinity
  const cooldown = new Map<string, number>()
  for (const f of clip.frames) {
    const box = faceBox(f.face)
    if (box) face = { box, t: f.t }
    else if (face && f.t - face.t > 1000) face = null
    history.push(f)
    while (history.length > 1 && f.t - history[0].t > 1500) history.shift()
    if (!f.hands.length) continue
    const ctx = face ? { aspect: clip.aspect, face: face.box } : { aspect: clip.aspect }
    const ready = (w: string): boolean => f.t - lastFire >= 300 && f.t >= (cooldown.get(w) ?? -Infinity)
    const hit = rules.find((r) => ready(r.word) && r.fires(history, ctx))
    if (!hit) continue
    out.push({ word: hit.word, ms: f.t - start })
    lastFire = f.t
    cooldown.set(hit.word, f.t + 900)
    history = []
  }
  return out
}

interface Result {
  dir: string
  name: string
  gloss: string
  words: { word: string; ms: number }[]
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '-')
const median = (xs: number[]): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null)

function table(results: readonly Result[], title: string): { lines: string[]; rows: Map<string, { recall: Map<string, [number, number]>; ff: [number, number] }> } {
  const lines = [`-- ${title} (${results.length} clips)`]
  const rows = new Map<string, { recall: Map<string, [number, number]>; ff: [number, number] }>()
  for (const { word } of TWO_HAND_RULES) {
    const glosses = Object.keys(WORD_OF).filter((g) => WORD_OF[g] === word)
    const recall = new Map<string, [number, number]>()
    const times: number[] = []
    for (const g of glosses) {
      const mine = results.filter((r) => r.gloss === g)
      const hits = mine.filter((r) => r.words.some((w) => w.word === word))
      for (const r of hits) times.push(r.words.find((w) => w.word === word)!.ms)
      recall.set(g, [hits.length, mine.length])
    }
    const others = results.filter((r) => WORD_OF[r.gloss] !== word)
    const ff = others.filter((r) => r.words.some((w) => w.word === word))
    const from = new Map<string, number>()
    for (const r of ff) from.set(r.gloss, (from.get(r.gloss) ?? 0) + 1)
    const top = [...from.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, n]) => `${g} ${n}`).join(', ')
    const rec = [...recall.entries()].map(([g, [h, n]]) => `${g} ${h}/${n} ${pct(h, n)}`).join('  ')
    const m = median(times)
    lines.push(`${word.padEnd(7)} recall ${rec.padEnd(34)} false ${`${ff.length}/${others.length}`.padStart(9)} ${pct(ff.length, others.length).padStart(6)}  fire ${m === null ? '-' : `${Math.round(m)} ms`}${top ? `  from ${top}` : ''}`)
    rows.set(word, { recall, ff: [ff.length, others.length] })
  }
  return { lines, rows }
}

describe.skipIf(DIRS.length === 0)('two-hand stream rules on real signers (local ASL Citizen data)', () => {
  it('fires each word on its own clips, rarely on anyone else’s', () => {
    const results: Result[] = []
    const seen = new Set<string>()
    for (const dir of DIRS) {
      for (const clip of clipsIn(dir)) {
        // The same clip in two evalData folders is counted once (tracked clips are their own copy).
        const key = `${evalIndex(dir) ? 'holistic' : 'tracked'}:${clip.name}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ dir, name: clip.name, gloss: clip.gloss, words: stream(clip, TWO_HAND_RULES) })
      }
    }
    expect(results.length).toBeGreaterThan(0)
    const out: string[] = []
    for (const dir of DIRS) out.push(...table(results.filter((r) => r.dir === dir), dir).lines)
    const all = table(results, 'all folders')
    out.push(...all.lines)
    const anyFire = results.filter((r) => !WORD_OF[r.gloss] && r.words.length).length
    out.push(`clips of other glosses where any of these words fired: ${pct(anyFire, results.filter((r) => !WORD_OF[r.gloss]).length)}`)
    const friends = results.filter((r) => r.gloss === 'FRIEND')
    const timeOnFriend = friends.filter((r) => r.words.some((w) => w.word === 'time')).length
    if (friends.length) out.push(`TIME on FRIEND clips: ${timeOnFriend}/${friends.length} ${pct(timeOnFriend, friends.length)}`)
    console.log(`\n${out.join('\n')}`)
    if (friends.length) expect(timeOnFriend / friends.length, 'TIME on FRIEND clips').toBeLessThanOrEqual(0.1)

    for (const [word, { recall, ff }] of all.rows) {
      // WHAT has two forms whose names differ between sources; the rule needs one of them.
      const best = Math.max(...[...recall.values()].filter(([, n]) => n > 0).map(([h, n]) => h / n))
      if (Number.isFinite(best)) expect(best, `${word} recall`).toBeGreaterThanOrEqual(0.5)
      if (ff[1] > 0) expect(ff[0] / ff[1], `${word} false fires`).toBeLessThanOrEqual(0.05)
    }
  }, 600_000)
})
