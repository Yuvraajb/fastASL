import { AutonomyLevel, createSession, type DroidSession, type DroidTool } from '@factory/droid-sdk/node'
import { createFastaslServer } from './droidTools'
import { foreignToolIds } from './toolNames'
import type { SessionFactory } from './types'

/**
 * The public SDK has no tool allowlist, so every listed tool that is not ours
 * (Read, Execute, Edit, other MCP servers...) is disabled for the session.
 * The format of MCP tool ids is not documented, so what happens is logged.
 */
export async function disableForeignTools(session: DroidSession, ours: readonly DroidTool[]): Promise<void> {
  const listed = await session.listTools()
  const { ids, sure } = foreignToolIds(listed, ours)
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
    mcpServers: [createFastaslServer(options.tools)],
    permissionHandler: options.permissionHandler,
    askUserHandler: () => ({ cancelled: true, answers: [] }),
    disableBuiltinSkills: true
  })
  try {
    await disableForeignTools(session, options.tools)
  } catch (error) {
    // Not fatal: the permission handler still cancels anything outside fastasl.
    console.warn('[agent] could not disable built-in Droid tools:', error)
  }
  return session
}
