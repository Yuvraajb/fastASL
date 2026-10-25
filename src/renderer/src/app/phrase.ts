import type { Token } from './types'

/*
 * The phrase being signed, as words, and the sign commands read from it (CALL D W, MEETING
 * FRIEND): plain functions of the tokens, shared by the controller and the tests.
 */

/** Join recognized tokens into display text. Consecutive letters form one word. */
export function assembleSentence(tokens: Token[]): string {
  const text = phraseWords(tokens).join(' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

/** MEETING FRIEND's time choices: hold up 1-4 fingers. */
export const MEETING_TIMES = ['1 PM', '2 PM', '3 PM', '4 PM'] as const

export interface MeetingRequest {
  /** The contact's full name in Contacts. */
  name: string
  day: 'today' | 'tomorrow'
}

/**
 * MEETING plus a contact nickname (FRIEND), maybe TODAY or TOMORROW, in any order and nothing
 * else: set up a meeting with that contact. Anything more (TOMORROW MEETING WHAT TIME) is a
 * message, as before.
 */
export function meetingRequest(words: readonly string[], aliases: Readonly<Record<string, string>>): MeetingRequest | null {
  const lower = words.map((w) => w.toLowerCase())
  if (!lower.includes('meeting')) return null
  const rest = lower.filter((w) => w !== 'meeting' && w !== 'today' && w !== 'tomorrow')
  const name = rest.length === 1 ? aliases[rest[0]] : undefined
  if (!name || lower.length > 3) return null
  return { name, day: lower.includes('tomorrow') ? 'tomorrow' : 'today' }
}

/** Local ISO 8601 with no offset ("2026-10-25T14:00:00"): main reads it in the local time zone. */
export function localIso(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

/**
 * CALL plus one word (CALL FRIEND): a command even while the caption camera is open, so a call
 * can be started by sign during a captioned session. Main runs it with no model when the word is
 * a contact nickname (src/main/agent/directCommands.ts).
 */
export function isCallPhrase(words: readonly string[]): boolean {
  return words.length === 2 && words.some((w) => /^(call|facetime)$/i.test(w))
}

/** The phrase's words: each sign, and each run of spelled letters as one word. */
export function phraseWords(tokens: Token[]): string[] {
  const words: string[] = []
  let spelled = ''
  for (const t of tokens) {
    if (t.kind === 'letter') {
      spelled += t.text
      continue
    }
    if (spelled) words.push(spelled)
    spelled = ''
    words.push(t.text)
  }
  if (spelled) words.push(spelled)
  return words
}

/**
 * What Dictation types for a sign, given the kind of sign typed before it (null for the first).
 * Words are separated by a space and a run of letters is one word. The space goes before a
 * word, never after it, so punctuation typed by hand lands right after the last word.
 */
export function dictationChunk(previous: Token['kind'] | null, token: Token): string {
  const joined = previous === null || (previous === 'letter' && token.kind === 'letter')
  return joined ? token.text : ` ${token.text}`
}
