import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCallRecord } from '@shared/types'
import { getKey } from '../env'
import type { MainServices } from '../ipc'
import { addRecentTask, dataDir, getGestures, saveGestures } from '../store'
import { TOOLS, runTool } from '../tools'
import { AgentService } from './agentService'
import { resolveDroidPath } from './droidPath'
import { openDroidSession } from './session'
import { runShortcut } from './shortcuts'

export type AgentServices = Required<Pick<MainServices, 'agentRun' | 'agentStop' | 'agentRespond' | 'runShortcut'>> & {
  /** Successful tool calls of the most recent run, empty unless it completed the task (to compile a new gesture shortcut). */
  lastRunCalls(): ToolCallRecord[]
  /** Closes the Droid session (kills the droid process); call on app quit. */
  dispose(): Promise<void>
}

/** Builds the agent services and starts the Droid session in the background. Call after loadEnv(). */
export function createAgentServices(): AgentServices {
  const cwd = join(dataDir(), 'agent')
  mkdirSync(cwd, { recursive: true })
  const agent = new AgentService({
    tools: TOOLS,
    runTool,
    openSession: openDroidSession,
    apiKey: () => getKey('FACTORY_API_KEY'),
    droidPath: () => resolveDroidPath(),
    addRecentTask,
    cwd
  })
  agent.init()
  return {
    agentRun: (req, emit) => agent.run(req, emit),
    agentStop: () => agent.stop(),
    agentRespond: (requestId, approved) => agent.respond(requestId, approved),
    runShortcut: (gestureId, emit) => runShortcut(gestureId, emit, { agent, getGestures, saveGestures }),
    lastRunCalls: () => agent.lastRunCalls(),
    dispose: () => agent.dispose()
  }
}
