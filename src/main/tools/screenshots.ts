import { resolve } from 'node:path'

/** Screenshots kept for the card's thumbnail; older ones drop out first. */
const MAX_REMEMBERED = 50

/** Paths take_screenshot wrote this session: the only files the card may show a thumbnail of. */
const taken = new Set<string>()

/** Called by take_screenshot with the file it just wrote. */
export function rememberScreenshot(path: string): void {
  const file = resolve(path)
  taken.delete(file)
  taken.add(file)
  while (taken.size > MAX_REMEMBERED) taken.delete(taken.values().next().value as string)
}

/** Whether fastASL itself took this screenshot (the path is normalized, so `..` can't reach past it). */
export function tookScreenshot(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && taken.has(resolve(path))
}

/** Tests only. */
export function forgetScreenshots(): void {
  taken.clear()
}
