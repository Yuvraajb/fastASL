import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDroidPath } from '../agent/droidPath'
import { getKey } from '../env'
import type { MainServices } from '../ipc'
import { dataDir } from '../store'
import { ChatService } from './chatService'
import { openChatSession } from './session'

export type ChatServices = Required<Pick<MainServices, 'chatSend' | 'chatStop' | 'chatReset'>> & {
  /** Closes the chat session (kills its droid process); call on app quit. */
  dispose(): Promise<void>
}

/** Builds the chat services and starts the droid session in the background. Call after loadEnv(). */
export function createChatServices(): ChatServices {
  const cwd = join(dataDir(), 'chat')
  mkdirSync(cwd, { recursive: true })
  const chat = new ChatService({
    openSession: openChatSession,
    apiKey: () => getKey('FACTORY_API_KEY'),
    droidPath: () => resolveDroidPath(),
    cwd
  })
  // Opened now, in the background: the droid process takes several seconds to start.
  chat.init()
  return {
    chatSend: (id, text, emit) => {
      const t0 = Date.now()
      let first = true
      console.log(`[chat] send ${JSON.stringify(text)}`)
      return chat.send(id, text, (e) => {
        if (e.type === 'delta' && first) {
          first = false
          console.log(`[chat] first words after ${Date.now() - t0} ms`)
        } else if (e.type !== 'delta') {
          console.log(`[chat] ${e.type}${e.type === 'error' ? `: ${e.message}` : ''} after ${Date.now() - t0} ms`)
        }
        emit(e)
      })
    },
    chatStop: () => chat.stop(),
    chatReset: () => chat.reset(),
    dispose: () => chat.dispose()
  }
}
