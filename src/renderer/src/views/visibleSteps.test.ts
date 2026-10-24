import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/types'
import { visibleSteps } from './visibleSteps'

const step = (label: string, status: AgentStep['status']): AgentStep => ({ id: label, label, status })
const labels = (steps: AgentStep[]): string[] => steps.map((s) => s.label)

describe('visibleSteps', () => {
  it('shows a placeholder before the first step, and short runs whole', () => {
    expect(labels(visibleSteps([]))).toEqual(['Starting agent...'])
    const steps = [step('Thinking', 'done'), step('Opening Calculator', 'current')]
    expect(visibleSteps(steps)).toEqual(steps)
  })

  it('keeps the running step in view after an earlier step failed', () => {
    const steps = [
      step('Thinking', 'done'),
      step('Messaging Sarah', 'error'),
      step('Searching Contacts', 'done'),
      step('Messaging Sarah Chen', 'done'),
      step('Checking calendar', 'done'),
      step('Creating event', 'current')
    ]
    expect(labels(visibleSteps(steps))).toEqual([
      'Messaging Sarah',
      'Searching Contacts',
      'Messaging Sarah Chen',
      'Checking calendar',
      'Creating event'
    ])
  })

  it('shows the latest steps once none is running', () => {
    const steps = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((l) => step(l, l === 'b' ? 'error' : 'done'))
    expect(labels(visibleSteps(steps))).toEqual(['c', 'd', 'e', 'f', 'g'])
  })
})
