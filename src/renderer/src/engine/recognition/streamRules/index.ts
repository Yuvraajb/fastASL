import { FACE_RULES } from './faceSigns'
import { TWO_HAND_RULES } from './twoHandSigns'
import type { StreamRule } from './types'

/**
 * Streaming word rules, run every frame by StreamingSignMatcher (../streaming.ts) after the
 * dictionary signs (HELLO, MEETING in shared/dictionary.json). The first rule to fire wins; list
 * the most specific rules first. Face-anchored rules (faceSigns.ts): TOMORROW so far; two-handed (twoHandSigns.ts, from the agent's .ready snapshot): TIME, WHAT.
 */
/** STOP is left out for now: 60% recall and the most false fires of the two-handed rules (2–3%). */
const LEFT_OUT = new Set(['stop'])

export const STREAM_RULES: StreamRule[] = [...FACE_RULES, ...TWO_HAND_RULES].filter((r) => !LEFT_OUT.has(r.word))
