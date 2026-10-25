import { describe, expect, it } from 'vitest'
import { parseAsk } from './ask'

describe('parseAsk', () => {
  it('reads the question and its options', () => {
    expect(parseAsk('ASK: 1 AM or 1 PM? | 1 AM | 1 PM')).toEqual({ question: '1 AM or 1 PM?', options: ['1 AM', '1 PM'] })
  })

  it('tolerates case, spacing and surrounding lines, and keeps at most three options', () => {
    expect(parseAsk('Sure.\n ask:  Which day?|Today | Tomorrow|Friday|Monday \nThanks')).toEqual({
      question: 'Which day?',
      options: ['Today', 'Tomorrow', 'Friday']
    })
  })

  it('is not a question without two options, a question, or the ASK marker', () => {
    expect(parseAsk('ASK: Which one? | only')).toBeNull()
    expect(parseAsk('ASK: | a | b')).toBeNull()
    expect(parseAsk('I need AM or PM before scheduling.')).toBeNull()
    expect(parseAsk(undefined)).toBeNull()
  })
})
