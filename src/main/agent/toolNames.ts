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

/** Built-in tools left enabled: the way this Droid calls MCP tools (see scriptCalls). */
const KEPT_BUILTINS = new Set(['Script', 'ToolSearch'])

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
  // Script and ToolSearch are how this Droid reaches MCP tools; the permission handler vets every Script.
  const ids = listed
    .filter((t) => !KEPT_BUILTINS.has(t.id) && !findFastaslTool(t.id, ours) && (sure || t.source === 'native'))
    .map((t) => t.id)
  return { ids, sure }
}

/**
 * This Droid reaches MCP tools through its built-in Script tool: the model runs
 * `text(await tools.fastasl.calendar_create_event({...}))`. Script can run code, so it is allowed
 * only when it does nothing except call tools with literal arguments, and every call it makes is a
 * fastasl tool (Droid lists them in the request's details.calls).
 */
const SCRIPT_WORDS = new Set(['text', 'await', 'tools', 'ToolSearch', 'fastasl', 'true', 'false', 'null'])
const SCRIPT_PUNCTUATION = /^[\s(){}[\],:;.\-0-9]*$/

/** Whether `script` is only awaited tool calls with literal arguments (strings, numbers, objects, arrays). */
export function isToolCallScript(script: string, toolNames: readonly string[]): boolean {
  let rest = ''
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]
    if (ch === '"' || ch === "'") {
      // Skip the whole string literal (escapes included); it stays in the code as a placeholder digit.
      let j = i + 1
      while (j < script.length && script[j] !== ch) j += script[j] === '\\' ? 2 : 1
      if (j >= script.length) return false
      rest += '0'
      i = j
    } else rest += ch
  }
  const allowed = new Set([...SCRIPT_WORDS, ...toolNames])
  const words = /[A-Za-z_$][\w$]*/g
  for (let m = words.exec(rest); m; m = words.exec(rest)) {
    const key = /^\s*:/.test(rest.slice(m.index + m[0].length)) && /[{,]\s*$/.test(rest.slice(0, m.index))
    if (!allowed.has(m[0]) && !key) return false
  }
  return SCRIPT_PUNCTUATION.test(rest.replace(/[A-Za-z_$][\w$]*/g, ''))
}

export interface ScriptedCall<T> {
  def: T
  input: Record<string, unknown>
}

/**
 * The fastasl tool calls inside a Script permission request: an empty list for a script that only
 * looks tools up (ToolSearch), null when it is not a safe script of our tool calls (cancel it).
 * Returns undefined for requests that are not a Script at all.
 */
export function scriptCalls<T extends { name: string }>(
  info: ToolConfirmationInfo,
  tools: readonly T[]
): ScriptedCall<T>[] | null | undefined {
  const { toolUse, details } = info
  if (toolUse.name !== 'Script') return undefined
  if (details.type !== ToolConfirmationType.Script) return null
  const script = (toolUse.input as { script?: unknown }).script
  if (typeof script !== 'string' || !isToolCallScript(script, tools.map((t) => t.name))) return null
  const found: ScriptedCall<T>[] = []
  for (const call of details.calls ?? []) {
    const def = findFastaslTool(call.toolName, tools)
    const mcp = call.confirmation as { serverName?: string } | undefined
    if (!def || (mcp?.serverName !== undefined && mcp.serverName !== SERVER_NAME)) return null
    found.push({ def, input: (call.toolInput ?? {}) as Record<string, unknown> })
  }
  return found
}
