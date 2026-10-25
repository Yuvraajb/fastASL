import { z } from 'zod'
import { calendarCreateEvent, calendarListEvents } from './calendar'
import { contactsFind } from './contacts'
import { lockScreen, setDarkMode, setTimer, setVolume } from './controls'
import { filesFind, filesList, filesMove } from './files'
import { mailList, mailRead, mailReply, mailSend } from './mail'
import { faceTimeCall } from './facetime'
import { mediaControl } from './media'
import { messageSend } from './messages'
import { notesRead, notesSearch } from './notes'
import { fail, failFrom } from './outcome'
import { spotifyPause, spotifyPlay, spotifySearch } from './spotify'
import { getFrontmostAppTool, openAppTool, takeScreenshotTool, typeTextTool, webSearchTool } from './system'
import type { ToolDef, ToolOutcome } from './types'

/** A tool's run() must never throw: whoever calls it (agent or replay) gets a failed outcome instead. */
function neverThrows(tool: ToolDef): ToolDef {
  return {
    ...tool,
    async run(args) {
      try {
        return await tool.run(args)
      } catch (err) {
        return failFrom(err)
      }
    }
  }
}

/** Every Mac automation tool the agent can use. */
export const TOOLS: readonly ToolDef[] = [
  getFrontmostAppTool,
  calendarListEvents,
  calendarCreateEvent,
  contactsFind,
  mailSend,
  mailList,
  mailRead,
  mailReply,
  messageSend,
  notesSearch,
  notesRead,
  spotifySearch,
  spotifyPlay,
  spotifyPause,
  mediaControl,
  faceTimeCall,
  filesFind,
  filesList,
  filesMove,
  setVolume,
  setDarkMode,
  setTimer,
  lockScreen,
  openAppTool,
  webSearchTool,
  typeTextTool,
  takeScreenshotTool
].map(neverThrows)

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')
}

/**
 * Validates `args` against the tool's schema and runs it. Used by compiled
 * shortcut replays, which call tools directly without any LLM.
 */
export async function runTool(name: string, args: unknown): Promise<ToolOutcome> {
  const tool = findTool(name)
  if (!tool) return fail(`Unknown tool: ${name}`)
  const parsed = z.object(tool.schema).safeParse(args ?? {})
  if (!parsed.success) return fail(`Invalid arguments for ${name}: ${describeIssues(parsed.error)}`)
  return tool.run(parsed.data)
}

export type { ToolDef, ToolOutcome } from './types'
