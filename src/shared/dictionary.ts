import bundled from './dictionary.json'

/**
 * The ASL sign dictionary: what each standard sign looks like, as data, so it is recognized with
 * no recordings (engine/recognition/lexicon.ts). A sign is two phases: hold a handshape at a
 * location, then move. Ported from the asl-dictionary-chat branch (commit 220f562); its
 * Supabase copy of these rows was not ported, so the bundled JSON is the only one.
 */

/** `curled` is anything not fully extended (bent or folded), e.g. the fingers of a flat-O. */
export type FingerRule = 'extended' | 'folded' | 'curled' | 'any'

export interface HandshapeDef {
  fingers: Record<'index' | 'middle' | 'ring' | 'pinky', FingerRule>
  thumb?: FingerRule
  /** Max index/middle angle in degrees ("fingers together"). */
  spreadMax?: number
  /**
   * The thumb tip's mean distance to the four fingertips, in hand lengths: small for a flat O
   * (tips together, about 0.2), large for an open 5 (0.8 and up).
   */
  pinchMin?: number
  pinchMax?: number
}

export interface Box {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export interface LocationDef {
  /**
   * face: `region` is relative to the face center, in face widths (x) and face heights (y, down
   * is positive). frame: `region` is in fractions of the camera frame (0 = top / left).
   */
  anchor: 'face' | 'frame'
  region: Box
  /** Location used when this one needs a face and none is visible. */
  fallback?: string
}

export type MovementDef =
  | {
      /** One hand travels away from where it started. */
      kind: 'outward'
      /** Distance travelled, in hand lengths (wrist to middle knuckle). */
      minHandLengths: number
      /** Share of that travel that must be sideways (0 allows any direction). */
      sidewaysShare: number
    }
  | {
      /** Two hands come together. */
      kind: 'together'
      /** The gap between the hands closes by at least this many hand lengths... */
      closeByHandLengths: number
      /** ...to no more than this gap. */
      endGapHandLengths: number
    }

export interface Phase {
  handshape: string
  location?: string
  /** The hand point that must be in `location`: the palm centre (default) or a fingertip, by landmark index (8 = index tip). */
  point?: number
  movement?: string
}

export interface SignDef {
  gloss: string
  hands: 1 | 2
  /**
   * [hold: {handshape, location}, move: {handshape, movement}]. A two-handed sign has no
   * location: both hands show `handshape` while the movement happens.
   */
  phases: Phase[]
}

export interface Dictionary {
  handshapes: Record<string, HandshapeDef>
  locations: Record<string, LocationDef>
  movements: Record<string, MovementDef>
  signs: SignDef[]
}

export const DEFAULT_DICTIONARY: Dictionary = bundled as Dictionary

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Checks a dictionary from the database or its cache; a bad one is rejected whole so the bundled one stays in use. */
export function validateDictionary(json: unknown): Dictionary | Error {
  if (!isObject(json)) return new Error('dictionary must be an object')
  const { handshapes, locations, movements, signs } = json
  if (!isObject(handshapes) || !isObject(locations) || !isObject(movements) || !Array.isArray(signs)) {
    return new Error('dictionary needs handshapes, locations, movements and signs')
  }
  for (const s of signs) {
    if (!isObject(s) || typeof s.gloss !== 'string' || !Array.isArray(s.phases) || s.phases.length < 2) {
      return new Error('each sign needs a gloss and two phases')
    }
    const [hold, move] = s.phases as Phase[]
    const placed = s.hands === 2 || locations[hold?.location ?? '']
    if (!handshapes[hold?.handshape] || !placed || !handshapes[move?.handshape] || !movements[move?.movement ?? '']) {
      return new Error(`sign ${s.gloss} names a handshape, location or movement that is not defined`)
    }
  }
  return json as unknown as Dictionary
}
