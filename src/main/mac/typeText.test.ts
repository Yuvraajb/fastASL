import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsString, runJxa } from './osascript'
import { clipboardSwapScript, pasteScript, typeText } from './typeText'

vi.mock('./osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./osascript')>()),
  runJxa: vi.fn()
}))

const runJxaMock = vi.mocked(runJxa)

describe('pasteScript', () => {
  it('embeds the text as an escaped JS literal', () => {
    const text = 'He said "hi"\n`${x}` \\ end'
    expect(pasteScript(text)).toContain(`pb.setStringForType(${jsString(text)}, $.NSPasteboardTypeString)`)
  })

  it('checks System Events before touching the clipboard, then pastes and restores', () => {
    const script = pasteScript('x')
    const order = ['uiElementsEnabled()', 'pasteboardItems', 'clearContents', "keystroke('v', { using: 'command down' })", 'delay(0.3)', 'finally', 'writeObjects']
    const positions = order.map((needle) => script.indexOf(needle))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('marks the temporary text as transient for clipboard managers', () => {
    expect(pasteScript('x')).toContain("'org.nspasteboard.TransientType'")
  })
})

describe('typeText', () => {
  beforeEach(() => {
    runJxaMock.mockReset()
  })

  it('does nothing for empty text', async () => {
    expect(await typeText('')).toEqual({ ok: true, value: undefined })
    expect(runJxaMock).not.toHaveBeenCalled()
  })

  it('runs calls one at a time, in order', async () => {
    const events: string[] = []
    runJxaMock.mockImplementation(async (script: string) => {
      const which = script.includes('"first"') ? 'first' : 'second'
      events.push(`start ${which}`)
      await new Promise((r) => setTimeout(r, which === 'first' ? 30 : 1))
      events.push(`end ${which}`)
      return 'ok'
    })
    await Promise.all([typeText('first'), typeText('second')])
    expect(events).toEqual(['start first', 'end first', 'start second', 'end second'])
  })

  it('returns a friendly error and keeps the queue alive after a failure', async () => {
    runJxaMock.mockRejectedValueOnce(new Error('Allow fastASL in System Settings › Privacy & Security › Accessibility'))
    runJxaMock.mockResolvedValueOnce('ok')
    expect(await typeText('a')).toEqual({
      ok: false,
      error: 'Allow fastASL in System Settings › Privacy & Security › Accessibility'
    })
    expect(await typeText('b')).toEqual({ ok: true, value: undefined })
  })
})

// Exercises the real snapshot/restore code on a private, uniquely named
// pasteboard so the user's clipboard is never touched.
describe.runIf(process.platform === 'darwin')('clipboardSwapScript on a private pasteboard', () => {
  const jxa = (script: string): string =>
    execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', stdio: 'pipe' }).replace(/\n$/, '')

  const pasteboardName = `fastasl-test-${process.pid}-${Date.now()}`
  const pasteboard = `$.NSPasteboard.pasteboardWithName(${jsString(pasteboardName)})`

  /** Two items: plain + custom type, and an HTML-only item. */
  const seed = (): void => {
    jxa(`ObjC.import('AppKit');
const pb = ${pasteboard};
pb.clearContents;
const a = $.NSPasteboardItem.alloc.init;
a.setStringForType('original text', $.NSPasteboardTypeString);
a.setStringForType('custom payload', 'com.fastasl.test');
const b = $.NSPasteboardItem.alloc.init;
b.setStringForType('<b>bold</b>', $.NSPasteboardTypeHTML);
pb.writeObjects($([a, b]));
'seeded'`)
  }

  const dump = (): unknown =>
    JSON.parse(
      jxa(`ObjC.import('AppKit');
const pb = ${pasteboard};
const items = pb.pasteboardItems;
const out = [];
for (let i = 0; i < Number(items.count); i++) {
  const item = items.objectAtIndex(i);
  const types = item.types;
  const entry = {};
  for (let j = 0; j < Number(types.count); j++) {
    const t = types.objectAtIndex(j).js;
    entry[t] = item.stringForType(t).js;
  }
  out.push(entry);
}
JSON.stringify(out)`)
    )

  const swap = (whileSet: string): string => jxa(clipboardSwapScript('typed by fastASL', { pasteboard, whileSet }))

  it('puts the text on the pasteboard, then restores every item and type', () => {
    seed()
    const before = dump()
    expect(before).toEqual([
      { 'public.utf8-plain-text': 'original text', 'com.fastasl.test': 'custom payload' },
      { 'public.html': '<b>bold</b>' }
    ])
    swap(`if (pb.stringForType($.NSPasteboardTypeString).js !== 'typed by fastASL') throw new Error('text not set');`)
    expect(dump()).toEqual(before)
  })

  it('restores even when the paste step fails', () => {
    seed()
    const before = dump()
    expect(() => swap("throw new Error('paste failed');")).toThrow(/paste failed/)
    expect(dump()).toEqual(before)
  })

  it('keeps a newer copy made while the text was on the pasteboard', () => {
    seed()
    swap("pb.clearContents; pb.setStringForType('copied meanwhile', $.NSPasteboardTypeString);")
    expect(dump()).toEqual([{ 'public.utf8-plain-text': 'copied meanwhile' }])
  })

  it('leaves an empty pasteboard empty', () => {
    jxa(`ObjC.import('AppKit'); ${pasteboard}.clearContents; 'x'`)
    swap('')
    expect(dump()).toEqual([])
    jxa(`ObjC.import('AppKit'); ${pasteboard}.releaseGlobally; 'x'`)
  })
})
