import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import islrLabels from './islrLabels.json'
import { SignModel } from './signModel'
import { enabledFor, knownSigns, SIGN_VOCABULARY } from './vocabulary'

const byIslr = (label: string): string | undefined => SIGN_VOCABULARY.find((w) => w.islr === label)?.word
const noSession = { run: async (): Promise<Float32Array> => new Float32Array() }

describe('the sign vocabulary', () => {
  it('shows glosses as words: thankyou is "thank you", callonphone "call", food "eat", the rest lower case', () => {
    expect(byIslr('thankyou')).toBe('thank you')
    expect(byIslr('callonphone')).toBe('call')
    expect(byIslr('food')).toBe('eat')
    for (const w of SIGN_VOCABULARY) {
      expect(w.word).toBe(w.word.toLowerCase())
      if (w.islr && !['thankyou', 'callonphone', 'food'].includes(w.islr)) expect(w.word).toBe(w.islr)
    }
  })

  it('has the default demo words on and the known-weak ones off', () => {
    const on = new Set(enabledFor('islr').map((w) => w.word))
    for (const word of ['hello', 'thank you', 'yes', 'no', 'please', 'call', 'tomorrow', 'time', 'open', 'where', 'now', 'later', 'bad', 'water', 'eat']) {
      expect(on.has(word)).toBe(true)
    }
    for (const word of ['go', 'morning']) expect(on.has(word)).toBe(false)
  })

  it('names only real Kaggle labels, each word once', () => {
    const labels = islrLabels as Record<string, number>
    for (const w of SIGN_VOCABULARY) if (w.islr) expect(labels[w.islr], w.islr).toBeTypeOf('number')
    expect(new Set(SIGN_VOCABULARY.map((w) => w.word)).size).toBe(SIGN_VOCABULARY.length)
  })

  it.skipIf(!existsSync(resolve('src/renderer/public/models/asl-citizen/labels.json')))('names only real ASL Citizen glosses (local install)', () => {
    const glosses = new Set(JSON.parse(readFileSync(resolve('src/renderer/public/models/asl-citizen/labels.json'), 'utf8')) as string[])
    for (const w of SIGN_VOCABULARY) for (const g of w.citizen ?? []) expect(glosses.has(g), g).toBe(true)
  })

  it('tells the LLM the enabled words, upper case, the ASL Citizen-only ones only when it is installed', () => {
    const kaggle = knownSigns(false)
    expect(kaggle).toContain('THANK YOU')
    expect(kaggle).toContain('CALL')
    expect(kaggle).not.toContain('HELP')
    expect(kaggle).not.toContain('GO')
    expect(knownSigns(true)).toContain('HELP')
    expect(knownSigns(true)).not.toContain('GOOD')
  })

  it('a model names the enabled words it can score', () => {
    expect(new SignModel({ islr: noSession }).words).toEqual(enabledFor('islr').map((w) => w.word))
    const labels = ['HELP', 'HELLO', 'MAIL1', 'MAIL2']
    const both = new SignModel({ islr: noSession, citizen: { session: noSession, labels } })
    expect(both.hasCitizen).toBe(true)
    expect(both.words).toContain('help')
    expect(both.words).toContain('mail')
    expect(both.words).not.toContain('music') // not in these labels
  })
})
