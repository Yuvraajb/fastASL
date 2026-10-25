import { mkdir, readdir, realpath, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, sep } from 'node:path'
import { z } from 'zod'
import { exec } from '../mac/exec'
import { dateLabel, plural, truncate } from './format'
import { fail } from './outcome'
import { defineTool } from './types'

/** The only folders the agent may look in or change: where a person's own files live. */
export const FOLDERS = ['Desktop', 'Downloads', 'Documents'] as const
export type FolderName = (typeof FOLDERS)[number]

const FIND_LIMIT = 10
const LIST_LIMIT = 60

const folderPath = (name: FolderName): string => join(homedir(), name)

/** True when `path` is `root` or lies inside it (a plain prefix check on whole path segments). */
export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * The real path of an existing regular file inside Desktop, Downloads or Documents; throws a card-ready
 * error otherwise. Symlinks are resolved first, so a link cannot lead out of the allowed folders.
 */
export async function allowedFile(path: string): Promise<string> {
  if (!path.startsWith('/')) throw new Error(`"${truncate(path, 40)}" is not a full file path`)
  let real: string
  try {
    real = await realpath(path)
  } catch {
    throw new Error(`There is no file at ${truncate(path, 60)}`)
  }
  const roots = await Promise.all(FOLDERS.map((f) => realpath(folderPath(f)).catch(() => folderPath(f))))
  if (!roots.some((root) => isInside(root, real))) {
    throw new Error('Only files in Desktop, Downloads and Documents can be used')
  }
  if (!(await stat(real)).isFile()) throw new Error(`${basename(real)} is not a file`)
  return real
}

/** A plain file or folder name: no slashes, no dots-only, not hidden. */
export function plainName(name: string): string | null {
  const n = name.trim()
  if (!n || n.startsWith('.') || n.includes('/') || n.includes('\0') || n.length > 120) return null
  return n
}

const EXTENSIONS: Record<string, readonly string[]> = {
  pdf: ['.pdf'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp', '.tiff'],
  document: ['.doc', '.docx', '.pages', '.txt', '.rtf', '.md', '.key', '.ppt', '.pptx', '.xls', '.xlsx', '.numbers', '.csv']
}

/** "PDF", "Image", "Folder", "Document" or the upper-cased extension, for a short listing. */
export function kindOf(name: string, isDir: boolean): string {
  if (isDir) return 'Folder'
  const ext = extname(name).toLowerCase()
  for (const [kind, list] of Object.entries(EXTENSIONS)) {
    if (list.includes(ext)) return kind === 'pdf' ? 'PDF' : kind[0].toUpperCase() + kind.slice(1)
  }
  return ext ? ext.slice(1).toUpperCase() : 'File'
}

const sizeLabel = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`

export const filesFind = defineTool({
  name: 'files_find',
  description:
    'Find files by name in Desktop, Downloads and Documents (Spotlight). Returns up to 10 full paths, newest first. ' +
    'Use the returned full path as an attachment in mail_send. `kind` narrows to pdf, image or document files.',
  schema: {
    query: z.string().trim().min(1),
    kind: z.enum(['any', 'pdf', 'image', 'document']).default('any')
  },
  risk: 'read',
  stepLabel: () => 'Finding files',
  async run(args) {
    const found = new Set<string>()
    for (const folder of FOLDERS) {
      try {
        const out = await exec('mdfind', ['-onlyin', folderPath(folder), '-name', args.query], 15_000)
        for (const line of out.split('\n')) if (line.trim()) found.add(line.trim())
      } catch {
        // A folder Spotlight cannot search is skipped.
      }
    }
    const wanted = args.kind === 'any' ? null : EXTENSIONS[args.kind]
    const files: { path: string; mtime: Date }[] = []
    for (const path of found) {
      if (basename(path).startsWith('.')) continue
      if (wanted && !wanted.includes(extname(path).toLowerCase())) continue
      try {
        const s = await stat(path)
        if (s.isFile()) files.push({ path, mtime: s.mtime })
      } catch {
        // Gone since Spotlight indexed it.
      }
    }
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    const top = files.slice(0, FIND_LIMIT)
    if (!top.length) return { ok: true, text: `No files matching "${args.query}" in Desktop, Downloads or Documents.`, title: 'No files found' }
    const now = new Date()
    return {
      ok: true,
      text: top.map((f) => `${f.path} (${dateLabel(f.mtime, now)})`).join('\n'),
      title: `Found ${plural(top.length, 'file')}`,
      subtitle: truncate(basename(top[0].path), 60)
    }
  }
})

export const filesList = defineTool({
  name: 'files_list',
  description:
    'List what is directly inside Desktop, Downloads or Documents: name, kind, size and modified date. ' +
    'Use before files_move to see what there is to tidy.',
  schema: { folder: z.enum(FOLDERS) },
  risk: 'read',
  stepLabel: (args) => `Looking at ${args.folder}`,
  async run(args) {
    const root = folderPath(args.folder)
    const names = (await readdir(root)).filter((n) => !n.startsWith('.')).sort()
    const now = new Date()
    const rows: string[] = []
    for (const name of names.slice(0, LIST_LIMIT)) {
      try {
        const s = await stat(join(root, name))
        rows.push(`${name} | ${kindOf(name, s.isDirectory())} | ${s.isDirectory() ? '-' : sizeLabel(s.size)} | ${dateLabel(s.mtime, now)}`)
      } catch {
        // A broken link: skipped.
      }
    }
    const more = names.length > LIST_LIMIT ? `\n(${names.length - LIST_LIMIT} more not shown)` : ''
    return {
      ok: true,
      text: rows.length ? rows.join('\n') + more : `${args.folder} is empty.`,
      title: `${args.folder}: ${plural(names.length, 'item')}`
    }
  }
})

export const filesMove = defineTool({
  name: 'files_move',
  description:
    'Move files that are directly inside Desktop, Downloads or Documents into a folder of that same location ' +
    '(created if needed), e.g. to tidy the Desktop. `files` are plain names exactly as files_list shows them. ' +
    'Never overwrites or deletes: a file whose name is already taken in the destination is left where it is. The user confirms first.',
  schema: {
    folder: z.enum(FOLDERS),
    files: z.array(z.string()).min(1).max(100),
    destination: z.string().trim().min(1)
  },
  risk: 'write',
  stepLabel: (args) => `Moving ${plural(args.files.length, 'file')}`,
  confirmDetails: (args) => {
    const shown = args.files.slice(0, 3).map((f) => truncate(f, 40))
    const more = args.files.length > 3 ? [`and ${args.files.length - 3} more`] : []
    return {
      kind: 'generic',
      title: `Move ${plural(args.files.length, 'file')}`,
      lines: [`To: ${args.folder}/${args.destination}`, ...shown, ...more]
    }
  },
  async run(args) {
    const dest = plainName(args.destination)
    if (!dest) return fail('The destination must be a plain folder name')
    const root = folderPath(args.folder)
    const target = join(root, dest)
    await mkdir(target, { recursive: true })
    let moved = 0
    const skipped: string[] = []
    for (const raw of args.files) {
      const name = plainName(raw)
      const from = name ? join(root, name) : null
      if (!name || !from || name === dest) {
        skipped.push(raw)
        continue
      }
      try {
        await stat(from)
        await stat(join(target, name)).then(
          () => Promise.reject(new Error('taken')),
          () => undefined
        )
        await rename(from, join(target, name))
        moved++
      } catch {
        skipped.push(name ?? raw)
      }
    }
    if (!moved) return fail(`Nothing was moved${skipped.length ? `: ${truncate(skipped.join(', '), 80)} could not be moved` : ''}`)
    const left = skipped.length ? ` ${plural(skipped.length, 'file')} left where they were (${truncate(skipped.join(', '), 60)}).` : ''
    return {
      ok: true,
      text: `Moved ${plural(moved, 'file')} into ${args.folder}/${dest}.${left}`,
      title: `Moved ${plural(moved, 'file')}`,
      subtitle: `to ${args.folder}/${dest}`,
      view: { kind: 'openFile', path: target }
    }
  }
})
