import type { Mode } from '@shared/types'
import type { PickProgress } from './store'
import type { View } from './types'
import { cameraFallbackNotice, IDENTIFYING, NOT_A_SIGN, QUICK_MENU } from './controller'
import { MOCK_SCREENSHOT_PATH, MOCK_SCREENSHOT_SUBTITLE, MOCK_SCREENSHOT_THUMB } from './mockThumb'
import type { MockPose } from './live'
import { STREAM_LOST, STREAM_NOT_MJPEG } from '../engine/camera/cameraSource'

export interface MockScene {
  view: View
  mode?: Mode
  notice?: string | null
  holdProgress?: number
  pick?: PickProgress | null
  pose?: MockPose
  /** Camera error shown in the feed (live.error); screenshots only, where the camera never runs. */
  error?: string
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
  // Command mode: phrase end goes straight to the agent; the card shows the exchange.
  conversationUnderstanding: {
    view: { kind: 'conversation', phase: 'understanding', said: 'Hello', steps: [] },
    pose: 'palm'
  },
  conversationWorking: {
    view: {
      kind: 'conversation',
      phase: 'working',
      said: 'Meeting tomorrow at 10am with the team.',
      steps: [
        { id: 'plan', label: 'Thinking', status: 'done' },
        { id: '1', label: 'Opening Calendar', status: 'done' },
        { id: '2', label: 'Creating event', status: 'current' },
        { id: '3', label: 'Adding attendees', status: 'pending' }
      ]
    },
    pose: 'point'
  },
  conversationReply: {
    view: {
      kind: 'conversation',
      phase: 'reply',
      said: 'Hello.',
      steps: [],
      answer: { ok: true, text: 'Hello! What can I do for you?' }
    },
    pose: 'palm'
  },
  conversationDone: {
    view: {
      kind: 'conversation',
      phase: 'reply',
      said: 'Meeting tomorrow at 10am with the team.',
      steps: [],
      answer: {
        ok: true,
        title: 'Meeting created',
        subtitle: 'Tomorrow at 10:00 AM with 4 guests.',
        text: 'Team Sync is on your calendar for tomorrow at 10.',
        view: { kind: 'openApp', app: 'Calendar' }
      }
    },
    pose: 'ok'
  },
  conversationScreenshot: {
    view: {
      kind: 'conversation',
      phase: 'reply',
      said: 'Take a screenshot.',
      steps: [],
      answer: {
        ok: true,
        title: 'Screenshot taken',
        subtitle: MOCK_SCREENSHOT_SUBTITLE,
        text: 'Saved a screenshot to your Desktop.',
        view: { kind: 'openFile', path: MOCK_SCREENSHOT_PATH },
        thumb: MOCK_SCREENSHOT_THUMB
      }
    },
    pose: 'ok'
  },
  conversationFailed: {
    view: {
      kind: 'conversation',
      phase: 'reply',
      said: 'What time is it?',
      steps: [],
      answer: { ok: false, title: "Couldn't start the agent", subtitle: 'Add FACTORY_API_KEY to .env' }
    },
    pose: 'palm'
  },
  // A gesture shortcut's agent fallback still shows the plain Working card.
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
  // A close call between two signs; Did you mean for intents is gone (the agent gets the sentence).
  didYouMean: {
    view: { kind: 'didYouMean', options: ['where', 'what', 'why'], purpose: 'sign' },
    pick: { count: 1, progress: 0.55 },
    pose: 'palm'
  },
  quickMenu: { view: { kind: 'quickMenu', options: QUICK_MENU }, pick: { count: 1, progress: 0.3 }, pose: 'point' },
  dictation: {
    view: { kind: 'dictation', text: 'better human computer interaction' },
    mode: 'dictation',
    pose: 'twoHands'
  },
  // The peace sign: the screenshot shows in the toast, and thumbs up opens it in Preview.
  toast: {
    view: {
      kind: 'toast',
      title: 'Screenshot taken',
      subtitle: MOCK_SCREENSHOT_SUBTITLE,
      meta: 'compiled · 0.4 s',
      ok: true,
      view: { kind: 'openFile', path: MOCK_SCREENSHOT_PATH },
      thumb: MOCK_SCREENSHOT_THUMB,
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
    view: { kind: 'settings', settings: { page: 'teachRecord', label: 'MEETING', kind: 'word', done: 2, total: 5 } },
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
        done: 2,
        total: 5,
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
  settingsCameraUrl: {
    view: { kind: 'settings', settings: { page: 'camera', current: 'builtin', url: 'http://192.168.1.50:81/stream', editing: true } },
    pose: 'point'
  },
  // A typed URL that never showed a frame: the MacBook camera took over.
  settingsCameraError: {
    view: { kind: 'settings', settings: { page: 'camera', current: 'builtin', url: 'http://192.168.1.50/' } },
    notice: cameraFallbackNotice(STREAM_NOT_MJPEG),
    pose: 'palm'
  },
  // A stream that worked, then dropped: the pipeline keeps retrying it.
  settingsCameraLost: {
    view: { kind: 'settings', settings: { page: 'camera', current: 'mjpeg', url: 'http://192.168.1.50:81/stream' } },
    error: STREAM_LOST,
    pose: 'palm'
  },
  settingsSensitivity: { view: { kind: 'settings', settings: { page: 'sensitivity', current: 'medium' } }, pose: 'palm' },
  // No interpreter: the signed words go to the agent as they are, and the card says why.
  missingKey: {
    view: {
      kind: 'conversation',
      phase: 'working',
      said: 'What time meeting',
      steps: [{ id: 'plan', label: 'Thinking', status: 'current' }]
    },
    notice: 'Add GEMINI_API_KEY to .env',
    pose: 'point'
  },
  palmHold: { view: { kind: 'collapsed' }, holdProgress: 0.65, pose: 'palm' },
  spellMode: {
    // The raw letters first, then Claude's fixes (which never add what wasn't spelled).
    view: {
      kind: 'didYouMean',
      quote: 'KRISNA',
      options: ['KRISNA', 'Krishna', 'Krisna'],
      purpose: 'spell'
    },
    mode: 'spell',
    pose: 'c'
  },
  spellPending: {
    view: { kind: 'didYouMean', quote: 'KRISNA', options: ['KRISNA'], purpose: 'spell', pending: true },
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
  },
  // Guess, confirm, learn: a movement no taught word matched goes to the LLM while the phrase carries on.
  signIdentifying: {
    view: {
      kind: 'building',
      tokens: [
        { text: 'meeting', kind: 'word' },
        { text: 'tomorrow', kind: 'word' }
      ],
      current: null,
      sentence: 'Meeting tomorrow'
    },
    notice: IDENTIFYING,
    pose: 'palm'
  },
  signGuess: {
    view: { kind: 'didYouMean', options: ['HELLO', 'HI', 'GOODBYE'], purpose: 'learn' },
    pose: 'palm'
  },
  signLearned: {
    view: { kind: 'recognizing', token: 'hello', isWord: true },
    notice: 'Learned HELLO',
    pose: 'palm'
  },
  settingsTeachShow: {
    view: { kind: 'settings', settings: { page: 'teachShow', phase: 'waiting' } },
    pose: 'palm'
  },
  settingsTeachShowIdentifying: {
    view: { kind: 'settings', settings: { page: 'teachShow', phase: 'identifying' } },
    pose: 'palm'
  },
  settingsTeachShowGuess: {
    view: { kind: 'settings', settings: { page: 'teachShow', phase: 'guess', guesses: ['HELLO', 'HI', 'GOODBYE'] } },
    pick: { count: 1, progress: 0.5 },
    pose: 'point'
  },
  settingsTeachShowRetry: {
    view: { kind: 'settings', settings: { page: 'teachShow', phase: 'waiting', reason: NOT_A_SIGN } },
    pose: 'palm'
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
  'conversationWorking',
  'conversationReply',
  'conversationDone',
  'working',
  'confirm',
  'confirmMessage',
  'conversationScreenshot',
  'didYouMean',
  'conversationFailed',
  'conversationUnderstanding',
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
  'toastGestureSaved',
  'settingsCameraUrl',
  'settingsCameraError',
  'settingsCameraLost',
  'signIdentifying',
  'signGuess',
  'signLearned',
  'settingsTeachShow',
  'settingsTeachShowIdentifying',
  'settingsTeachShowGuess',
  'settingsTeachShowRetry'
]
