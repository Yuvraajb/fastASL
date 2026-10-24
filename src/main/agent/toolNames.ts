import { ToolConfirmationType, type ToolConfirmationInfo } from '@factory/droid-sdk/node'

/** Name of the in-process MCP server that serves the fastasl tools. */
export const SERVER_NAME = 'fastasl'

/**
 * Maps a tool name as Droid reports it to one of our tools. The SDK does not
 * document whether MCP tool names arrive raw ("open_app") or server-prefixed
 * ("mcp__fastasl__open_app", "fastasl___open_app"), so both are accepted; a
 * prefixed name must mention the fastasl server.
 */
export function findFastaslTool<T extends { name: string }>(
  name: string | undefined,
  tools: readonly T[]
): T | undefined {
  if (!name) return undefined
  const exact = tools.find((t) => t.name === name)
  if (exact || !name.includes(SERVER_NAME)) return exact
  return tools
    .filter((t) => name.endsWith(t.name) && /[^A-Za-z0-9]$/.test(name.slice(0, -t.name.length)))
    .sort((a, b) => b.name.length - a.name.length)[0]
}

/** The fastasl tool a permission request is for, or undefined for anything else (built-ins, other MCP servers). */
export function matchPermissionTool<T extends { name: string }>(
  info: ToolConfirmationInfo,
  tools: readonly T[]
): T | undefined {
  const { details, toolUse } = info
  const names = [toolUse.name]
  if (details.type === ToolConfirmationType.McpTool) {
    if (details.serverName !== undefined && details.serverName !== SERVER_NAME) return undefined
    names.unshift(details.actualToolName ?? '', details.toolName)
  }
  for (const name of names) {
    const def = findFastaslTool(name, tools)
    if (def) return def
  }
  return undefined
}

/**
 * The listed Droid tools to disable: everything that is not ours. Unless every
 * fastasl tool was recognised in the list, the id format is not understood and
 * an unrecognised MCP id might be one of ours, so only built-ins are returned
 * then (`sure: false`); the permission handler still blocks the rest.
 */
export function foreignToolIds(
  listed: readonly { id: string; source?: string }[],
  ours: readonly { name: string }[]
): { ids: string[]; sure: boolean } {
  const recognised = new Set(listed.map((t) => findFastaslTool(t.id, ours)).filter((t) => t !== undefined))
  const sure = recognised.size === ours.length
  const ids = listed
    .filter((t) => !findFastaslTool(t.id, ours) && !KEPT_BUILTINS.has(t.id) && (sure || t.source === 'native'))
    .map((t) => t.id)
  return { ids, sure }
}

/**
 * Built-ins that stay on. Droid calls MCP tools (ours) from a Script: it first loads their schemas
 * with ToolSearch, then runs `tools.fastasl.<name>(...)` in a Script. With both disabled, live runs
 * never reached a fastasl tool ("I couldn't access your calendar"), and setting
 * toolExecutionMode "direct_only" after the session started changed nothing. A Script's
 * permission request lists every call inside it, so the permission handler still allows only
 * fastasl tools and ToolSearch, and confirms writes (agentService.onPermission).
 */
export const KEPT_BUILTINS: ReadonlySet<string> = new Set(['ToolSearch', 'Script'])

/** Tools a Script may call besides ours: loading tool schemas only. */
export const SCRIPT_HELPERS: ReadonlySet<string> = new Set(['ToolSearch'])
