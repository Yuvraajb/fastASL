import type { FrontmostApp } from '@shared/types'

/** Collapses runs of whitespace and trims. */
export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Trimmed, non-empty, case-insensitively unique entries (minus `exclude`), capped at `max`. */
export function cleanList(items: string[], max: number, exclude: string[] = []): string[] {
  const seen = new Set(exclude.map((s) => squash(s).toLowerCase()))
  const out: string[] = []
  for (const item of items) {
    const value = squash(item)
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length === max) break
  }
  return out
}

/** The frontmost app as the snake_case object both prompts send. */
export function appContext(app: FrontmostApp | null): Record<string, string | null> | null {
  return app ? { name: app.name, bundle_id: app.bundleId ?? null, window_title: app.windowTitle ?? null } : null
}
