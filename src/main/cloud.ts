import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { mergeTemplates } from '@shared/templatePack'
import type { CustomGesture, SignTemplate } from '@shared/types'
import * as store from './store'

/**
 * Optional Supabase sync. Without SUPABASE_URL and SUPABASE_ANON_KEY in .env nothing here runs and
 * signs.json / gestures.json stay the only copy. With them, this device signs in anonymously (a
 * stable per-install user), pulls the shared catalog plus its own templates into signs.json, and
 * pushes what it records. signs.json stays the offline cache the recognizer reads.
 */

interface Session {
  access_token: string
  refresh_token: string
  user: { id: string }
}

const SESSION_FILE = 'supabase-session.json'
const TIMEOUT_MS = 4000

const url = (): string => (process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
const anonKey = (): string => process.env.SUPABASE_ANON_KEY ?? ''

export const cloudEnabled = (): boolean => Boolean(url() && anonKey())

async function call(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const { token, ...rest } = init
  return fetch(`${url()}${path}`, {
    ...rest,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      apikey: anonKey(),
      authorization: `Bearer ${token ?? anonKey()}`,
      'content-type': 'application/json',
      ...(rest.headers as Record<string, string> | undefined)
    }
  })
}

let session: Session | null = null

function sessionPath(): string {
  return join(store.dataDir(), SESSION_FILE)
}

async function getSession(): Promise<Session> {
  if (!session && existsSync(sessionPath())) {
    try {
      session = JSON.parse(readFileSync(sessionPath(), 'utf8')) as Session
    } catch {
      session = null
    }
  }
  if (session) {
    const res = await call('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: session.refresh_token })
    })
    if (res.ok) session = (await res.json()) as Session
    else session = null
  }
  if (!session) {
    const res = await call('/auth/v1/signup', { method: 'POST', body: JSON.stringify({}) })
    if (!res.ok) throw new Error(`anonymous sign-in failed (${res.status}): enable anonymous sign-ins in Supabase auth`)
    session = (await res.json()) as Session
  }
  writeFileSync(sessionPath(), JSON.stringify(session))
  return session
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = await getSession()
  const res = await call(`/rest/v1/${path}`, { ...init, token: s.access_token })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text()}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : []) as T
}

interface TemplateRow {
  id: string
  label: string
  kind: 'word' | 'letter'
  frames: number[][]
  created_at: number
}

/** Shared catalog templates plus this user's own, merged into signs.json by id. Returns how many were new. */
export async function pullTemplates(): Promise<number> {
  const rows = await rest<TemplateRow[]>('recognizer_templates?select=id,label,kind,frames,created_at')
  const incoming: SignTemplate[] = rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    frames: r.frames,
    createdAt: Number(r.created_at)
  }))
  const current = store.getTemplates().templates
  const merged = mergeTemplates(current, incoming)
  if (merged.length > current.length) store.saveTemplates({ version: 1, templates: merged })
  return merged.length - current.length
}

/** Ensures a words row exists for each label (the catalog's, or one owned by this user), then upserts templates. */
export async function pushTemplates(templates: readonly SignTemplate[]): Promise<void> {
  if (templates.length === 0) return
  const s = await getSession()
  const known = await rest<{ id: string; label: string }[]>('words?select=id,label')
  const wordIds = new Map(known.map((w) => [w.label, w.id]))
  for (const t of templates) {
    if (wordIds.has(t.label)) continue
    const [created] = await rest<{ id: string }[]>('words', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ owner_id: s.user.id, label: t.label, kind: t.kind, category: 'custom' })
    })
    wordIds.set(t.label, created.id)
  }
  const existing = new Set((await rest<{ id: string }[]>('sign_templates?select=id')).map((r) => r.id))
  const fresh = templates.filter((t) => !existing.has(t.id))
  if (fresh.length === 0) return
  await rest('sign_templates', {
    method: 'POST',
    body: JSON.stringify(
      fresh.map((t) => ({
        id: t.id,
        word_id: wordIds.get(t.label),
        owner_id: s.user.id,
        frames: t.frames,
        source: 'recorded',
        created_at: new Date(t.createdAt || Date.now()).toISOString()
      }))
    )
  })
}

export async function pushGestures(gestures: readonly CustomGesture[]): Promise<void> {
  const s = await getSession()
  const custom = gestures.filter((g) => !g.builtin)
  if (custom.length === 0) return
  await rest('custom_gestures?on_conflict=id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(
      custom.map((g) => ({
        id: g.id,
        owner_id: s.user.id,
        name: g.name,
        task: g.task,
        shape: g.shape,
        compiled: g.compiled ?? null,
        created_at: new Date(g.createdAt || Date.now()).toISOString()
      }))
    )
  })
}

export async function pullGestures(): Promise<number> {
  const rows = await rest<{ id: string; name: string; task: string; shape: number[][]; compiled: CustomGesture['compiled'] | null; created_at: string }[]>(
    'custom_gestures?select=id,name,task,shape,compiled,created_at'
  )
  const have = new Set(store.getGestures().map((g) => g.id))
  const fresh: CustomGesture[] = rows
    .filter((r) => !have.has(r.id))
    .map((r) => ({ id: r.id, name: r.name, task: r.task, shape: r.shape, compiled: r.compiled ?? undefined, createdAt: Date.parse(r.created_at) }))
  if (fresh.length) store.saveGestures([...store.getGestures().filter((g) => !g.builtin), ...fresh])
  return fresh.length
}

let startupSync: Promise<void> | null = null

/** Once per launch: pull everything, then push anything recorded offline. Never throws. */
export function syncOnce(): Promise<void> {
  if (!cloudEnabled()) return Promise.resolve()
  startupSync ??= (async () => {
    try {
      const added = await pullTemplates()
      const gestures = await pullGestures()
      await pushTemplates(store.getTemplates().templates)
      await pushGestures(store.getGestures())
      console.log(`[cloud] synced: ${added} template(s), ${gestures} gesture(s) pulled`)
    } catch (e) {
      console.warn(`[cloud] sync skipped: ${(e as Error).message}`)
    }
  })()
  return startupSync
}

/** Fire-and-forget push after the app saves; failures only log, the local file already has the data. */
export function pushLater(task: () => Promise<void>): void {
  if (!cloudEnabled()) return
  void task().catch((e) => console.warn(`[cloud] push failed: ${(e as Error).message}`))
}
