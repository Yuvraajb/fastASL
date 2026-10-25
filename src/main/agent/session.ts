import { AutonomyLevel, createSession, type DroidSession, type DroidTool } from '@factory/droid-sdk/node'
import { shell } from 'electron'
import { createFastaslServer } from './droidTools'
import { foreignToolIds } from './toolNames'
import type { SessionFactory } from './types'

/**
 * The public SDK has no tool allowlist, so every listed tool that is not ours
 * (Read, Execute, Edit, other MCP servers...) is disabled for the session.
 * The format of MCP tool ids is not documented, so what happens is logged.
 */
async function disableForeignTools(
  session: DroidSession,
  ours: readonly DroidTool[],
  mcpServers: readonly string[]
): Promise<void> {
  const listed = await session.listTools()
  const { ids, sure } = foreignToolIds(listed, ours, mcpServers)
  if (!sure) {
    const others = listed.filter((t) => t.source !== 'native').map((t) => t.id)
    console.warn("[agent] droid's tool list lacks some fastasl tool ids; only built-ins are disabled. Other ids:", others)
  }
  if (ids.length === 0) return
  console.info('[agent] disabled droid tools:', ids.join(', '))
  await session.updateSettings({ disabledToolIds: ids })
}

/** Starts the real Droid session (spawns the droid CLI). */
export const openDroidSession: SessionFactory = async (options) => {
  const session = await createSession({
    apiKey: options.apiKey,
    execPath: options.execPath,
    cwd: options.cwd,
    // Off = every action goes through the permission handler, which is the real gate.
    autonomyLevel: AutonomyLevel.Off,
    systemPrompt: { type: 'preset', preset: 'droid', append: options.systemPrompt },
    // Ours first, then the servers the user opted into (none by default).
    mcpServers: [...(options.mcp?.servers ?? []), createFastaslServer(options.tools)],
    permissionHandler: options.permissionHandler,
    askUserHandler: () => ({ cancelled: true, answers: [] }),
    disableBuiltinSkills: true
  })
  // OAuth servers (Slack) sign in through the browser. Droid owns the loopback callback,
  // so all that is missing on this side is opening the URL it hands us.
  session.onNotification((note) => {
    const name = typeof note.serverName === 'string' ? note.serverName : 'an MCP server'
    if (note.type === 'mcp_auth_required' && typeof note.authUrl === 'string') {
      console.info(`[agent] ${name} needs sign-in; opening the browser`)
      void shell.openExternal(note.authUrl)
    } else if (note.type === 'mcp_auth_completed') {
      console.info(`[agent] ${name} sign-in ${String(note.outcome)}`)
    }
  })

  // An OAuth server (Slack) only asks for a sign-in when the session is told to: droid then
  // emits mcp_auth_required with the URL, which the handler above opens.
  for (const server of options.mcp?.servers ?? []) {
    if (!('url' in server)) continue
    void session
      .authenticateMcpServer({ serverName: server.name })
      .then((res) => console.info(`[agent] ${server.name} sign-in: ${res.success ? 'ready' : 'needs attention'}`))
      .catch((error) => console.warn(`[agent] ${server.name} sign-in failed:`, error))
  }

  try {
    await disableForeignTools(session, options.tools, options.mcp?.names ?? [])
  } catch (error) {
    // Not fatal: the permission handler still cancels anything outside fastasl.
    console.warn('[agent] could not disable built-in Droid tools:', error)
  }
  return session
}
