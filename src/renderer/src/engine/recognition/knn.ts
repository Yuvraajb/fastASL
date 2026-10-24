import { euclidean } from './dtw'

export interface LabeledVector {
  label: string
  vector: readonly number[]
}

export interface Neighbor {
  label: string
  distance: number
}

export interface KnnResult {
  /** Winner of the distance-weighted vote among the k nearest samples. */
  label: string
  /** Distance to the nearest sample of the winning label. */
  distance: number
  /** Nearest sample of any other label (null when only one label exists). */
  second: Neighbor | null
  /** Distinct labels: the winner first, then the rest by nearest distance. */
  ranked: Neighbor[]
}

/** k-nearest neighbors with 1/distance-weighted voting. Null when there are no samples. */
export function knn(query: readonly number[], samples: readonly LabeledVector[], k = 3): KnnResult | null {
  if (samples.length === 0) return null
  const scored = samples
    .map((s) => ({ label: s.label, distance: euclidean(query, s.vector) }))
    .sort((a, b) => a.distance - b.distance)

  const votes = new Map<string, number>()
  for (const { label, distance } of scored.slice(0, k)) {
    votes.set(label, (votes.get(label) ?? 0) + 1 / (distance + 1e-9))
  }
  // Votes are inserted nearest-first, so a strict ">" lets ties go to the nearer label.
  let label = scored[0].label
  for (const [candidate, weight] of votes) if (weight > votes.get(label)!) label = candidate

  const nearest = new Map<string, number>()
  for (const s of scored) if (!nearest.has(s.label)) nearest.set(s.label, s.distance)
  const ranked: Neighbor[] = [{ label, distance: nearest.get(label)! }]
  for (const [other, distance] of nearest) if (other !== label) ranked.push({ label: other, distance })

  return { label, distance: ranked[0].distance, second: ranked[1] ?? null, ranked }
}
