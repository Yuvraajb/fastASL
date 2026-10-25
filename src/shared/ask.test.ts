import { describe, expect, it } from 'vitest'
import { parseAsk } from './ask'

describe('parseAsk', () => {
  it('reads a question with its options', () => {
    expect(parseAsk('ASK: When? | Morning | Afternoon | Evening | Night')).toEqual({
      question: 'When?',
      options: ['Morning', 'Afternoon', 'Evening', 'Night']
    })
  })

  it('finds the line anywhere in a reply and ignores the case of ASK', () => {
    expect(parseAsk('Sure.\nask: What time? | 9 AM | 10 AM\n')).toEqual({ question: 'What time?', options: ['9 AM', '10 AM'] })
  })

  it('keeps at most four options and needs two', () => {
    expect(parseAsk('ASK: q | a | b | c | d | e')?.options).toEqual(['a', 'b', 'c', 'd'])
    expect(parseAsk('ASK: q | only')).toBeNull()
    expect(parseAsk('ASK: | a | b')).toBeNull()
  })

  it('is null for an ordinary reply', () => {
    expect(parseAsk('Meeting set.')).toBeNull()
    expect(parseAsk(undefined)).toBeNull()
  })
})
