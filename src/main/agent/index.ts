import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCallRecord } from '@shared/types'
import { getKey } from '../env'
import type { MainServices } from '../ipc'
import { addRecentTask, dataDir, getGestures, saveGestures } from '../store'
import { TOOLS, runTool } from '../tools'
import { AgentService } from './agentService'
import { NO_MCP, loadMcpConfig } from './mcpConfig'
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
  // External MCP servers are off unless FASTASL_MCP=1: the fastasl tools alone are the
  // known-good path, and a third-party server must never change a demo by surprise.
  const configured = loadMcpConfig(dataDir())
  const mcp = process.env.FASTASL_MCP === '1' ? configured : NO_MCP
  if (configured.error) console.warn('[agent] mcp.json ignored:', configured.error)
  else if (configured.names.length && mcp.names.length === 0)
    console.info('[agent] mcp.json found but not enabled; set FASTASL_MCP=1 to use', configured.names.join(', '))
  else if (mcp.names.length) console.info('[agent] external MCP servers:', mcp.names.join(', '))
  const agent = new AgentService({
    tools: TOOLS,
    runTool,
    openSession: openDroidSession,
    mcp,
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
