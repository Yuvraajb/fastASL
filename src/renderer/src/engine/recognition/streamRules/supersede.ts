/**
 * Streaming signs whose movement passes through another's. FRIEND's first hook (an index meeting
 * the other hand) reads as TIME's tap, and FRIEND fires only on its second hook, so live a phrase
 * of FRIENDs came out "time friend time friend time". The longer sign wins:
 *  - `word` firing within `beforeMs` of `over` takes its place (the TIME was FRIEND's first hook);
 *  - `over` firing within `afterMs` of `word` is dropped (the hands still hooking after FRIEND).
 */
export interface Supersede {
  word: string
  over: string
  beforeMs: number
  afterMs: number
}

export const SUPERSEDES: readonly Supersede[] = [{ word: 'friend', over: 'time', beforeMs: 1500, afterMs: 2500 }]

export type StreamVerdict = 'keep' | 'replace' | 'drop'

/** What to do with a streamed `word` at frame time `t`, given the word streamed before it. */
export function supersede(
  prev: { word: string; t: number } | null,
  word: string,
  t: number,
  rules: readonly Supersede[] = SUPERSEDES
): StreamVerdict {
  if (!prev) return 'keep'
  for (const r of rules) {
    if (word === r.word && prev.word === r.over && t - prev.t <= r.beforeMs) return 'replace'
    if (word === r.over && prev.word === r.word && t - prev.t <= r.afterMs) return 'drop'
  }
  return 'keep'
}
