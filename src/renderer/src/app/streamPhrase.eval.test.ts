/**
 * Demo commands signed as one phrase (TOMORROW MEETING WHAT TIME, CALL FRIEND, EMAIL FRIEND)
 * through the live wiring: pipeline subscribers → gesture engine → recognition (streaming signs
 * first) → Controller → the Building card. Real signers: each ASL Citizen signer's own clips of
 * the words, joined back to back with the hands staying up (streamEval.ts chainClips).
 *
 * Skipped unless FASTASL_STREAM_DATA names one or more clip folders (comma separated; see
 * streamEval.ts for the layouts), e.g.
 *   FASTASL_STREAM_DATA=~/data/asl-citizen/tracked,~/data/friend/tracked npx vitest run streamPhrase.eval
 * A signer's words may come from several folders of the same layout (FRIEND was fetched
 * separately); the first folder listed that has a word wins. The clips are ASL Citizen research
 * data: they stay outside the repo.
 */
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { STREAM_RULES } from '../engine/recognition/streamRules'
import { evalIndex } from '../engine/model/evalData'
import { chainClips, clipNamed, inOrder, replaySession, signersIn, type EvalClip } from '../engine/recognition/streamEval'
import type { FrameSample } from '../engine/types'
import { Controller } from './controller'
import { startEngines } from './engines'
import { live } from './live'
import { mockServices } from './services'
import { setApp, useApp } from './store'

const camera = vi.hoisted(() => ({
  setExtras: vi.fn(),
  takeTimings: vi.fn(async () => null),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  setSource: vi.fn(async () => {}),
  setEnabled: vi.fn(async () => {}),
  subscribe: vi.fn((_fn: (frame: FrameSample) => void) => () => {}),
  onStatus: vi.fn((_fn: (error: string | null) => void) => () => {})
}))

vi.mock('../engine/camera/pipeline', () => ({
  CameraPipeline: function CameraPipeline() {
    return camera
  }
}))

// No pretrained model here: the streaming signs alone.
vi.mock('../engine/model/runtime', () => ({
  loadSignModel: () => new Promise(() => {}),
  MissingModelError: class MissingModelError extends Error {}
}))

const DIRS = (process.env.FASTASL_STREAM_DATA ?? '')
  .split(',')
  .map((d) => d.trim().replace(/^~/, process.env.HOME ?? ''))
  .filter((d) => d && existsSync(d))

/** ASL Citizen glosses as one spelling: CALL1 = CALL (the Y hand at the ear), THANK_YOU = THANKYOU. */
const norm = (gloss: string): string => gloss.replace(/_/g, '').replace(/1$/, '')

/** Each signer's clips of the phrase's glosses, joined; signers grouped per folder layout. */
function phrases(glosses: readonly string[]): EvalClip[] {
  const bySigner = new Map<string, Map<string, { dir: string; name: string }>>()
  for (const dir of DIRS) {
    const layout = evalIndex(dir) ? 'holistic' : 'tracked'
    for (const [name, signer] of signersIn(dir)) {
      const key = `${layout}:${signer}`
      const words = bySigner.get(key) ?? new Map<string, { dir: string; name: string }>()
      const gloss = norm(name.split('__')[0])
      if (!words.has(gloss)) words.set(gloss, { dir, name })
      bySigner.set(key, words)
    }
  }
  const out: EvalClip[] = []
  for (const [key, words] of [...bySigner.entries()].sort()) {
    if (!glosses.every((g) => words.has(g))) continue
    const clips = glosses.map((g) => clipNamed(words.get(g)!.dir, words.get(g)!.name))
    if (clips.some((c) => !c)) continue
    out.push({ ...chainClips(clips as EvalClip[]), name: key })
  }
  return out
}

let controller: Controller
let stop: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    fastasl: {
      isDev: false,
      saveSettings: vi.fn(async () => ({})),
      getGestures: vi.fn(async () => []),
      getTemplates: vi.fn(async () => ({ version: 1, templates: [] })),
      saveTemplates: vi.fn(async () => {})
    }
  })
  useApp.setState(useApp.getInitialState(), true)
  setApp({ mode: 'command' })
  controller = new Controller(mockServices())
})

afterEach(() => {
  stop?.()
  stop = null
  controller.dispose()
  Object.assign(live, { source: null, sourceWidth: 0, sourceHeight: 0, mock: true })
  vi.unstubAllGlobals()
})

/** The phrase through the live wiring: the words the controller got, and the control gestures that acted. */
function signLive(clip: EvalClip): { words: string[]; gestures: string[] } {
  stop?.()
  useApp.setState(useApp.getInitialState(), true)
  setApp({ mode: 'command' })
  controller.dispose()
  controller = new Controller(mockServices())
  Object.assign(live, { source: {} as CanvasImageSource, sourceWidth: Math.round(480 * clip.aspect), sourceHeight: 480, mock: false })
  stop = startEngines(controller)
  const subscribers = camera.subscribe.mock.calls.slice(-4).map(([fn]) => fn)
  const words: string[] = []
  const token = controller.token.bind(controller)
  const spy = vi.spyOn(controller, 'token').mockImplementation((t) => {
    words.push(t.text)
    token(t)
  })
  let now = 0
  const at: number[] = []
  const act = controller.gesture.bind(controller)
  const gesture = vi.spyOn(controller, 'gesture').mockImplementation((g) => {
    at.push(now)
    act(g)
  })
  for (const frame of clip.frames) {
    now = frame.t
    subscribers.forEach((fn) => fn(frame))
  }
  if (process.env.FASTASL_STREAM_VERBOSE) console.log(clip.name, 'gestures at', at.join(' '))
  spy.mockRestore()
  const gestures = gesture.mock.calls.map(([g]) => g.gesture as string)
  gesture.mockRestore()
  return { words, gestures }
}

const PHRASES: { glosses: string[]; words: string[]; minInOrder: number }[] = [
  { glosses: ['TOMORROW', 'MEETING', 'WHAT2', 'TIME'], words: ['tomorrow', 'meeting', 'what', 'time'], minInOrder: 0 },
  // The FRIEND phrases: both words, in order, for most signers (CALL's and EMAIL's own recall
  // is what misses the rest; DECISIONS.md "Streaming FRIEND").
  { glosses: ['CALL', 'FRIEND'], words: ['call', 'friend'], minInOrder: 0.5 },
  { glosses: ['EMAIL', 'FRIEND'], words: ['email', 'friend'], minInOrder: 0.4 }
]

describe.skipIf(DIRS.length === 0)('demo commands signed as one phrase, through the live wiring', () => {
  for (const { glosses, words, minInOrder } of PHRASES) {
    it(`streams ${glosses.join(' ')} word by word, losing nothing the matcher found`, () => {
      const all = phrases(glosses)
      if (!all.length) {
        console.log(`\nno signer has all of ${glosses.join(' ')} in ${DIRS.join(', ')}`)
        return
      }
      const lines: string[] = []
      let exact = 0
      let ordered = 0
      for (const clip of all) {
        const { words: card, gestures } = signLive(clip)
        const streamed = replaySession(clip, { dictionary: DEFAULT_DICTIONARY, rules: STREAM_RULES }).hits.map((h) => h.word)
        const r = inOrder(card, words)
        if (r.exact) exact++
        if (r.matched === words.length) ordered++
        const acted = gestures.length ? `   gestures: ${gestures.join(' ')}` : ''
        lines.push(`${clip.name.padEnd(13)} ${r.exact ? 'OK' : r.matched === words.length ? 'in' : '  '} live: ${card.join(' ') || '-'}   (matcher: ${streamed.join(' ') || '-'})${acted}`)
        // The wiring adds nothing and drops nothing: the controller gets exactly what the matcher
        // streamed, unless a control gesture ended the phrase early (then a prefix of it).
        expect(card).toEqual(streamed.slice(0, card.length))
        if (card.length < streamed.length) expect(gestures.length).toBeGreaterThan(0)
      }
      console.log(`\n${glosses.join(' ')}: ${exact}/${all.length} signers' phrases came out exactly, ${ordered}/${all.length} with every word in order\n${lines.join('\n')}`)
      expect(ordered / all.length).toBeGreaterThanOrEqual(minInOrder)
    })
  }
})
