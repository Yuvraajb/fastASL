/**
 * FRIEND on REAL signers (ASL Citizen), streamed frame by frame the way StreamingSignMatcher runs
 * it: recall on FRIEND clips (split into the signers it was tuned on and held-out signers), false
 * fires on every other clip (the demo words and out-of-vocabulary signs), how soon it fires, and,
 * through the whole matcher (dictionary + STREAM_RULES), what the FRIEND clips come out as.
 *
 * Skipped unless FASTASL_STREAM_DATA names one or more clip folders (comma separated; layouts in
 * streamEval.ts). ASL Citizen is research data and never committed. FRIEND clips were fetched on
 * their own (29 clips, 29 signers): the HF mirror's Holistic `.pose` files converted to an evalData
 * folder, and the same videos re-tracked with the app's hand and face landmarkers. Tuned on the
 * signers of ASL Citizen's train split ("train" in index.json / signers.json), held out: the rest.
 * e.g. FASTASL_STREAM_DATA=~/data/friend/bin,~/data/friend/tracked,~/data/citizen-bin/files,~/data/tracked
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { evalIndex } from '../../model/evalData'
import type { FrameSample, HandSample } from '../../types'
import { clipsIn, replayStream, type EvalClip } from '../streamEval'
import { STREAM_RULES } from '.'
import { friend, friendMiss } from './friend'

const DIRS = (process.env.FASTASL_STREAM_DATA ?? '')
  .split(',')
  .map((d) => d.trim().replace(/^~/, process.env.HOME ?? ''))
  .filter((d) => d && existsSync(d))

const norm = (gloss: string): string => gloss.replace(/_/g, '')
/** The demo words' glosses: FRIEND must not fire on these. */
const DEMO = ['MEETING', 'WHAT1', 'WHAT2', 'TIME', 'EMAIL', 'OPEN', 'PLAY', 'CALL1', 'CALL', 'PHONE']

/** loadFrames labels the signer's right hand 'Left'; the app's tracker labels it 'Right'. */
const flip = (h: HandSample): HandSample => ({ ...h, handedness: h.handedness === 'Left' ? 'Right' : 'Left' })

/** Each clip's split ('train' = tuned on), from index.json or signers.json. */
function splits(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const index = evalIndex(dir) as ({ name: string; split?: string }[] | null)
  if (index) for (const e of index) out.set(e.name, e.split ?? '?')
  else if (existsSync(join(dir, 'signers.json'))) {
    const map = JSON.parse(readFileSync(join(dir, 'signers.json'), 'utf8')) as Record<string, { split?: string }>
    for (const [name, v] of Object.entries(map)) out.set(name, v.split ?? '?')
  }
  return out
}

/** Reasons every window gives on the way to a sign (one hand, nothing hooked yet): not why a clip missed. */
const ROUTINE = /^(one hand now|few two-hand frames|no hook now|no release|no first hook)/

/** Why FRIEND missed a clip: its most frequent non-routine reason (friendMiss) over the clip's windows. */
function whyMissed(clip: EvalClip): string {
  const counts = new Map<string, number>()
  const history: FrameSample[] = []
  for (const f of clip.frames) {
    history.push(f)
    while (history.length > 1 && f.t - history[0].t > 1500) history.shift()
    if (!f.hands.length) continue
    const why = friendMiss(history, { aspect: clip.aspect }).replace(/ [-\d. ]+$/, '')
    if (why && !ROUTINE.test(why)) counts.set(why, (counts.get(why) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'never hooked twice'
}

interface Result {
  name: string
  gloss: string
  split: string
  /** FRIEND alone: when it fired (ms after the first hand in view), or null. */
  alone: number | null
  /** The whole matcher's words. */
  words: string[]
  /** Why FRIEND missed it (FRIEND clips only). */
  why?: string
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '-')
const median = (xs: number[]): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null)

describe.skipIf(DIRS.length === 0)('FRIEND on real signers (local ASL Citizen data)', () => {
  it('fires on most FRIEND clips, held-out signers included, and almost never on anything else', () => {
    const lines: string[] = []
    const all: Result[] = []
    for (const dir of DIRS) {
      const split = splits(dir)
      const holistic = evalIndex(dir) !== null
      const results: Result[] = []
      for (const raw of clipsIn(dir)) {
        const clip: EvalClip = holistic ? { ...raw, frames: raw.frames.map((f) => ({ ...f, hands: f.hands.map(flip) })) } : raw
        const gloss = norm(clip.gloss)
        const alone = replayStream(clip, { rules: [friend] })
        // The whole matcher only matters on FRIEND and the demo words (it is slow on thousands of clips).
        const words = gloss === 'FRIEND' || DEMO.includes(gloss) ? replayStream(clip, { dictionary: DEFAULT_DICTIONARY, rules: STREAM_RULES }).map((h) => h.word) : []
        const why = gloss === 'FRIEND' && !alone.length ? whyMissed(clip) : undefined
        results.push({ name: clip.name, gloss, split: split.get(clip.name) ?? '?', alone: alone[0]?.ms ?? null, words, why })
      }
      all.push(...results)
      const mine = results.filter((r) => r.gloss === 'FRIEND')
      const others = results.filter((r) => r.gloss !== 'FRIEND')
      const hit = (rs: Result[]): number => rs.filter((r) => r.alone !== null).length
      const tuned = mine.filter((r) => r.split === 'train')
      const held = mine.filter((r) => r.split !== 'train')
      const ff = others.filter((r) => r.alone !== null)
      const from = new Map<string, number>()
      for (const r of ff) from.set(r.gloss, (from.get(r.gloss) ?? 0) + 1)
      const m = median(mine.flatMap((r) => (r.alone === null ? [] : [r.alone])))
      lines.push(`-- ${dir} (${results.length} clips)`)
      if (mine.length) {
        const matcher = new Map<string, number>()
        for (const r of mine) for (const w of new Set(r.words)) matcher.set(w, (matcher.get(w) ?? 0) + 1)
        lines.push(
          `FRIEND recall ${hit(mine)}/${mine.length} ${pct(hit(mine), mine.length)} (tuned ${hit(tuned)}/${tuned.length}, held-out ${hit(held)}/${held.length})  fire ${m === null ? '-' : `${Math.round(m)} ms`}`,
          `  through the matcher, words on FRIEND clips: ${[...matcher.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ')}`,
          `  missed: ${mine.filter((r) => r.why).map((r) => `${r.name} (${r.split}: ${r.why})`).join(', ') || '-'}`
        )
      }
      if (others.length) {
        const top = [...from.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g, n]) => `${g} ${n}`).join(', ')
        lines.push(`false fires ${ff.length}/${others.length} ${pct(ff.length, others.length)}${top ? `  from ${top}` : ''}`)
      }
    }
    console.log(`\n${lines.join('\n')}`)

    const mine = all.filter((r) => r.gloss === 'FRIEND')
    const others = all.filter((r) => r.gloss !== 'FRIEND')
    if (mine.length) {
      expect(mine.filter((r) => r.alone !== null).length / mine.length, 'FRIEND recall').toBeGreaterThanOrEqual(0.75)
      const held = mine.filter((r) => r.split !== 'train')
      if (held.length >= 5) expect(held.filter((r) => r.alone !== null).length / held.length, 'held-out recall').toBeGreaterThanOrEqual(0.75)
      // Through the whole matcher, FRIEND clips come out as FRIEND, not TIME or MEETING.
      expect(mine.filter((r) => r.words.includes('friend')).length / mine.length, 'FRIEND through the matcher').toBeGreaterThanOrEqual(0.75)
      expect(mine.filter((r) => r.words.includes('time')).length / mine.length, 'TIME on FRIEND clips').toBeLessThanOrEqual(0.1)
    }
    if (others.length) {
      expect(others.filter((r) => r.alone !== null).length / others.length, 'false fires').toBeLessThanOrEqual(0.02)
      const demo = others.filter((r) => DEMO.includes(r.gloss))
      expect(demo.filter((r) => r.alone !== null).map((r) => r.name), 'false fires on the demo words').toEqual([])
    }
  }, 900_000)
})
