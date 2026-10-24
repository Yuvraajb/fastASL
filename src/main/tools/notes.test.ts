import { describe, expect, it } from 'vitest'
import { SEP } from '../mac/osascript'
import { htmlToText, parseNoteHits, readNoteScript, searchNotesScript } from './notes'

describe('htmlToText', () => {
  it('keeps line structure and bullets from Notes HTML', () => {
    const html =
      '<div><h1>Groceries</h1></div><div>Eggs &amp; milk<br></div><ul><li>Apples</li><li>Pears</li></ul><div><br></div><div>Done</div>'
    expect(htmlToText(html)).toBe('Groceries\nEggs & milk\n• Apples\n• Pears\n\nDone')
  })

  it('decodes named and numeric entities without double-decoding', () => {
    expect(htmlToText('&lt;b&gt; &quot;hi&quot; &#39;x&#39; &#x1F44B; &amp;lt; &nbsp;end')).toBe('<b> "hi" \'x\' 👋 &lt;  end')
    expect(htmlToText('&unknown; &#0;')).toBe('&unknown;')
  })

  it('drops script and style blocks', () => {
    expect(htmlToText('<style>p{}</style><div>Text</div><script>alert(1)</script>')).toBe('Text')
  })
})

describe('notes scripts', () => {
  it('searches names and bodies once, with an escaped query and a limit', () => {
    const script = searchNotesScript('budget "Q4"')
    expect(script).toContain(
      'set hits to (every note whose name contains "budget \\"Q4\\"" or plaintext contains "budget \\"Q4\\"")'
    )
    expect(script).toContain('set n to item i of hits')
    expect(script).not.toMatch(/repeat with \w+ in/)
    expect(script).toContain('if (count of out) >= 5 then exit repeat')
    expect(script).toContain('if folderName is not "Recently Deleted" then')
  })

  it('reads by exact title, then by partial title', () => {
    const script = readNoteScript('Trip\nplan')
    expect(script).toContain('set found to every note whose name is "Trip\\nplan"')
    expect(script).toContain('if found is {} then set found to every note whose name contains "Trip\\nplan"')
  })

  it('parses hits and flattens snippet whitespace', () => {
    const out = ['Groceries', 'Notes', '2026-10-20T09:00:00', 'Eggs\n  milk'].join(SEP.field)
    expect(parseNoteHits(out)).toEqual([
      { title: 'Groceries', folder: 'Notes', modified: '2026-10-20T09:00:00', snippet: 'Eggs milk' }
    ])
  })
})
