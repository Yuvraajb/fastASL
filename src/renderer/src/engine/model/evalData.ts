/**
 * Test-only: real landmark sequences for the pretrained-model tests, read from a local folder
 * (FASTASL_SIGN_DATA) that is never committed. ASL Citizen's poses can't be redistributed, so the
 * tests that use them skip when the folder is absent.
 *
 * Folder layout: `index.json` = [{ name, gloss, frames, fps, width, height }], and per entry
 * `<name>.bin` = float32 little-endian [frames, 543, 3] in the Kaggle point order (face 0-467,
 * the signer's left hand 468-488, pose 489-521, the signer's right hand 522-542), x / width,
 * y / height, z / width, NaN where MediaPipe Holistic had no point. TESTING.md says how to make it
 * from ASL Citizen .pose files.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Landmark } from '@shared/types'
import type { FrameSample, HandSample } from '../types'
import { ISLR_POINTS } from './inputs'
import type { MovementWindow } from './signModel'
import { SIGN_VOCABULARY } from './vocabulary'

export interface EvalEntry {
  name: string
  gloss: string
  frames: number
  fps: number
  width: number
  height: number
}

export function evalIndex(dir: string | undefined): EvalEntry[] | null {
  if (!dir || !existsSync(join(dir, 'index.json'))) return null
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as EvalEntry[]
}

/**
 * The clip as the camera pipeline would deliver it: hands with HandLandmarker's labels for a raw
 * frame (the signer's right hand is labelled 'Left'), the face and the pose when present.
 */
export function loadFrames(dir: string, entry: EvalEntry): FrameSample[] {
  const buf = readFileSync(join(dir, `${entry.name}.bin`))
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const T = data.length / (ISLR_POINTS * 3)
  const points = (t: number, from: number, count: number): Landmark[] | undefined => {
    const out: Landmark[] = []
    for (let i = 0; i < count; i++) {
      const o = (t * ISLR_POINTS + from + i) * 3
      out.push({ x: data[o], y: data[o + 1], z: data[o + 2] })
    }
    return out.some((p) => Number.isFinite(p.x)) ? out : undefined
  }
  const frames: FrameSample[] = []
  for (let t = 0; t < T; t++) {
    const hands: HandSample[] = []
    const left = points(t, 468, 21)
    const right = points(t, 522, 21)
    if (right) hands.push({ landmarks: right, handedness: 'Left', score: 1 })
    if (left) hands.push({ landmarks: left, handedness: 'Right', score: 1 })
    frames.push({ t: (t * 1000) / (entry.fps || 30), hands, face: points(t, 0, 468), pose: points(t, 489, 33) })
  }
  return frames
}

/**
 * The clip as a movement window: the movement runs from the first to the last frame with a hand
 * (about what the segmenter cuts), and the rest of the clip is context around it.
 */
export function handWindow(frames: FrameSample[]): MovementWindow {
  const first = frames.findIndex((f) => f.hands.length > 0)
  let last = frames.length - 1
  while (last > 0 && frames[last].hands.length === 0) last--
  return { frames, start: Math.max(0, first), end: Math.max(first, last) }
}

/** The vocabulary word an ASL Citizen gloss (THANKYOU, EAT2, CALL_2, MAIL...) stands for, or null. */
export function wordForGloss(gloss: string): string | null {
  const g = gloss.replace(/_/g, '').toUpperCase()
  for (const candidate of [g, `${g}1`]) {
    const hit = SIGN_VOCABULARY.find((w) => w.citizen?.includes(candidate))
    if (hit) return hit.word
  }
  return null
}
