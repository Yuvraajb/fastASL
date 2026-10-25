import { useEffect } from 'react'
import type { SimGesture } from '@shared/types'
import { controller } from '../app/context'
import type { GestureInput } from '../app/controller'
import { applyScene } from '../app/scenes'
import { getApp, setApp } from '../app/store'
import { isReply, type Token } from '../app/types'

const SIM_WORDS = ['meeting', 'tomorrow', 'at', '3', 'pm']
const SIM_LETTERS = ['K', 'R', 'I', 'S', 'H', 'N', 'A']
const SIM_DICTATION = ['better', 'human', 'computer', 'interaction']
let simIndex = 0

function simToken(): Token {
  const mode = getApp().mode
  const list = mode === 'spell' ? SIM_LETTERS : mode === 'dictation' ? SIM_DICTATION : SIM_WORDS
  const text = list[simIndex++ % list.length]
  return { text, kind: mode === 'spell' ? 'letter' : 'word' }
}

export function simulateGesture(g: SimGesture): void {
  if (g === 'signToken') {
    const view = getApp().view
    // A new phrase (from Ready or the agent's reply, or an empty dictation box) starts the simulated word list over.
    if (view.kind === 'ready' || isReply(view) || (view.kind === 'dictation' && !view.text)) simIndex = 0
    controller.token(simToken())
    return
  }
  const map: Record<Exclude<SimGesture, 'signToken'>, GestureInput> = {
    palmHold: { gesture: 'palmHold' },
    swipeLeft: { gesture: 'swipeLeft' },
    swipeRight: { gesture: 'swipeRight' },
    swipeUp: { gesture: 'swipeUp' },
    thumbsUp: { gesture: 'thumbsUp' },
    fist: { gesture: 'fist' },
    fingers1: { gesture: 'fingers', count: 1 },
    fingers2: { gesture: 'fingers', count: 2 },
    fingers3: { gesture: 'fingers', count: 3 },
    fingers4: { gesture: 'fingers', count: 4 },
    fingers5: { gesture: 'fingers', count: 5 },
    handsDown: { gesture: 'handsDown' }
  }
  controller.gesture(map[g])
}

/** Listens for dev commands from the main process (tray menu + global hotkeys). */
export function useDevCommands(): void {
  useEffect(() => {
    if (!window.fastasl) return
    return window.fastasl.onDevCommand((cmd) => {
      if (cmd.type === 'setView') applyScene(cmd.id)
      else if (cmd.type === 'gesture') simulateGesture(cmd.gesture)
      else if (cmd.type === 'toggleDevPanel') setApp({ devPanel: !getApp().devPanel })
      else if (cmd.type === 'templatesChanged') void controller.loadTemplates()
    })
  }, [])
}
