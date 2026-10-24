import { z } from 'zod'
import { appleScriptIso } from '../mac/dates'
import { AS_SEPARATORS, appleScriptString as q, runAppleScript, splitRecords } from '../mac/osascript'
import { plural, truncate } from './format'
import { fail } from './outcome'
import { defineTool } from './types'

const SEARCH_LIMIT = 5
const SNIPPET_CHARS = 160
const MAX_BODY_CHARS = 4000

/**
 * Notes whose title or text contains `query`, skipping Recently Deleted. The
 * search runs once (`set` resolves it to note ids); looping over the live
 * `whose` reference would rescan every note for each property read.
 */
export function searchNotesScript(query: string): string {
  return `${AS_SEPARATORS}
set out to {}
tell application "Notes"
\tset hits to (every note whose name contains ${q(query)} or plaintext contains ${q(query)})
\trepeat with i from 1 to count of hits
\t\tif (count of out) >= ${SEARCH_LIMIT} then exit repeat
\t\tset n to item i of hits
\t\tset folderName to ""
\t\ttry
\t\t\tset folderName to name of container of n
\t\tend try
\t\tif folderName is not "Recently Deleted" then
\t\t\tset snippet to plaintext of n
\t\t\tif length of snippet > ${SNIPPET_CHARS} then set snippet to text 1 thru ${SNIPPET_CHARS} of snippet
\t\t\tset end of out to (name of n) & US & folderName & US & ${appleScriptIso('modification date of n')} & US & snippet
\t\tend if
\tend repeat
end tell
set AppleScript's text item delimiters to RS
return out as text`
}

/** Exact title first, then the first title containing it. Empty output = not found. */
export function readNoteScript(title: string): string {
  return `${AS_SEPARATORS}
tell application "Notes"
\tset found to every note whose name is ${q(title)}
\tif found is {} then set found to every note whose name contains ${q(title)}
\tif found is {} then return ""
\tset n to item 1 of found
\tif password protected of n then error "That note is locked." number 9003
\treturn (name of n) & US & (body of n)
end tell`
}

export interface NoteHit {
  title: string
  folder: string
  modified: string
  snippet: string
}

export function parseNoteHits(output: string): NoteHit[] {
  return splitRecords(output).map(([title = '', folder = '', modified = '', snippet = '']) => ({
    title,
    folder,
    modified,
    snippet: snippet.replace(/\s+/g, ' ').trim()
  }))
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntity(entity: string): string {
  const numeric = /^#(x[0-9a-f]+|\d+)$/i.exec(entity)
  if (numeric) {
    const code = /^x/i.test(numeric[1]) ? parseInt(numeric[1].slice(1), 16) : Number(numeric[1])
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  }
  return ENTITIES[entity.toLowerCase()] ?? `&${entity};`
}

/** Notes stores bodies as HTML; this keeps line structure and list bullets. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>(?=\s*<\/(div|p)>)/gi, '') // an empty line is <div><br></div>
    .replace(/(<\/(div|p|h[1-6]|li|tr|ul|ol|blockquote)>\s*)+/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => decodeEntity(entity))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const notesSearch = defineTool({
  name: 'notes_search',
  description: `Search the Notes app by title and text. Returns up to ${SEARCH_LIMIT} notes with a short snippet.`,
  schema: { query: z.string().trim().min(1) },
  risk: 'read',
  stepLabel: () => 'Searching Notes',
  async run(args) {
    const hits = parseNoteHits(await runAppleScript(searchNotesScript(args.query), { app: 'Notes', timeoutMs: 30_000 }))
    if (!hits.length) {
      return { ok: true, text: `No notes match "${args.query}".`, title: 'No matching notes', subtitle: args.query }
    }
    const lines = hits.map((h, i) => `${i + 1}. "${h.title}" (${h.folder}, edited ${h.modified}): ${h.snippet}`)
    return {
      ok: true,
      text: lines.join('\n'),
      title: `Found ${plural(hits.length, 'note')}`,
      subtitle: truncate(hits[0].title, 60)
    }
  }
})

export const notesRead = defineTool({
  name: 'notes_read',
  description:
    'Read the full text of a note by its title (exact title preferred; otherwise the first title containing it).',
  schema: { title: z.string().trim().min(1) },
  risk: 'read',
  stepLabel: (args) => truncate(`Reading “${args.title}”`, 40),
  async run(args) {
    const output = await runAppleScript(readNoteScript(args.title), { app: 'Notes', timeoutMs: 20_000 })
    const [fields] = splitRecords(output)
    if (!fields) return fail(`No note titled "${args.title}"`)
    const [title = args.title, body = ''] = fields
    const text = htmlToText(body)
    return {
      ok: true,
      text: `"${title}":\n${truncate(text, MAX_BODY_CHARS)}`,
      title: truncate(title, 60),
      subtitle: truncate(text.split('\n').find((line) => line.trim() && line.trim() !== title) ?? 'Empty note', 60),
      view: { kind: 'openApp', app: 'Notes' }
    }
  }
})
