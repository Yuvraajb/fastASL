/** The agent asks for a missing detail with one line: `ASK: <question> | <option> | <option>`. */
export interface AgentQuestion {
  question: string
  options: string[]
}

const MAX_OPTIONS = 3

/** The question in a reply, or null when it is not one (or has fewer than two options). */
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
  const picks = options.filter(Boolean).slice(0, MAX_OPTIONS)
  return question && picks.length >= 2 ? { question, options: picks } : null
}
