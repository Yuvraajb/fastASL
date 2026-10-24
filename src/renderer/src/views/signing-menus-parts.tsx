import type { LucideIcon } from 'lucide-react'

/** First rule whose pattern matches the label wins. */
export type IconRules = readonly (readonly [RegExp, LucideIcon])[]

export function iconFor(label: string, rules: IconRules, fallback: LucideIcon): LucideIcon {
  return rules.find(([pattern]) => pattern.test(label))?.[1] ?? fallback
}
