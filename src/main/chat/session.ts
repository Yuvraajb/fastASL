import {
  AutonomyLevel,
  DroidMessageType,
  ToolConfirmationOutcome,
  createSession
} from '@factory/droid-sdk/node'
import { disableForeignTools } from '../agent/session'
import type { ChatPiece, ChatSessionFactory } from './chatService'

export const CHAT_PROMPT = [
  "You are the chat assistant inside fastASL, an app that lets people type with American Sign Language.",
  'The user\'s message was transcribed from signs, word by word, so it can be short or in ASL gloss order ("tomorrow meeting what time"). Read it charitably and answer what they most likely meant.',
  'Reply in plain text, 1 to 4 short sentences, no markdown, no lists unless asked. You have no tools and cannot read files or use the computer here.'
].join('\n')

/** Starts the real Droid chat session (spawns the droid CLI) with no tools. */
export const openChatSession: ChatSessionFactory = async (options) => {
  const session = await createSession({
    apiKey: options.apiKey,
    execPath: options.execPath,
    cwd: options.cwd,
    autonomyLevel: AutonomyLevel.Off,
    systemPrompt: { type: 'preset', preset: 'droid', append: CHAT_PROMPT },
    // Chat only: anything the model asks to do is refused.
    permissionHandler: () => ToolConfirmationOutcome.Cancel,
    askUserHandler: () => ({ cancelled: true, answers: [] }),
    disableBuiltinSkills: true
  })
  try {
    await disableForeignTools(session, [])
  } catch (error) {
    console.warn('[chat] could not disable built-in Droid tools:', error)
  }
  return {
    async *stream(prompt, signal): AsyncGenerator<ChatPiece> {
      for await (const ev of session.stream(prompt, { includePartialMessages: true, abortSignal: signal })) {
        if (ev.type === DroidMessageType.AssistantTextDelta) yield { kind: 'delta', text: ev.text }
        else if (ev.type === DroidMessageType.Error) yield { kind: 'error', message: ev.message }
        else if (ev.type === DroidMessageType.Result) yield { kind: 'end', ok: ev.success, interrupted: ev.subtype === 'interrupted' }
      }
    },
    close: () => session.close()
  }
}
