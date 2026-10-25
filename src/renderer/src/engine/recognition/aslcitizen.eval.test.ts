import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import type { FrameSample } from '../types'
import { RecognitionSession } from './session'

/*
 * Replays real ASL Citizen clips (extracted by scripts/aslcitizen/extract.py) through the recognizer and
 * reports, per word: recall, false triggers on other words, and how early the token appears.
 * Skipped unless ASL_CITIZEN_DIR points at the extracted frames folder, e.g.
 *   ASL_CITIZEN_DIR=~/data/asl-citizen/frames npx vitest run aslcitizen.eval
 * The data is non-commercial research data: it stays outside the repo and nothing here uploads it.
 */

const DIR = process.env.ASL_CITIZEN_DIR?.replace(/^~/, process.env.HOME ?? '')

interface Clip {
  gloss: string
  clip: string
  width: number
  height: number
  frames: FrameSample[]
}

function loadClips(dir: string): Clip[] {
  return readdirSync(dir).flatMap((gloss) => {
    const gdir = join(dir, gloss)
    return readdirSync(gdir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(gdir, f), 'utf8')) as Clip)
  })
}

/** Tokens a clip produces, with the time since the first frame that has a hand. */
function replay(clip: Clip): { gloss: string; ms: number }[] {
  const session = new RecognitionSession({ aspect: clip.width / clip.height, dictionary: DEFAULT_DICTIONARY })
  session.setMode('command')
  const start = clip.frames.find((f) => f.hands.length > 0)?.t ?? 0
  const out: { gloss: string; ms: number }[] = []
  for (const frame of clip.frames) {
    for (const e of session.update(frame)) if (e.type === 'token') out.push({ gloss: e.text, ms: frame.t - start })
  }
  return out
}

const median = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN)

describe.skipIf(!DIR || !existsSync(DIR))('ASL Citizen replay', () => {
  it('reports recall, false triggers and latency per word', () => {
    const clips = loadClips(DIR as string)
    const known = new Set(DEFAULT_DICTIONARY.signs.map((s) => s.gloss))
    const lines: string[] = []
    for (const gloss of [...new Set(clips.map((c) => c.gloss))].sort()) {
      const mine = clips.filter((c) => c.gloss === gloss)
      const results = mine.map(replay)
      const hit = results.filter((r) => r.some((t) => t.gloss === gloss)).length
      const wrong = results.filter((r) => r.some((t) => t.gloss !== gloss && known.has(t.gloss))).length
      const lat = results.flatMap((r) => r.filter((t) => t.gloss === gloss).slice(0, 1).map((t) => t.ms))
      lines.push(
        `${gloss.padEnd(14)} clips ${String(mine.length).padStart(3)}  ` +
          `${known.has(gloss) ? `recall ${((100 * hit) / mine.length).toFixed(0)}%` : 'not in dictionary'}  ` +
          `other-word triggers ${wrong}  median fire ${Number.isNaN(median(lat)) ? '-' : Math.round(median(lat)) + ' ms'}`
      )
    }
    console.log('\n' + lines.join('\n'))
    expect(clips.length).toBeGreaterThan(0)
  })
})
