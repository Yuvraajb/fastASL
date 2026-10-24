/** Length every dynamic sign is resampled to before comparison. */
export const SEQUENCE_LENGTH = 32

export function euclidean(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

/** Resample a sequence to `length` frames by linear interpolation over the frame index. */
export function resample(seq: readonly (readonly number[])[], length = SEQUENCE_LENGTH): number[][] {
  if (seq.length === 0) return []
  const step = length > 1 ? (seq.length - 1) / (length - 1) : 0
  const out: number[][] = []
  for (let i = 0; i < length; i++) {
    const pos = Math.min(i * step, seq.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(lo + 1, seq.length - 1)
    const f = pos - lo
    const a = seq[lo]
    const b = seq[hi]
    out.push(a.map((v, d) => v + (b[d] - v) * f))
  }
  return out
}

export interface DtwOptions {
  /**
   * Sakoe-Chiba band: how many frames the path may stray from the diagonal (scaled to the
   * two lengths). Omit for unconstrained DTW; 0 compares frames in lock-step.
   */
  band?: number
}

/**
 * Dynamic time warping with Euclidean frame distance, normalized by the length of the
 * warping path (so the result is the mean frame distance along the best alignment).
 * Returns Infinity when either sequence is empty or the band admits no path.
 */
export function dtw(
  a: readonly (readonly number[])[],
  b: readonly (readonly number[])[],
  { band = Infinity }: DtwOptions = {}
): number {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return Infinity
  const slope = n > 1 ? (m - 1) / (n - 1) : 0
  let prevCost = new Float64Array(m).fill(Infinity)
  let prevLen = new Float64Array(m)
  let cost = new Float64Array(m)
  let len = new Float64Array(m)

  for (let i = 0; i < n; i++) {
    cost.fill(Infinity)
    const lo = Math.max(0, Math.floor(i * slope - band))
    const hi = Math.min(m - 1, Math.ceil(i * slope + band))
    for (let j = lo; j <= hi; j++) {
      const d = euclidean(a[i], b[j])
      if (i === 0 && j === 0) {
        cost[j] = d
        len[j] = 1
        continue
      }
      // Predecessors; the diagonal wins ties so equal-cost paths stay short.
      let best = Infinity
      let bestLen = 0
      if (i > 0 && j > 0 && prevCost[j - 1] < best) {
        best = prevCost[j - 1]
        bestLen = prevLen[j - 1]
      }
      if (i > 0 && prevCost[j] < best) {
        best = prevCost[j]
        bestLen = prevLen[j]
      }
      if (j > 0 && cost[j - 1] < best) {
        best = cost[j - 1]
        bestLen = len[j - 1]
      }
      cost[j] = best + d
      len[j] = bestLen + 1
    }
    ;[prevCost, cost] = [cost, prevCost]
    ;[prevLen, len] = [len, prevLen]
  }
  const total = prevCost[m - 1]
  return Number.isFinite(total) ? total / prevLen[m - 1] : Infinity
}
