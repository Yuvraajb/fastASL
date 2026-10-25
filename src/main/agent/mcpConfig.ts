import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '@factory/droid-sdk/node'

/**
 * External MCP servers the agent may use, beside the fastasl tools.
 *
 * They are opt-in: with no config file, nothing changes and the agent sees only
 * the fastasl tools. That is deliberate — an MCP server is third-party code with
 * its own access to the network, so it is the user's decision to add one.
 *
 * File format (FASTASL_MCP_CONFIG, else <data dir>/mcp.json):
 * {
 *   "servers": [
 *     { "name": "notion", "url": "https://mcp.notion.com/mcp", "type": "http",
 *       "headers": [{ "name": "Authorization", "value": "Bearer ..." }] },
 *     { "name": "files", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
 *   ]
 * }
 */
export interface McpConfig {
  /** Ready to hand to createSession(); empty when no config file exists. */
  servers: McpServerConfig[]
  /** The names, used to tell which listed tools came from these servers. */
  names: string[]
  /** Why a config file that exists could not be used (for the log, never fatal). */
  error?: string
}

export const NO_MCP: McpConfig = { servers: [], names: [] }

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/

/** The config path: FASTASL_MCP_CONFIG, else <data dir>/mcp.json. */
export function mcpConfigPath(dataDir: string, configured = process.env.FASTASL_MCP_CONFIG): string {
  const explicit = configured?.trim()
  if (!explicit) return join(dataDir, 'mcp.json')
  return explicit.startsWith('~/') ? join(homedir(), explicit.slice(2)) : explicit
}

/** `${SLACK_BOT_TOKEN}` in the config reads the value from the environment, so secrets stay in .env. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_all, name: string) => env[name] ?? '')
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function headerList(value: unknown): { name: string; value: string }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const headers = value
    .map((raw) => {
      const h = raw as { name?: unknown; value?: unknown }
      const name = stringOf(h.name)
      const val = stringOf(h.value)
      return name && val ? { name, value: val } : undefined
    })
    .filter((h): h is { name: string; value: string } => h !== undefined)
  return headers.length ? headers : undefined
}

/** One JSON entry as a server config, or undefined when it cannot work. */
export function mcpServer(entry: unknown): McpServerConfig | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const raw = entry as Record<string, unknown>
  const name = stringOf(raw.name)
  if (!name || !NAME.test(name)) return undefined

  const url = stringOf(raw.url) ?? stringOf(raw.endpoint)
  if (url) {
    const kind = stringOf(raw.type) === 'sse' ? 'sse' : 'http'
    const headers = headerList(raw.headers)
    return { name, type: kind, url, ...(headers ? { headers } : {}) } as McpServerConfig
  }

  const command = stringOf(raw.command)
  if (!command) return undefined
  const args = Array.isArray(raw.args)
    ? raw.args.filter((a): a is string => typeof a === 'string').map((a) => expandEnv(a))
    : undefined
  const env = raw.env && typeof raw.env === 'object'
    ? Object.fromEntries(
        (Object.entries(raw.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as [
          string,
          string
        ][]).map(([k, v]) => [k, expandEnv(v)])
      )
    : undefined
  return {
    name,
    command,
    ...(args?.length ? { args } : {}),
    ...(env && Object.keys(env).length ? { env } : {})
  } as McpServerConfig
}

export function parseMcpConfig(raw: string): McpConfig {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return { ...NO_MCP, error: 'not valid JSON' }
  }
  const list = (doc as { servers?: unknown } | null)?.servers
  if (!Array.isArray(list)) return { ...NO_MCP, error: 'no "servers" array' }
  const servers = list.map(mcpServer).filter((s): s is McpServerConfig => s !== undefined)
  const names = servers.map((s) => s.name)
  const error = list.length > 0 && servers.length === 0 ? 'no usable server (each needs a name and a url or command)' : undefined
  return { servers, names, ...(error ? { error } : {}) }
}

/** Reads the config; a missing file is simply "no external servers". */
export function loadMcpConfig(dataDir: string, configured = process.env.FASTASL_MCP_CONFIG): McpConfig {
  const path = mcpConfigPath(dataDir, configured)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return NO_MCP
  }
  return parseMcpConfig(raw)
}
