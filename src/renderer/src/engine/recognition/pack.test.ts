import type { SignTemplate } from '@shared/types'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FRAME_FEATURE_DIM, STATIC_FEATURE_DIM } from './features'
import { createTemplatePack, mergeTemplates, PACK_FORMAT, TEMPLATE_DIMS, validateTemplatePack } from '@shared/templatePack'

const word = (id: string, frames = 4): SignTemplate => ({
  id,
  label: 'HELLO',
  kind: 'word',
  frames: Array.from({ length: frames }, (_, i) => new Array<number>(FRAME_FEATURE_DIM).fill(i / 10)),
  createdAt: 1_700_000_000_000
})

const letter = (id: string): SignTemplate => ({
  id,
  label: 'A',
  kind: 'letter',
  frames: [new Array<number>(STATIC_FEATURE_DIM).fill(0.5)],
  createdAt: 1_700_000_000_000
})

const validPack = (): Record<string, unknown> => ({
  format: PACK_FORMAT,
  version: 1,
  exportedAt: '2026-10-24T09:00:00.000Z',
  templates: [word('w1'), letter('l1')]
})

/** Mutations that must make a pack invalid, with the message they must produce. */
const BAD_PACKS: [string, (p: Record<string, unknown>) => unknown, RegExp][] = [
  ['not an object', () => [1, 2], /expected a JSON object/],
  ['wrong format', (p) => ({ ...p, format: 'other' }), /Unknown format/i],
  ['future version', (p) => ({ ...p, version: 2 }), /version 2/],
  ['bad exportedAt', (p) => ({ ...p, exportedAt: 'yesterday' }), /exportedAt/],
  ['templates not an array', (p) => ({ ...p, templates: {} }), /templates must be an array/],
  ['missing id', (p) => ({ ...p, templates: [{ ...word('x'), id: '' }] }), /templates\[0\]: id/],
  ['empty label', (p) => ({ ...p, templates: [{ ...word('x'), label: '  ' }] }), /label/],
  ['unknown kind', (p) => ({ ...p, templates: [{ ...word('x'), kind: 'phrase' }] }), /kind/],
  ['bad createdAt', (p) => ({ ...p, templates: [{ ...word('x'), createdAt: 'now' }] }), /createdAt/],
  ['one-frame word', (p) => ({ ...p, templates: [word('x', 1)] }), /needs 2-512 frames/],
  ['letter with word-sized frames', (p) => ({ ...p, templates: [{ ...word('x'), kind: 'letter' }] }), /must have 63 numbers/],
  ['short word frame', (p) => ({ ...p, templates: [{ ...word('x'), frames: [[1, 2], [3, 4]] }] }), /must have 134 numbers/],
  [
    'non-numeric value',
    (p) => ({ ...p, templates: [{ ...letter('x'), frames: [[...letter('x').frames[0].slice(1), null]] }] }),
    /non-numeric/
  ],
  ['duplicate ids', (p) => ({ ...p, templates: [word('same'), letter('same')] }), /templates\[1\]: duplicate id/]
]

describe('validateTemplatePack', () => {
  it('checks the feature layout the recognizer uses', () => {
    expect(TEMPLATE_DIMS).toEqual({ word: FRAME_FEATURE_DIM, letter: STATIC_FEATURE_DIM })
  })

  it('accepts a valid pack and returns a clean copy', () => {
    const input = { ...validPack(), extra: true, templates: [{ ...word('w1'), extra: 'dropped' }] }
    const pack = validateTemplatePack(input)
    if (pack instanceof Error) throw pack
    expect(pack.templates[0]).toEqual(word('w1'))
    expect(pack).not.toHaveProperty('extra')
    expect(pack.templates[0].frames).not.toBe((input.templates[0] as SignTemplate).frames)
  })

  it('round-trips createTemplatePack through JSON', () => {
    const pack = createTemplatePack([word('a'), letter('b')], new Date('2026-01-02T03:04:05Z'))
    expect(pack.exportedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(validateTemplatePack(JSON.parse(JSON.stringify(pack)))).toEqual(pack)
  })

  it.each(BAD_PACKS)('rejects %s', (_name, mutate, message) => {
    const result = validateTemplatePack(mutate(validPack()))
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(message)
  })
})

describe('mergeTemplates', () => {
  it('keeps existing templates and adds only new ids', () => {
    const existing = [word('a'), letter('b')]
    const changed = { ...letter('b'), label: 'B' }
    const merged = mergeTemplates(existing, [changed, word('c'), word('c'), letter('d')])
    expect(merged.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged[1].label).toBe('A')
    expect(mergeTemplates(merged, merged)).toEqual(merged)
  })
})

// ---------------------------------------------------------------------------------------------
// scripts/templates.mjs, run against throwaway HOME directories (never the real store; FASTASL_DATA_DIR unset).

const SCRIPT = fileURLToPath(new URL('../../../../../scripts/templates.mjs', import.meta.url))
const homes: string[] = []

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fastasl-templates-'))
  homes.push(dir)
  return dir
}

const storeDir = (h: string): string => join(h, 'Library', 'Application Support', 'fastASL')
const storeFile = (h: string): string => join(storeDir(h), 'signs.json')

function cli(h: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: h, FASTASL_DATA_DIR: '' }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function writePack(h: string, pack: unknown): string {
  const file = join(h, 'pack.json')
  writeFileSync(file, JSON.stringify(pack))
  return file
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

describe('scripts/templates.mjs', () => {
  it('reports an empty store', () => {
    const h = home()
    const r = cli(h, 'stats')
    expect(r.code).toBe(0)
    expect(r.out).toContain(storeFile(h))
    expect(r.out).toContain('0 template(s)')
    expect(existsSync(storeFile(h))).toBe(false)
  })

  it('imports a pack, merges by id on re-import, and leaves no temp files', () => {
    const h = home()
    const file = writePack(h, validPack())
    expect(cli(h, 'import', file)).toMatchObject({ code: 0, out: expect.stringContaining('Imported 2 new template(s), skipped 0') })
    writePack(h, { ...validPack(), templates: [word('w1'), word('w2'), letter('l2')] })
    expect(cli(h, 'import', file).out).toContain('Imported 2 new template(s), skipped 1')
    const store = JSON.parse(readFileSync(storeFile(h), 'utf8'))
    expect(store.version).toBe(1)
    expect(store.templates.map((t: { id: string }) => t.id)).toEqual(['w1', 'l1', 'w2', 'l2'])
    expect(readdirSync(storeDir(h))).toEqual(['signs.json'])
    const stats = cli(h, 'stats').out
    expect(stats).toContain('4 template(s): 2 word, 2 letter, 2 label(s)')
    expect(stats).toMatch(/word +HELLO +2 rep\(s\), 4 frame\(s\) each/)
    expect(stats).toMatch(/letter +A +2 rep\(s\), 1 frame\(s\) each/)
  })

  it('exports a pack that the app accepts and another store can import', () => {
    const a = home()
    cli(a, 'import', writePack(a, validPack()))
    const out = join(a, 'export.json')
    expect(cli(a, 'export', out).code).toBe(0)
    const exported = JSON.parse(readFileSync(out, 'utf8'))
    expect(validateTemplatePack(exported)).not.toBeInstanceOf(Error)
    expect(exported.templates).toEqual(validPack().templates)

    const b = home()
    expect(cli(b, 'import', out).code).toBe(0)
    expect(JSON.parse(readFileSync(storeFile(b), 'utf8')).templates).toEqual(exported.templates)
  })

  it('rejects exactly the packs the app rejects, without touching the store', () => {
    const h = home()
    cli(h, 'import', writePack(h, validPack()))
    const before = readFileSync(storeFile(h), 'utf8')
    for (const [name, mutate, message] of BAD_PACKS) {
      const r = cli(h, 'import', writePack(h, mutate(validPack())))
      expect(r.code, name).toBe(1)
      expect(r.err, name).toMatch(/invalid pack/)
      expect(r.err, name).toMatch(new RegExp(message.source, 'i'))
    }
    expect(readFileSync(storeFile(h), 'utf8')).toBe(before)
  })

  it('uses FASTASL_DATA_DIR like the app', () => {
    const h = home()
    const dir = join(h, 'data')
    const env = { ...process.env, HOME: h, FASTASL_DATA_DIR: dir }
    const r = spawnSync(process.execPath, [SCRIPT, 'import', writePack(h, validPack())], { env, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(existsSync(join(dir, 'signs.json'))).toBe(true)
    expect(existsSync(storeFile(h))).toBe(false)
  })

  it('explains usage and missing files', () => {
    const h = home()
    expect(cli(h).code).toBe(1)
    expect(cli(h, 'frobnicate').err).toMatch(/usage/)
    expect(cli(h, 'import', join(h, 'nope.json')).err).toMatch(/not found/)
  })
})
