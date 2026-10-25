/**
 * The agent asks for a missing detail with one line: `ASK: <question> | <option> | <option> ...`.
 * The card shows the options as numbered choices; a pick (fingers 1-4, a thumbs up for the first,
 * or a click) is sent back as the answer.
 */
export interface AgentQuestion {
  question: string
  options: string[]
}

export const MAX_ASK_OPTIONS = 4

/** The question in a reply, or null when it has none (or fewer than two options). */
export function parseAsk(text: string | undefined): AgentQuestion | null {
  const line = text
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => /^ASK:/i.test(l))
  if (!line) return null
  const [question, ...options] = line
    .replace(/^ASK:\s*/i, '')
    .split('|')
    .map((part) => part.trim())
  const picks = options.filter(Boolean).slice(0, MAX_ASK_OPTIONS)
  return question && picks.length >= 2 ? { question, options: picks } : null
}
