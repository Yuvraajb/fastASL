import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SEP, runAppleScript } from '../mac/osascript'
import {
  JOIN_HANDLES_HANDLER,
  contactSearchScript,
  contactsFind,
  groupPeople,
  matchesWords,
  messageHandle,
  parseContacts,
  pickContact,
  searchNeedle,
  type Contact
} from './contacts'

vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn()
}))

const runMock = vi.mocked(runAppleScript)
const LABEL = '\u001c'
const handles = (...pairs: [string, string][]): string => pairs.map(([l, v]) => `${l}${LABEL}${v}`).join(SEP.list)
const card = (name: string, phones = '', emails = ''): string => [name, phones, emails].join(SEP.field)

const person = (name: string, phones: string[] = [], emails: string[] = []): Contact => ({
  name,
  phones: phones.map((value) => ({ label: 'mobile', value })),
  emails: emails.map((value) => ({ label: 'home', value }))
})

beforeEach(() => {
  runMock.mockReset()
})

describe('contactSearchScript', () => {
  it('runs the search once and reads every property in bulk', () => {
    const script = contactSearchScript('O"Neil')
    expect(script).toContain('set found to a reference to (every person whose name contains "O\\"Neil")')
    expect(script).toContain('if (count of found) is 0 then return ""')
    expect(script).toContain(
      'set {names, phoneLabels, phoneValues, emailLabels, emailValues} to ' +
        '{name, label of every phone, value of every phone, label of every email, value of every email}'
    )
    expect(script).not.toMatch(/repeat with \w+ in/)
  })

  it.runIf(process.platform === 'darwin')('zips label and value lists in real AppleScript', async () => {
    const { runAppleScript: realRun } = await vi.importActual<typeof import('../mac/osascript')>('../mac/osascript')
    const zipped = await realRun(
      `${JOIN_HANDLES_HANDLER}\nreturn joinHandles({"mobile", missing value}, {"+1 555", "555 0100"})`
    )
    expect(zipped).toBe(handles(['mobile', '+1 555'], ['missing value', '555 0100']))
    expect(await realRun(`${JOIN_HANDLES_HANDLER}\nreturn joinHandles({}, {})`)).toBe('')
    await expect(realRun(`${JOIN_HANDLES_HANDLER}\nreturn joinHandles({"a"}, {})`)).rejects.toThrow(
      'Contacts changed while it was being read. Try again.'
    )
  })
})

describe('parseContacts', () => {
  it('reads names, labelled phones and emails', () => {
    const out = [
      card('Sarah Chen', handles(['mobile', '+1 (555) 010-2000'], ['work', '555 010 3000']), handles(['home', 'sarah@example.com'])),
      card('Bo', '', handles(['missing value', 'bo@example.com']))
    ].join(SEP.record)
    expect(parseContacts(out)).toEqual([
      {
        name: 'Sarah Chen',
        phones: [
          { label: 'mobile', value: '+1 (555) 010-2000' },
          { label: 'work', value: '555 010 3000' }
        ],
        emails: [{ label: 'home', value: 'sarah@example.com' }]
      },
      { name: 'Bo', phones: [], emails: [{ label: '', value: 'bo@example.com' }] }
    ])
    expect(parseContacts('')).toEqual([])
  })
})

describe('name matching', () => {
  it('matches whole words or word starts, never the middle of a word', () => {
    expect(matchesWords('Sarah Chen', 'Sarah')).toBe(true)
    expect(matchesWords('Sarah Chen', 'sar ch')).toBe(true)
    expect(matchesWords('Sarah Chen', 'chen')).toBe(true)
    expect(matchesWords('Joanne Lee', 'Ann')).toBe(false)
    expect(matchesWords('Jordan Smith', 'Dan')).toBe(false)
    expect(matchesWords('Sarah Chen', 'Sarah Lopez')).toBe(false)
    expect(matchesWords('Pat O’Neil', "o'neil")).toBe(true)
    expect(matchesWords('Zoë Kim', 'zoe')).toBe(true)
    expect(matchesWords('Sarah Chen', ' ')).toBe(false)
  })

  it('pre-filters Contacts on the longest word of the query', () => {
    expect(searchNeedle('Sar Chen')).toBe('Chen')
    expect(searchNeedle("Pat O'Neil")).toBe('Neil')
    expect(searchNeedle('  ')).toBe('')
  })
})

describe('groupPeople', () => {
  it('merges same-named cards that share a number or email', () => {
    const cards = [
      person('Sarah Chen', ['+1 (555) 010-2000'], ['a@x.com']),
      person('Sarah Chen', ['15550102000', '+1666'], ['b@x.com']),
      person('Sarah Chen', [], ['B@X.com'])
    ]
    expect(groupPeople(cards)).toEqual([person('Sarah Chen', ['+1 (555) 010-2000', '+1666'], ['a@x.com', 'b@x.com'])])
  })

  it('keeps same-named cards with nothing in common apart, in order', () => {
    const people = groupPeople([person('Chris Lee', ['+1555']), person('Bo'), person('Chris Lee', ['+1777'])])
    expect(people.map((p) => p.phones[0]?.value ?? p.name)).toEqual(['+1555', 'Bo', '+1777'])
  })
})

describe('pickContact', () => {
  it('accepts an exact name, ignoring case, accents, apostrophe style and spacing', () => {
    expect(pickContact([person('Sarah Lopez', ['+1']), person('Sarah', ['+1555'])], ' sarah ')).toMatchObject({
      name: 'Sarah'
    })
    expect(pickContact([person('Zoë  Kim', ['+1555'])], 'zoe kim')).toMatchObject({ name: 'Zoë  Kim' })
    expect(pickContact([person('Pat O’Neil', ['+1555'])], "pat o'neil")).toMatchObject({ name: 'Pat O’Neil' })
  })

  it('never sends to a partial match, but suggests whole-word ones', () => {
    expect(pickContact([person('Sarah Chen', ['+1555'])], 'Sarah')).toBe(
      'No contact is named exactly “Sarah”. Did you mean Sarah Chen? Use the full name.'
    )
    expect(pickContact([person('Sarah Chen'), person('Sarah Lopez'), person('Sarah Lopez')], 'sarah')).toBe(
      'No contact is named exactly “sarah”. Did you mean Sarah Chen, Sarah Lopez? Use the full name.'
    )
    expect(pickContact([person('Joanne Lee', ['+1555'])], 'Ann')).toBe('No contact named “Ann” in Contacts')
    expect(pickContact([], 'Zed')).toBe('No contact named “Zed” in Contacts')
  })

  it('refuses two different people with the same name', () => {
    expect(pickContact([person('Chris Lee', ['+1555']), person('Chris Lee', ['+1777'])], 'Chris Lee')).toBe(
      '2 different contacts are named “Chris Lee”. Use the phone number or email instead.'
    )
  })

  it('merges duplicate cards and ignores empty ones', () => {
    const picked = pickContact(
      [person('Chris Lee', ['+1555'], ['c@x.com']), person('Chris Lee', [], ['c@x.com']), person('Chris Lee')],
      'Chris Lee'
    )
    expect(picked).toEqual(person('Chris Lee', ['+1555'], ['c@x.com']))
    expect(pickContact([person('Chris Lee')], 'Chris Lee')).toBe('Chris Lee has no phone number or email in Contacts')
  })
})

describe('messageHandle', () => {
  it('prefers a mobile number and normalizes it', () => {
    const contact: Contact = {
      name: 'S',
      phones: [
        { label: 'work', value: '555 010 3000' },
        { label: 'iPhone', value: '+1 (555) 010-2000' }
      ],
      emails: [{ label: 'home', value: 's@example.com' }]
    }
    expect(messageHandle(contact)).toBe('+15550102000')
  })

  it('falls back to any number, then email, then null', () => {
    expect(messageHandle({ name: 'S', phones: [{ label: 'home', value: '555-0100' }], emails: [] })).toBe('5550100')
    expect(messageHandle(person('S', [], ['s@example.com']))).toBe('s@example.com')
    expect(messageHandle(person('S'))).toBeNull()
  })
})

describe('contacts_find', () => {
  it('lists whole-word matches with their handles', async () => {
    runMock.mockResolvedValueOnce(
      [
        card('Sarah Chen', handles(['mobile', '+1 555 0100']), handles(['home', 'sarah@example.com'])),
        card('Sarah Chen', handles(['mobile', '+1 555 0100'])),
        card('Kassarah Diaz', handles(['home', '+1 555 0199'])),
        card('Sarah Lopez')
      ].join(SEP.record)
    )
    expect(await contactsFind.run({ query: 'sarah' })).toEqual({
      ok: true,
      text: '1. Sarah Chen: mobile +1 555 0100, home sarah@example.com\n2. Sarah Lopez: no phone or email',
      title: 'Found 2 contacts',
      subtitle: 'Sarah Chen'
    })
    expect(runMock.mock.calls[0][0]).toContain('every person whose name contains "sarah"')
  })

  it('says when nobody matches', async () => {
    runMock.mockResolvedValueOnce('')
    expect(await contactsFind.run({ query: 'Zed' })).toMatchObject({ ok: true, title: 'No matching contacts' })
  })
})
