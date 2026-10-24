import type { FrameSample } from '../types'
import { combine, moreConfident, wordProbabilities, type ModelDecision, type WordScore } from './decide'
import { citizenInput, CITIZEN_FRAMES, CITIZEN_KEYPOINTS, hasFace, hasPose, islrInput, ISLR_POINTS } from './inputs'
import islrLabels from './islrLabels.json'
import { enabledFor, SIGN_VOCABULARY, type SignWord } from './vocabulary'

/** One loaded ONNX model: float32 input of `dims` in, its first output out. */
export interface ModelSession {
  run(input: Float32Array, dims: readonly number[]): Promise<Float32Array>
}

export interface SignModelParts {
  /** The Kaggle "asl-signs" 1st-place model: [T, 543, 3] in, 250 logits out. */
  islr: ModelSession
  /** ASL Citizen's ST-GCN and its class glosses, when `npm run setup:citizen` installed them. */
  citizen?: { session: ModelSession; labels: readonly string[] } | null
  vocabulary?: readonly SignWord[]
}

/** One model's answer for a movement. */
export interface ModelRun {
  ranked: WordScore[]
  /** The hands went in each other's slots (the swapped assignment was more confident). */
  swapped: boolean
  ms: number
}

/**
 * A movement and the camera frames around it: `frames[start..end]` (inclusive) is the movement the
 * segmenter cut out, and the frames before and after it are context the models may use.
 */
export interface MovementWindow {
  frames: readonly FrameSample[]
  start: number
  end: number
}

/** Context frames each model gets around the movement (each side is cut to what the window has). */
export const ISLR_PAD = { before: 5, after: 5 }
/**
 * ASL Citizen was trained on whole clips, hands at rest included: on its held-out signers, 15
 * frames before and 9 after (all the camera has seen when the movement is decided) put the true
 * sign first among its 2731 for 55% of clips, against 47% with 5 and 5 (59% for whole clips).
 */
export const CITIZEN_PAD = { before: 15, after: 9 }

/** The movement plus up to `pad` frames of context each side. */
export function padded(w: MovementWindow, pad: { before: number; after: number }): readonly FrameSample[] {
  return w.frames.slice(Math.max(0, w.start - pad.before), Math.min(w.frames.length, w.end + 1 + pad.after))
}

/** A bare list of frames is a movement with no context around it. */
export function windowOf(frames: readonly FrameSample[]): MovementWindow {
  return { frames, start: 0, end: frames.length - 1 }
}

export interface ModelVerdict {
  decision: ModelDecision & { source?: 'islr' | 'citizen' }
  islr: ModelRun | null
  /** Null when ASL Citizen isn't installed, had no body pose, or wasn't needed (Kaggle accepted). */
  citizen: ModelRun | null
  face: boolean
  pose: boolean
  frames: number
  ms: number
}

interface Group {
  word: string
  classes: number[]
}

const ISLR_INDEX = islrLabels as Record<string, number>

/**
 * The pretrained sign recognizers behind one call: classify(frames) runs the Kaggle model on both
 * hand-slot assignments and, when it doesn't accept and ASL Citizen is installed, the ST-GCN
 * (both assignments in one batch), then combines them (decide.ts).
 */
export class SignModel {
  private readonly islr: ModelSession
  private readonly citizen: { session: ModelSession; groups: Group[] } | null
  private readonly islrGroups: Group[]
  private readonly islrWords: Set<string>
  /** The words this model can name now: enabled ones, Citizen-only ones only when it is installed. */
  readonly words: readonly string[]

  constructor(parts: SignModelParts) {
    const vocabulary = parts.vocabulary ?? SIGN_VOCABULARY
    this.islr = parts.islr
    this.islrGroups = enabledFor('islr', vocabulary).flatMap((w) => {
      const index = ISLR_INDEX[w.islr!]
      return index === undefined ? [] : [{ word: w.word, classes: [index] }]
    })
    this.islrWords = new Set(this.islrGroups.map((g) => g.word))
    const citizen = parts.citizen
    if (citizen) {
      const index = new Map(citizen.labels.map((gloss, i) => [gloss, i]))
      const groups = enabledFor('citizen', vocabulary)
        .map((w) => ({ word: w.word, classes: (w.citizen ?? []).flatMap((g) => (index.has(g) ? [index.get(g)!] : [])) }))
        .filter((g) => g.classes.length > 0)
      this.citizen = groups.length ? { session: citizen.session, groups } : null
    } else {
      this.citizen = null
    }
    const citizenWords = new Set(this.citizen?.groups.map((g) => g.word) ?? [])
    this.words = vocabulary.filter((w) => this.islrWords.has(w.word) || citizenWords.has(w.word)).map((w) => w.word)
  }

  get hasCitizen(): boolean {
    return this.citizen !== null
  }

  async classify(movement: MovementWindow | readonly FrameSample[]): Promise<ModelVerdict> {
    const start = now()
    const w = 'start' in movement ? movement : windowOf(movement)
    const frames = padded(w, ISLR_PAD)
    const face = hasFace(frames)
    const pose = hasPose(frames)
    const verdict = (decision: ModelVerdict['decision'], islr: ModelRun | null, citizen: ModelRun | null): ModelVerdict => ({
      decision,
      islr,
      citizen,
      face,
      pose,
      frames: frames.length,
      ms: now() - start
    })
    if (!frames.some((f) => f.hands.length > 0)) return verdict({ status: 'rejected' }, null, null)

    const islr = await this.runIslr(frames)
    const kaggleOnly = combine(islr.ranked, null, this.islrWords)
    if (kaggleOnly.status === 'accepted' || !this.citizen || !pose) return verdict(kaggleOnly, islr, null)
    const citizen = await this.runCitizen(padded(w, CITIZEN_PAD), this.citizen)
    return verdict(combine(islr.ranked, citizen.ranked, this.islrWords), islr, citizen)
  }

  private async runIslr(frames: readonly FrameSample[]): Promise<ModelRun> {
    const t0 = now()
    const dims = [frames.length, ISLR_POINTS, 3]
    const rank = async (swapped: boolean): Promise<{ ranked: WordScore[]; swapped: boolean }> => ({
      ranked: wordProbabilities(await this.islr.run(islrInput(frames, swapped), dims), this.islrGroups),
      swapped
    })
    const asTracked = await rank(false)
    // The safety net for the handedness labels (inputs.ts): the swapped assignment, kept if surer.
    const best = moreConfident(asTracked, await rank(true))
    return { ...best, ms: now() - t0 }
  }

  private async runCitizen(frames: readonly FrameSample[], citizen: { session: ModelSession; groups: Group[] }): Promise<ModelRun> {
    const t0 = now()
    const size = 2 * CITIZEN_FRAMES * CITIZEN_KEYPOINTS.length
    const batch = new Float32Array(2 * size)
    batch.set(citizenInput(frames, false), 0)
    batch.set(citizenInput(frames, true), size)
    const logits = await citizen.session.run(batch, [2, 2, CITIZEN_FRAMES, CITIZEN_KEYPOINTS.length])
    const classes = logits.length / 2
    const asTracked = { ranked: wordProbabilities(logits.subarray(0, classes), citizen.groups), swapped: false }
    const swapped = { ranked: wordProbabilities(logits.subarray(classes), citizen.groups), swapped: true }
    return { ...moreConfident(asTracked, swapped), ms: now() - t0 }
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
