import type { Mode } from '@shared/types'
import type { PickProgress } from './store'
import type { View } from './types'
import { QUICK_MENU } from './controller'
import type { MockPose } from './live'

export interface MockScene {
  view: View
  mode?: Mode
  notice?: string | null
  holdProgress?: number
  pick?: PickProgress | null
  pose?: MockPose
}

/**
 * Mock scene per dev view id (dev menu, Option+1..9, screenshots).
 * Ids must match DEV_VIEWS in src/main/devtools.ts.
 */
export const MOCK_SCENES: Record<string, MockScene> = {
  ready: { view: { kind: 'ready' }, pose: 'palm' },
  recognizing: { view: { kind: 'recognizing', token: 'A', isWord: false }, pose: 'fist' },
  building: {
    view: {
      kind: 'building',
      tokens: [
        { text: 'A', kind: 'letter' },
        { text: 'M', kind: 'letter' },
        { text: 'C', kind: 'letter' }
      ],
      current: 'C',
      sentence: 'AMC'
    },
    pose: 'c'
  },
  sentence: {
    view: {
      kind: 'sentence',
      sentence: 'Can we meet tomorrow?',
      tokens: [
        { text: 'can', kind: 'word' },
        { text: 'we', kind: 'word' },
        { text: 'meet', kind: 'word' },
        { text: 'tomorrow', kind: 'word' }
      ]
    },
    pose: 'palm'
  },
  agentReady: {
    view: {
      kind: 'agentReady',
      intent: 'Schedule a meeting tomorrow at 10am with the team',
      variant: 'default',
      sentence: 'Meeting tomorrow at 10am'
    },
    pose: 'point'
  },
  working: {
    view: {
      kind: 'working',
      intent: 'Schedule a meeting tomorrow at 10am with the team',
      steps: [
        { id: '1', label: 'Opening Calendar', status: 'done' },
        { id: '2', label: 'Creating event', status: 'done' },
        { id: '3', label: 'Adding attendees', status: 'current' },
        { id: '4', label: 'Adding meeting link', status: 'pending' }
      ]
    },
    pose: 'point'
  },
  confirm: {
    view: {
      kind: 'confirm',
      requestId: 'mock',
      details: {
        kind: 'event',
        title: 'Team Sync',
        dateLabel: 'Tomorrow, Oct 25',
        timeLabel: '10:00 – 11:00 AM',
        guestsLabel: '4 guests',
        videoLabel: 'Google Meet'
      }
    },
    pose: 'thumbsUp'
  },
  done: {
    view: {
      kind: 'done',
      ok: true,
      title: 'Meeting created',
      subtitle: 'Tomorrow at 10:00 AM with 4 guests.',
      view: { kind: 'openApp', app: 'Calendar' }
    },
    pose: 'ok'
  },
  collapsed: { view: { kind: 'collapsed' }, pose: 'palm' },
  listening: { view: { kind: 'recognizing', token: null, isWord: false }, pose: 'twoHands' },
  recognizingWord: { view: { kind: 'recognizing', token: 'good', isWord: true }, pose: 'thumbsUp' },
  buildingWords: {
    view: {
      kind: 'building',
      tokens: [
        { text: 'meeting', kind: 'word' },
        { text: 'tomorrow', kind: 'word' },
        { text: 'at', kind: 'word' },
        { text: '3', kind: 'word' },
        { text: 'pm', kind: 'word' }
      ],
      current: 'pm',
      sentence: 'Meeting tomorrow at 3pm'
    },
    pose: 'twoHands'
  },
  agentReadyEmail: {
    view: {
      kind: 'agentReady',
      intent: 'Send this email to team@company.com',
      variant: 'email',
      target: 'team@company.com',
      sentence: 'Meeting tomorrow at 3pm'
    },
    pose: 'twoHands'
  },
  confirmMessage: {
    view: {
      kind: 'confirm',
      requestId: 'mock',
      details: {
        kind: 'mail',
        to: 'team@company.com',
        subject: 'Project update',
        body: 'Meeting tomorrow at 3pm.'
      }
    },
    pose: 'thumbsUp'
  },
  didYouMean: {
    view: {
      kind: 'didYouMean',
      variant: 'list',
      options: ['machine learning', 'make a learning plan', 'search for courses'],
      purpose: 'intent'
    },
    pick: { count: 1, progress: 0.55 },
    pose: 'palm'
  },
  didYouMeanQuote: {
    view: {
      kind: 'didYouMean',
      variant: 'quote',
      quote: 'Meeting tomorrow at 3pm',
      options: ['Send "Meeting tomorrow at 3pm"'],
      purpose: 'intent'
    },
    pose: 'twoHands'
  },
  contextActions: {
    view: {
      kind: 'contextActions',
      sentence: 'Here is the project update for this week',
      actions: ['Insert text', 'Send message', 'More options']
    },
    pose: 'thumbsUp'
  },
  quickMenu: { view: { kind: 'quickMenu', options: QUICK_MENU }, pick: { count: 1, progress: 0.3 }, pose: 'point' },
  dictation: {
    view: { kind: 'dictation', text: 'better human computer interaction' },
    mode: 'dictation',
    pose: 'twoHands'
  },
  toast: {
    view: {
      kind: 'toast',
      title: 'Screenshot taken',
      subtitle: 'Saved to Desktop',
      meta: 'compiled · 0.4 s',
      ok: true,
      returnTo: 'collapsed'
    },
    pose: 'peace'
  },
  toastMusic: {
    view: {
      kind: 'toast',
      title: 'Playing Motion Sickness',
      subtitle: 'Phoebe Bridgers',
      meta: 'compiled · 0.4 s',
      ok: true,
      returnTo: 'ready'
    },
    pose: 'peace'
  },
  settings: { view: { kind: 'settings', settings: { page: 'root' } }, pick: { count: 1, progress: 0.4 }, pose: 'point' },
  settingsTeach: {
    view: { kind: 'settings', settings: { page: 'teachPick', offset: 0, recorded: { YES: 10, HELLO: 20 } } },
    pose: 'palm'
  },
  settingsTeachRecord: {
    view: { kind: 'settings', settings: { page: 'teachRecord', label: 'MEETING', kind: 'word', done: 2, total: 10 } },
    pose: 'twoHands'
  },
  settingsTeachSpell: {
    view: { kind: 'settings', settings: { page: 'teachSpell', letters: 'KRIS', canSpell: true } },
    pose: 'c'
  },
  settingsTeachRetry: {
    view: {
      kind: 'settings',
      settings: {
        page: 'teachRecord',
        label: 'HELLO',
        kind: 'word',
        done: 4,
        total: 10,
        reason: "That one didn't match the others. Try again."
      }
    },
    pose: 'palm'
  },
  settingsNewGesture: {
    view: {
      kind: 'settings',
      settings: {
        page: 'newGesturePick',
        tasks: ['Take a screenshot', 'Play Motion Sickness on Spotify', 'Open Notes']
      }
    },
    pose: 'point'
  },
  settingsHoldShape: {
    view: { kind: 'settings', settings: { page: 'newGestureHold', task: 'Play Motion Sickness on Spotify', countdown: 2 } },
    pose: 'ok'
  },
  settingsShapeRecording: {
    view: { kind: 'settings', settings: { page: 'newGestureHold', task: 'Play Motion Sickness on Spotify', countdown: 0 } },
    pose: 'ok'
  },
  settingsShapeRefused: {
    view: {
      kind: 'settings',
      settings: {
        page: 'newGestureHold',
        task: 'Play Motion Sickness on Spotify',
        countdown: 0,
        reason: 'That reads as a fist, a control gesture. Try another shape.'
      }
    },
    pose: 'fist'
  },
  settingsGestures: {
    view: {
      kind: 'settings',
      settings: {
        page: 'gestures',
        gestures: [
          { id: 'builtin-peace', name: 'Peace sign', task: 'Take a screenshot', builtin: true },
          { id: 'g2', name: 'Gesture 2', task: 'Play Motion Sickness on Spotify' },
          { id: 'g3', name: 'Gesture 3', task: 'Open Notes' },
          { id: 'g4', name: 'Gesture 4', task: 'Text Sam on my way' },
          { id: 'g5', name: 'Gesture 5', task: 'Search the web for ASL alphabet' }
        ],
        offset: 0
      }
    },
    pose: 'palm'
  },
  toastGestureSaved: {
    view: {
      kind: 'toast',
      title: 'Gesture saved',
      subtitle: 'Gesture 2 · Play Motion Sickness on Spotify',
      ok: true,
      returnTo: 'ready'
    },
    pose: 'ok'
  },
  settingsCamera: {
    view: { kind: 'settings', settings: { page: 'camera', current: 'builtin', url: 'http://192.168.1.50:81/stream' } },
    pose: 'palm'
  },
  settingsSensitivity: { view: { kind: 'settings', settings: { page: 'sensitivity', current: 'medium' } }, pose: 'palm' },
  missingKey: {
    view: {
      kind: 'sentence',
      sentence: 'What time is my next meeting?',
      tokens: []
    },
    notice: 'Add ANTHROPIC_API_KEY to .env',
    pose: 'palm'
  },
  palmHold: { view: { kind: 'collapsed' }, holdProgress: 0.65, pose: 'palm' },
  spellMode: {
    // The raw letters first, then Claude's fixes (which never add what wasn't spelled).
    view: {
      kind: 'didYouMean',
      variant: 'list',
      quote: 'KRISNA',
      options: ['KRISNA', 'Krishna', 'Krisna'],
      purpose: 'spell'
    },
    mode: 'spell',
    pose: 'c'
  },
  spellPending: {
    view: { kind: 'didYouMean', variant: 'list', quote: 'KRISNA', options: ['KRISNA'], purpose: 'spell', pending: true },
    mode: 'spell',
    pose: 'c'
  },
  dictationNoAccess: {
    view: { kind: 'dictation', text: 'see you at' },
    mode: 'dictation',
    notice: 'Allow fastASL in System Settings › Privacy & Security › Accessibility',
    pose: 'twoHands'
  },
  dictationNoAutomation: {
    view: { kind: 'dictation', text: 'see you at' },
    mode: 'dictation',
    notice: 'Turn on System Events for fastASL in Privacy & Security › Automation',
    pose: 'twoHands'
  }
}

/** Ordered list for `npm run screens` -> docs/screens/NN-<id>.png */
export const SCREENSHOT_ORDER: string[] = [
  'collapsed',
  'palmHold',
  'ready',
  'listening',
  'recognizing',
  'recognizingWord',
  'building',
  'buildingWords',
  'sentence',
  'agentReady',
  'agentReadyEmail',
  'working',
  'confirm',
  'confirmMessage',
  'done',
  'didYouMean',
  'didYouMeanQuote',
  'contextActions',
  'quickMenu',
  'dictation',
  'spellMode',
  'toast',
  'toastMusic',
  'settings',
  'settingsTeach',
  'settingsTeachRecord',
  'settingsNewGesture',
  'settingsHoldShape',
  'settingsGestures',
  'settingsCamera',
  'settingsSensitivity',
  'missingKey',
  'settingsTeachSpell',
  'settingsTeachRetry',
  'spellPending',
  'dictationNoAccess',
  'dictationNoAutomation',
  'settingsShapeRecording',
  'settingsShapeRefused',
  'toastGestureSaved'
]
