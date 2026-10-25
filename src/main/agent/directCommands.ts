import type { ToolCallRecord } from '@shared/types'

/**
 * Sign commands that need no model: CALL plus a contact nickname (FRIEND, MOM...) calls that
 * contact on FaceTime at once. The nicknames come from FASTASL_CONTACT_ALIASES in .env, e.g.
 * `friend=Yuvraaj SCU; mom=Jane Doe`: the sign word, then the full name as saved in Contacts.
 * Anything else still goes to the agent.
 */
export interface DirectCommand {
  intent: string
  calls: ToolCallRecord[]
}

/** FASTASL_CONTACT_ALIASES as sign word (lower case) -> contact name. */
export function contactAliases(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const entry of (env.FASTASL_CONTACT_ALIASES ?? '').split(/[;,]/)) {
    const at = entry.indexOf('=')
    if (at < 0) continue
    const word = entry.slice(0, at).trim().toLowerCase()
    const name = entry.slice(at + 1).trim()
    if (word && name) aliases.set(word, name)
  }
  return aliases
}

const CALL_WORDS = new Set(['call', 'facetime'])

/** CALL FRIEND (or FRIEND CALL, ASL order) with FRIEND a nickname: a FaceTime call to that contact. */
export function directCommand(sentence: string, aliases: ReadonlyMap<string, string>): DirectCommand | null {
  const words = sentence.toLowerCase().match(/[a-z0-9']+/g) ?? []
  if (words.length !== 2) return null
  const verb = words.find((w) => CALL_WORDS.has(w))
  const who = words.find((w) => w !== verb)
  const contact = verb && who ? aliases.get(who) : undefined
  if (!contact) return null
  return { intent: `Call ${contact}`, calls: [{ tool: 'facetime_call', args: { contact_name: contact }, ok: true }] }
}
