import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { exec } from '../mac/exec'
import { allowedFile, filesFind, filesList, filesMove, isInside, kindOf, plainName } from './files'

vi.mock('../mac/exec', () => ({ exec: vi.fn() }))
const execMock = vi.mocked(exec)

let home: string
let outside: string
const realHome = process.env.HOME

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fastasl-home-'))
  outside = mkdtempSync(join(tmpdir(), 'fastasl-outside-'))
  process.env.HOME = home
})
afterAll(() => {
  process.env.HOME = realHome
})
beforeEach(() => {
  execMock.mockReset()
  for (const f of ['Desktop', 'Downloads', 'Documents']) {
    rmSync(join(home, f), { recursive: true, force: true })
    mkdirSync(join(home, f), { recursive: true })
  }
})

describe('path rules', () => {
  it('isInside compares whole path segments', () => {
    expect(isInside('/a/Desktop', '/a/Desktop/x.pdf')).toBe(true)
    expect(isInside('/a/Desktop', '/a/Desktop')).toBe(true)
    expect(isInside('/a/Desktop', '/a/DesktopEvil/x.pdf')).toBe(false)
  })

  it('plainName refuses paths, hidden and empty names', () => {
    expect(plainName('Shot 1.png')).toBe('Shot 1.png')
    for (const bad of ['', ' ', '../x', 'a/b', '.hidden', '..']) expect(plainName(bad), bad).toBeNull()
  })

  it('kindOf names common kinds', () => {
    expect(kindOf('a.PDF', false)).toBe('PDF')
    expect(kindOf('a.png', false)).toBe('Image')
    expect(kindOf('a.zip', false)).toBe('ZIP')
    expect(kindOf('Stuff', true)).toBe('Folder')
  })

  it('allowedFile accepts a file in Documents and refuses anything else', async () => {
    writeFileSync(join(home, 'Documents', 'cv.pdf'), 'x')
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(join(outside, 'secret.txt'), join(home, 'Documents', 'link.txt'))
    expect(await allowedFile(join(home, 'Documents', 'cv.pdf'))).toMatch(/cv\.pdf$/)
    await expect(allowedFile(join(outside, 'secret.txt'))).rejects.toThrow('Only files in Desktop')
    await expect(allowedFile(join(home, 'Documents', 'link.txt'))).rejects.toThrow('Only files in Desktop')
    await expect(allowedFile(join(home, 'Documents', 'nope.pdf'))).rejects.toThrow('There is no file')
    await expect(allowedFile('cv.pdf')).rejects.toThrow('not a full file path')
    await expect(allowedFile(join(home, 'Documents'))).rejects.toThrow('not a file')
  })
})

describe('files_find', () => {
  it('searches the three folders and returns files newest first, filtered by kind', async () => {
    writeFileSync(join(home, 'Documents', 'resume.pdf'), 'x')
    writeFileSync(join(home, 'Desktop', 'resume.png'), 'x')
    execMock.mockImplementation(async (_cmd, args) =>
      args.includes(join(home, 'Documents')) ? join(home, 'Documents', 'resume.pdf') : args.includes(join(home, 'Desktop')) ? join(home, 'Desktop', 'resume.png') : ''
    )
    const all = await filesFind.run({ query: 'resume', kind: 'any' })
    expect(all.ok).toBe(true)
    expect(all.text.split('\n')).toHaveLength(2)
    const pdfs = await filesFind.run({ query: 'resume', kind: 'pdf' })
    expect(pdfs.text).toContain('resume.pdf')
    expect(pdfs.text).not.toContain('resume.png')
    expect(pdfs.title).toBe('Found 1 file')
  })

  it('says so when nothing matches', async () => {
    execMock.mockResolvedValue('')
    expect(await filesFind.run({ query: 'zzz', kind: 'any' })).toMatchObject({ ok: true, title: 'No files found' })
  })
})

describe('files_list', () => {
  it('lists visible items with kind and size', async () => {
    writeFileSync(join(home, 'Desktop', 'a.png'), 'abc')
    writeFileSync(join(home, 'Desktop', '.DS_Store'), 'x')
    mkdirSync(join(home, 'Desktop', 'Stuff'))
    const out = await filesList.run({ folder: 'Desktop' })
    expect(out.text).toContain('a.png | Image | 3 B')
    expect(out.text).toContain('Stuff | Folder | -')
    expect(out.text).not.toContain('.DS_Store')
    expect(out.title).toBe('Desktop: 2 items')
  })
})

describe('files_move', () => {
  it('is a write with a confirm card naming the destination', () => {
    expect(filesMove.risk).toBe('write')
    expect(filesMove.confirmDetails?.({ folder: 'Desktop', files: ['a', 'b', 'c', 'd'], destination: 'Shots' })).toEqual({
      kind: 'generic',
      title: 'Move 4 files',
      lines: ['To: Desktop/Shots', 'a', 'b', 'c', 'and 1 more']
    })
  })

  it('moves files into a new folder and opens it', async () => {
    writeFileSync(join(home, 'Desktop', 'a.png'), 'x')
    writeFileSync(join(home, 'Desktop', 'b.png'), 'x')
    const out = await filesMove.run({ folder: 'Desktop', files: ['a.png', 'b.png'], destination: 'Screenshots' })
    expect(out).toMatchObject({ ok: true, title: 'Moved 2 files', view: { kind: 'openFile', path: join(home, 'Desktop', 'Screenshots') } })
    expect(readdirSync(join(home, 'Desktop', 'Screenshots')).sort()).toEqual(['a.png', 'b.png'])
    expect(readdirSync(join(home, 'Desktop'))).toEqual(['Screenshots'])
  })

  it('never overwrites and leaves refused names where they are', async () => {
    mkdirSync(join(home, 'Desktop', 'Shots'))
    writeFileSync(join(home, 'Desktop', 'Shots', 'a.png'), 'old')
    writeFileSync(join(home, 'Desktop', 'a.png'), 'new')
    writeFileSync(join(home, 'Desktop', 'b.png'), 'x')
    const out = await filesMove.run({ folder: 'Desktop', files: ['a.png', 'b.png', '../evil', 'missing.png'], destination: 'Shots' })
    expect(out.ok).toBe(true)
    expect(out.text).toContain('Moved 1 file into Desktop/Shots.')
    expect(out.text).toContain('3 files left where they were')
    expect(readdirSync(join(home, 'Desktop')).sort()).toEqual(['Shots', 'a.png'])
  })

  it('refuses a destination that is not a plain folder name, and fails when nothing moves', async () => {
    expect((await filesMove.run({ folder: 'Desktop', files: ['a.png'], destination: '../x' })).ok).toBe(false)
    expect((await filesMove.run({ folder: 'Desktop', files: ['nope.png'], destination: 'X' })).ok).toBe(false)
  })
})
