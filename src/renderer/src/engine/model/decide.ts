/**
 * Turning model logits into a recognition decision. Pure, so it is tested without a model.
 *
 * Each model's softmax runs over the ENABLED words it knows only (vocabulary.ts), not over all
 * its classes: a sign outside that list then has to look like one of them to pass, and the
 * thresholds below were measured that way (DECISIONS.md, Pretrained sign model).
 */

/** A word, the probability the model gives it among the enabled words, and its rank among all the model's signs. */
export interface WordScore {
  word: string
  p: number
  /** 0 when it is the model's top sign of all it knows (250 or 2731), 1 when second, ... */
  rank: number
}

/** Softmax-over-the-enabled-words probability at or above this: the word is accepted. */
export const ACCEPT_P = 0.7
/**
 * ...and the model must rank it among its top N of ALL the signs it knows (an open-set check).
 * A sign outside the enabled list still gets a high share of a softmax over a few dozen words,
 * but the model's own top sign is then usually the real one. On ASL Citizen's held-out signers,
 * requiring the Kaggle model's top-1 of 250 cut signs outside the list accepted as an enabled
 * word from 12% to under 1%, for 3 points of recall (89% to 86%); ASL Citizen's top 3 of 2731
 * cut its share from 26% to 2%.
 */
export const ISLR_MAX_RANK = 1
export const CITIZEN_MAX_RANK = 3
/** Below ACCEPT_P, two words both at least this likely and within CLOSE_MARGIN: "Did you mean". */
export const CLOSE_P = 0.35
export const CLOSE_MARGIN = 0.25

/**
 * Softmax over the classes in `groups` only; each group (one word, possibly several class
 * variants such as MAIL1 and MAIL2) gets the sum of its classes' probabilities, and the best rank
 * of its classes among ALL the logits. Sorted, best first.
 */
export function wordProbabilities(logits: ArrayLike<number>, groups: readonly { word: string; classes: readonly number[] }[]): WordScore[] {
  let max = -Infinity
  for (const g of groups) for (const c of g.classes) max = Math.max(max, logits[c])
  if (!Number.isFinite(max)) return []
  let total = 0
  const sums = groups.map((g) => {
    let s = 0
    for (const c of g.classes) s += Math.exp(logits[c] - max)
    total += s
    return s
  })
  const rankOf = (c: number): number => {
    let above = 0
    for (let i = 0; i < logits.length; i++) if (logits[i] > logits[c]) above++
    return above
  }
  return groups
    .map((g, i) => ({ word: g.word, p: sums[i] / total, rank: Math.min(...g.classes.map(rankOf)) }))
    .sort((a, b) => b.p - a.p)
}

export type ModelDecision =
  | { status: 'accepted'; word: string; p: number }
  | { status: 'ambiguous'; options: string[] }
  | { status: 'rejected' }

/**
 * One model's ranking: accepted at ACCEPT_P when the model also ranks the word within `maxRank`
 * of all its signs, a close call between two likely words, or rejected.
 */
export function decide(ranked: readonly WordScore[], maxRank = Infinity, accept = ACCEPT_P): ModelDecision {
  const [best, second] = ranked
  if (!best) return { status: 'rejected' }
  if (best.p >= accept && best.rank < maxRank) return { status: 'accepted', word: best.word, p: best.p }
  if (second && best.p >= CLOSE_P && second.p >= CLOSE_P && best.p - second.p <= CLOSE_MARGIN) {
    return { status: 'ambiguous', options: [best.word, second.word] }
  }
  return { status: 'rejected' }
}

/**
 * The better of the two hand-slot assignments (as tracked, and swapped): the one whose best
 * word is more likely. Swapped slots wreck the model's answer rather than shade it, so the
 * right assignment is the confident one.
 */
export function moreConfident<T extends { ranked: readonly WordScore[] }>(a: T, b: T | null): T {
  if (!b) return a
  return (b.ranked[0]?.p ?? 0) > (a.ranked[0]?.p ?? 0) ? b : a
}

/**
 * Both pretrained models together. The Kaggle model (MIT, always installed) decides the words it
 * knows. ASL Citizen (when installed) adds the words only it knows: its softmax runs over every
 * enabled word it knows (shared ones included, so a shared sign isn't forced onto a
 * Citizen-only word).
 * - Kaggle accepted: that word.
 * - Else Citizen's top word at ACCEPT_P, within its top CITIZEN_MAX_RANK of all 2731 signs, and
 *   either one the Kaggle model lacks, or the very word the Kaggle model ranked first without
 *   being sure (the two agree; they never overrule each other on a word both know).
 * - Else a Kaggle close call: "Did you mean" between its two words.
 * - Else rejected (the user's taught signs, then an LLM guess, may still name it).
 */
export function combine(
  islr: readonly WordScore[],
  citizen: readonly WordScore[] | null,
  islrWords: ReadonlySet<string>
): ModelDecision & { source?: 'islr' | 'citizen' } {
  const kaggle = decide(islr, ISLR_MAX_RANK)
  if (kaggle.status === 'accepted') return { ...kaggle, source: 'islr' }
  const top = citizen?.[0]
  const allowed = top !== undefined && (!islrWords.has(top.word) || top.word === islr[0]?.word)
  if (top && allowed && top.p >= ACCEPT_P && top.rank < CITIZEN_MAX_RANK) {
    return { status: 'accepted', word: top.word, p: top.p, source: 'citizen' }
  }
  if (kaggle.status === 'ambiguous') return { ...kaggle, source: 'islr' }
  return { status: 'rejected' }
}

/** "hello 0.93 · bye 0.04 · yes 0.01" for the dev log. */
export function describeTop(ranked: readonly WordScore[], n = 3): string {
  return ranked
    .slice(0, n)
    .map((s) => `${s.word} ${s.p.toFixed(2)}`)
    .join(' · ')
}

/** The user's taught signs (DTW over their templates) for the same movement. */
export type TaughtDecision =
  | { status: 'accepted'; label: string; distance: number; radius: number }
  | { status: 'ambiguous'; options: string[] }
  | { status: 'rejected' }

/**
 * How sure a taught-sign match is, on the model's 0..1 scale: 1 at distance 0, 0.5 at the edge of
 * the word's accept radius. A match well inside its radius can outrank a model word.
 */
export function taughtConfidence(distance: number, radius: number): number {
  return radius > 0 ? Math.max(0, 1 - (0.5 * distance) / radius) : 0
}

export type FinalDecision =
  | { status: 'accepted'; word: string; source: 'model' | 'taught' }
  | { status: 'ambiguous'; options: string[]; source: 'model' | 'taught' }
  | { status: 'rejected' }

/**
 * The pretrained model first, the user's taught signs second.
 * - Both accept: the same word, or else the more confident (model p against taughtConfidence).
 * - One accepts: that one (a sure taught sign beats a model close call, and the reverse).
 * - Both unsure: one "Did you mean" with the model's options first.
 * - The model rejects: the taught outcome as before (a rejection then may go to the LLM).
 */
export function withTaught(model: ModelDecision, taught: TaughtDecision): FinalDecision {
  if (model.status === 'accepted') {
    if (taught.status === 'accepted' && taught.label.toLowerCase() !== model.word) {
      if (taughtConfidence(taught.distance, taught.radius) > model.p) return { status: 'accepted', word: taught.label, source: 'taught' }
    }
    return { status: 'accepted', word: model.word, source: 'model' }
  }
  if (taught.status === 'accepted') return { status: 'accepted', word: taught.label, source: 'taught' }
  if (model.status === 'ambiguous') {
    const extra = taught.status === 'ambiguous' ? taught.options.map((o) => o.toLowerCase()) : []
    return { status: 'ambiguous', options: [...new Set([...model.options, ...extra])].slice(0, 3), source: 'model' }
  }
  if (taught.status === 'ambiguous') return { status: 'ambiguous', options: taught.options, source: 'taught' }
  return { status: 'rejected' }
}

/**
 * When the movement made a swipe, or ends with the hand holding a control gesture's shape (a fist,
 * thumbs up, open palm or finger count about to fire), a model word must be at least this sure to
 * take the movement from the gesture; a close call never does. The user's own taught words keep
 * winning as before. On held-out signers 9 in 10 correct model words were this sure.
 */
export const GESTURE_OVERRIDE_P = 0.9

export function yieldToGesture(model: ModelDecision): ModelDecision {
  if (model.status === 'accepted' && model.p >= GESTURE_OVERRIDE_P) return model
  return { status: 'rejected' }
}
