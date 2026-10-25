import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { z } from 'zod'
import { claudeCommandPath, openTerminals, shellQuote } from '../mac/terminal'
import { plural } from './format'
import { fail } from './outcome'
import { defineTool } from './types'

export const MAX_CLAUDE_WINDOWS = 8

/** `~` and `~/x` in a folder the model or the user gave. */
function expandHome(folder: string, home = homedir()): string {
  return folder === '~' ? home : folder.startsWith('~/') ? `${home}${folder.slice(1)}` : folder
}

/** The folder shown on the card: under home as ~/... */
function tilde(folder: string, home = homedir()): string {
  return folder === home ? '~' : folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder
}

/** FASTASL_CLAUDE_DIR from .env, else the home folder. */
export function defaultClaudeFolder(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.FASTASL_CLAUDE_DIR?.trim() || '~')
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const claudeCodeOpen = defineTool({
  name: 'claude_code_open',
  description:
    "Open Claude Code (Anthropic's coding agent, the `claude` command) in new Terminal windows, tiled across the screen. " +
    `count: how many windows (1 to ${MAX_CLAUDE_WINDOWS}). folder: where it runs; leave it out for the user's usual folder.`,
  schema: {
    count: z.number().int().min(1).max(MAX_CLAUDE_WINDOWS).default(1),
    folder: z.string().trim().min(1).optional()
  },
  // Opening windows changes nothing outside them, and each Claude Code asks for its own permissions.
  risk: 'read',
  stepLabel: (args) => `Opening ${plural(args.count, 'Claude Code terminal')}`,
  async run(args) {
    const folder = args.folder ? expandHome(args.folder) : defaultClaudeFolder()
    if (!isFolder(folder)) return fail(`No folder at ${folder}`)
    const command = `cd ${shellQuote(folder)} && clear && ${shellQuote(claudeCommandPath())}`
    const opened = await openTerminals(args.count, command)
    return {
      ok: true,
      text: `Opened ${plural(opened, 'Terminal window')} running Claude Code in ${folder}, tiled on screen.`,
      title: `Opened ${plural(opened, 'Claude Code terminal')}`,
      subtitle: tilde(folder)
    }
  }
})
