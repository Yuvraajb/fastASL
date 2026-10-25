/**
 * A demo command signed as one phrase, TOMORROW MEETING WHAT TIME, through the live wiring:
 * pipeline subscribers → gesture engine → recognition (streaming signs first) → Controller →
 * the Building card. Real signers: each ASL Citizen signer's own clips of the four words, joined
 * back to back with the hands staying up (streamEval.ts chainClips).
 *
 * Skipped unless FASTASL_STREAM_DATA names one or more clip folders (comma separated; see
 * streamEval.ts for the layouts), e.g.
 *   FASTASL_STREAM_DATA=~/data/asl-citizen/tracked npx vitest run streamPhrase.eval
 * The clips are ASL Citizen research data: they stay outside the repo.
 */
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { STREAM_RULES } from '../engine/recognition/streamRules'
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

const PHRASE = ['TOMORROW', 'MEETING', 'WHAT2', 'TIME']
const WORDS = ['tomorrow', 'meeting', 'what', 'time']

/** Each signer's phrase, from the first folder that has all four words for them. */
function phrases(): EvalClip[] {
  const out: EvalClip[] = []
  const seen = new Set<string>()
  for (const dir of DIRS) {
    const bySigner = new Map<string, Map<string, string>>()
    for (const [name, signer] of signersIn(dir)) {
      const words = bySigner.get(signer) ?? new Map<string, string>()
      const gloss = name.split('__')[0]
      if (!words.has(gloss)) words.set(gloss, name)
      bySigner.set(signer, words)
    }
    for (const [signer, words] of bySigner) {
      if (seen.has(signer) || !PHRASE.every((g) => words.has(g))) continue
      const clips = PHRASE.map((g) => clipNamed(dir, words.get(g)!))
      if (clips.some((c) => !c)) continue
      seen.add(signer)
      out.push({ ...chainClips(clips as EvalClip[]), name: signer })
    }
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

describe.skipIf(DIRS.length === 0)('a demo command signed as one phrase, through the live wiring', () => {
  it('streams TOMORROW MEETING WHAT TIME word by word, losing nothing the matcher found', () => {
    const all = phrases()
    expect(all.length).toBeGreaterThan(0)
    const lines: string[] = []
    let exact = 0
    for (const clip of all) {
      const { words: card, gestures } = signLive(clip)
      const streamed = replaySession(clip, { dictionary: DEFAULT_DICTIONARY, rules: STREAM_RULES }).hits.map((h) => h.word)
      const r = inOrder(card, WORDS)
      if (r.exact) exact++
      const acted = gestures.length ? `   gestures: ${gestures.join(' ')}` : ''
      lines.push(`${clip.name.padEnd(4)} ${r.exact ? 'OK' : '  '} live: ${card.join(' ') || '-'}   (matcher: ${streamed.join(' ') || '-'})${acted}`)
      // The wiring adds nothing and drops nothing: the controller gets exactly what the matcher
      // streamed, unless a control gesture ended the phrase early (then a prefix of it).
      expect(card).toEqual(streamed.slice(0, card.length))
      if (card.length < streamed.length) expect(gestures.length).toBeGreaterThan(0)
    }
    console.log(`\n${exact}/${all.length} signers' phrases came out exactly\n${lines.join('\n')}`)
  })
})
