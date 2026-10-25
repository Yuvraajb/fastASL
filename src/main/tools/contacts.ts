import { z } from 'zod'
import { AS_SEPARATORS, SEP, appleScriptString as q, runAppleScript, splitRecords } from '../mac/osascript'
import { plural, truncate } from './format'
import { defineTool } from './types'

export interface ContactHandle {
  label: string
  value: string
}

export interface Contact {
  name: string
  phones: ContactHandle[]
  emails: ContactHandle[]
}

const LABEL_SEP = '\u001c'
const CHANGED_ERROR = 'error "Contacts changed while it was being read. Try again." number 9004'

/** AppleScript handler zipping a person's label and value lists into "label FS value" items joined by GS. */
export const JOIN_HANDLES_HANDLER = `on joinHandles(labels, vals)
\tif (count of labels) is not (count of vals) then ${CHANGED_ERROR}
\tset out to {}
\trepeat with i from 1 to count of vals
\t\tset end of out to ((item i of labels) as text) & (character id 28) & ((item i of vals) as text)
\tend repeat
\tset AppleScript's text item delimiters to character id 29
\treturn out as text
end joinHandles`

/**
 * Every person whose name contains `needle`, with phones and emails. The search runs exactly once
 * (`set found to (every person whose …)` resolves it to person ids) and only the matches are read.
 * A bulk read of a live `whose` reference re-runs the search for every property: with ~3,900
 * contacts that took 24-32 s for "Mom" and timed out; resolved once it takes ~4 s.
 */
export function contactSearchScript(needle: string): string {
  return `${JOIN_HANDLES_HANDLER}
${AS_SEPARATORS}
set out to {}
tell application "Contacts"
\tset found to (every person whose name contains ${q(needle)})
\trepeat with i from 1 to count of found
\t\tset p to item i of found
\t\ttry -- a card deleted meanwhile is skipped
\t\t\tset end of out to ((name of p) as text) & US & my joinHandles(label of every phone of p, value of every phone of p) & US & my joinHandles(label of every email of p, value of every email of p)
\t\tend try
\tend repeat
end tell
set AppleScript's text item delimiters to RS
return out as text`
}

/** Contacts stores built-in labels as constants ("_$!<Mobile>!$_"); custom labels come through as typed. */
export function cleanLabel(label: string): string {
  if (label === 'missing value') return ''
  const builtIn = /^_\$!<(.*)>!\$_$/.exec(label)
  return builtIn ? builtIn[1].toLowerCase() : label
}

function parseHandles(text: string): ContactHandle[] {
  if (!text) return []
  return text.split(SEP.list).flatMap((entry) => {
    const [label = '', value = ''] = entry.split(LABEL_SEP)
    return value ? [{ label: cleanLabel(label), value }] : []
  })
}

export function parseContacts(output: string): Contact[] {
  return splitRecords(output).flatMap(([name = '', phones = '', emails = '']) =>
    name ? [{ name, phones: parseHandles(phones), emails: parseHandles(emails) }] : []
  )
}

/** Case-, accent-, apostrophe- and spacing-insensitive form of a name (Contacts often stores O’Neil). */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const WORD_BREAK = /[^\p{L}\p{N}]+/u
const words = (text: string): string[] => fold(text).split(WORD_BREAK).filter(Boolean)

/** True when every word of `query` starts a word of `name`: "Sar Ch" finds "Sarah Chen", "Ann" never finds "Joanne". */
export function matchesWords(name: string, query: string): boolean {
  const nameWords = words(name)
  const queryWords = words(query)
  return queryWords.length > 0 && queryWords.every((w) => nameWords.some((n) => n.startsWith(w)))
}

/** The longest word of the query, which Contacts pre-filters on before `matchesWords` / exact matching. */
export function searchNeedle(query: string): string {
  return query.split(WORD_BREAK).reduce((longest, w) => (w.length > longest.length ? w : longest), '')
}

const phoneKey = (value: string): string => {
  const digits = value.replace(/\D/g, '')
  return digits && `tel:${digits}`
}
const emailKey = (value: string): string => `mail:${value.trim().toLowerCase()}`
const handleKeys = (c: Contact): string[] =>
  [...c.phones.map((p) => phoneKey(p.value)), ...c.emails.map((e) => emailKey(e.value))].filter(Boolean)

function merge(cards: Contact[]): Contact {
  const unique = (handles: ContactHandle[], key: (v: string) => string): ContactHandle[] =>
    handles.filter((h, i) => handles.findIndex((o) => key(o.value) === key(h.value)) === i)
  return {
    name: cards[0].name,
    phones: unique(cards.flatMap((c) => c.phones), phoneKey),
    emails: unique(cards.flatMap((c) => c.emails), emailKey)
  }
}

/**
 * Collapses duplicate cards of one person (e.g. iCloud and Gmail copies):
 * cards with the same name that share a phone number or email are merged.
 * Same-named cards with nothing in common stay separate people.
 */
export function groupPeople(cards: Contact[]): Contact[] {
  const groups: Contact[][] = []
  for (const card of cards) {
    const keys = new Set(handleKeys(card))
    const linked = groups.filter(
      (g) => fold(g[0].name) === fold(card.name) && g.some((c) => handleKeys(c).some((k) => keys.has(k)))
    )
    if (!linked.length) {
      groups.push([card])
      continue
    }
    const [first, ...rest] = linked
    first.push(card, ...rest.flat())
    for (const g of rest) groups.splice(groups.indexOf(g), 1)
  }
  return groups.map(merge)
}

/**
 * Best matches first: the exact name, then names that start with the query, then the rest (each
 * group in Contacts order). "Dad" lists "Dad" before "Srikar Dad"; the list is cut at MAX_LISTED,
 * so without this an exact match could be hidden behind "…and 8 more".
 */
export function rankContacts<T extends { name: string }>(people: T[], query: string): T[] {
  const q = fold(query)
  const rank = (name: string): number => (fold(name) === q ? 0 : fold(name).startsWith(q) ? 1 : 2)
  return people
    .map((person, index) => ({ person, index, rank: rank(person.name) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.person)
}

const listNames = (names: string[]): string => names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')

/**
 * The one person `query` names. Only an exact name match counts (ignoring
 * case and accents), so whoever gets the message has exactly the name the
 * user approved on the Confirm card; partial matches are only suggested.
 */
export function pickContact(cards: Contact[], query: string): Contact | string {
  const name = query.trim()
  const exact = cards.filter((c) => fold(c.name) === fold(name))
  if (!exact.length) {
    const similar = [...new Set(rankContacts(cards.filter((c) => matchesWords(c.name, name)), name).map((c) => c.name))]
    return similar.length
      ? `No contact is named exactly “${name}”. Did you mean ${listNames(similar)}? Use the full name.`
      : `No contact named “${name}” in Contacts`
  }
  const people = groupPeople(exact.filter((c) => c.phones.length || c.emails.length))
  if (people.length > 1) {
    return `${people.length} different contacts are named “${exact[0].name}”. Use the phone number or email instead.`
  }
  return people[0] ?? `${exact[0].name} has no phone number or email in Contacts`
}

const normalizePhone = (value: string): string => value.replace(/[^\d+]/g, '')

/** Best iMessage handle: a mobile number, then any number, then an email. */
export function messageHandle(contact: Contact): string | null {
  const mobile = contact.phones.find((p) => /mobile|iphone|cell/i.test(p.label))
  const phone = mobile ?? contact.phones[0]
  if (phone && normalizePhone(phone.value)) return normalizePhone(phone.value)
  return contact.emails[0]?.value ?? null
}

/** Cards whose name contains the query's longest word; callers narrow them down. */
export async function searchContacts(query: string): Promise<Contact[]> {
  const needle = searchNeedle(query)
  if (!needle) return []
  return parseContacts(await runAppleScript(contactSearchScript(needle), { app: 'Contacts', launch: true, timeoutMs: 20_000 }))
}

/** The person named exactly `query`. Rejects with a card-ready message. */
export async function findContact(query: string): Promise<Contact> {
  const picked = pickContact(await searchContacts(query), query)
  if (typeof picked === 'string') throw new Error(picked)
  return picked
}

const MAX_LISTED = 10
const handleText = (h: ContactHandle): string => (h.label ? `${h.label} ${h.value}` : h.value)

export const contactsFind = defineTool({
  name: 'contacts_find',
  description:
    'Look people up in Contacts by name; each word must start a word of the name ("Sar Ch" finds "Sarah Chen"). ' +
    'Returns exact names (best match first) with phone numbers and emails. message_send, mail_send and facetime_call ' +
    'need the exact full name, so call this first. A relation like "Mom" means the user\'s own: only a card named ' +
    'exactly "Mom" is theirs; "Anisha Mom" or "Rishi\'s Mom" is someone else\'s.',
  schema: { query: z.string().trim().min(1) },
  risk: 'read',
  stepLabel: () => 'Searching Contacts',
  async run(args) {
    const matches = (await searchContacts(args.query)).filter((c) => matchesWords(c.name, args.query))
    const people = rankContacts(groupPeople(matches), args.query)
    if (!people.length) {
      return { ok: true, text: `No contacts match "${args.query}".`, title: 'No matching contacts', subtitle: args.query }
    }
    const lines = people.slice(0, MAX_LISTED).map((p, i) => {
      const handles = [...p.phones, ...p.emails].map(handleText).join(', ')
      return `${i + 1}. ${p.name}: ${handles || 'no phone or email'}`
    })
    if (people.length > MAX_LISTED) lines.push(`…and ${people.length - MAX_LISTED} more`)
    return {
      ok: true,
      text: lines.join('\n'),
      title: `Found ${plural(people.length, 'contact')}`,
      subtitle: truncate(people[0].name, 60)
    }
  }
})
