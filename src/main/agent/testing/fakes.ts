// Test doubles for the agent tests: a tiny tool list and a scripted Droid session
// that drives the real permission handler and tool handlers like droid would.
import { z } from 'zod'
import {
  DroidErrorType,
  DroidMessageType,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type DroidResultMessage,
  type DroidStreamMessage,
  type DroidToolResult,
  type ToolConfirmationInfo
} from '@factory/droid-sdk/node'
import type { AgentEvent, CompletedTask } from '@shared/types'
import { defineTool, type ToolDef, type ToolOutcome } from '../../tools/types'
import { AgentService, type AgentDeps } from '../agentService'
import type { DroidSessionLike, SessionFactory, SessionOptions } from '../types'

export function makeTools() {
  const runs: string[] = []
  const tools: ToolDef[] = [
    defineTool({
      name: 'take_screenshot',
      description: 'Take a screenshot',
      schema: {},
      risk: 'read',
      stepLabel: () => 'Taking screenshot',
      run: async () => {
        runs.push('take_screenshot')
        return { ok: true, text: 'Saved Screenshot.png to Desktop', title: 'Screenshot saved', subtitle: 'Desktop' }
      }
    }),
    defineTool({
      name: 'send_message',
      description: 'Send an iMessage',
      schema: { to: z.string(), text: z.string() },
      risk: 'write',
      stepLabel: ({ to }) => `Messaging ${to}`,
      confirmDetails: ({ to, text }) => ({ kind: 'message', to, text }),
      run: async ({ to }) => {
        runs.push('send_message')
        if (to === 'Nobody') return { ok: false, text: 'No contact named Nobody' }
        return { ok: true, text: `Sent to ${to}`, title: 'Message sent', subtitle: `To ${to}` }
      }
    }),
    defineTool({
      name: 'read_calendar',
      description: 'Read the calendar',
      schema: {},
      risk: 'read',
      stepLabel: () => 'Checking calendar',
      run: async () => {
        runs.push('read_calendar')
        return { ok: false, text: 'Calendar access was denied' }
      }
    })
  ]
  const runTool = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    const def = tools.find((t) => t.name === name)
    return def ? def.run(z.object(def.schema).parse(args)) : { ok: false, text: `Unknown tool ${name}` }
  }
  return { tools, runs, runTool }
}

export function toolUse(name: string, input: Record<string, unknown>, serverName = 'fastasl'): ToolConfirmationInfo {
  return {
    toolUse: { type: 'tool_use' as ToolConfirmationInfo['toolUse']['type'], id: `use-${name}`, name, input },
    confirmationType: ToolConfirmationType.McpTool,
    details: { type: ToolConfirmationType.McpTool, toolName: name, impactLevel: 'high', serverName }
  }
}

type ResultSubtype = 'success' | 'interrupted' | 'error_during_execution'

export function resultMessage(subtype: ResultSubtype, text = ''): DroidResultMessage {
  const base = {
    type: DroidMessageType.Result,
    sessionId: 's1',
    durationMs: 5,
    tokenUsage: null,
    messages: [],
    text,
    turnCount: 1
  }
  if (subtype === 'success') return { ...base, subtype, success: true, interrupted: false, error: null }
  if (subtype === 'interrupted') return { ...base, subtype, success: false, interrupted: true, error: null }
  const error = { type: DroidMessageType.Error, message: text, errorType: DroidErrorType.ERROR, timestamp: '' }
  return { ...base, subtype, success: false, interrupted: false, error }
}

export type TurnScript = (session: FakeSession) => AsyncGenerator<DroidStreamMessage>

/** Droid asks for permission, then (if allowed) calls the tool, then finishes with the model's own claim. */
export function callTool(name: string, input: Record<string, unknown> = {}, claim = 'All done!'): TurnScript {
  return callTools([[name, input]], claim)
}

/** Several tool calls in one turn; a cancelled permission ends the turn as droid does. */
export function callTools(calls: [string, Record<string, unknown>][], claim = 'All done!'): TurnScript {
  return async function* (session) {
    for (const [name, input] of calls) {
      if ((await session.callTool(name, input)) === 'cancelled') {
        yield resultMessage('interrupted', claim)
        return
      }
    }
    yield resultMessage('success', claim)
  }
}

export const reply = (text: string): TurnScript =>
  async function* () {
    yield { type: DroidMessageType.Assistant, text, message: {} as never }
    yield resultMessage('success', text)
  }

export class FakeSession implements DroidSessionLike {
  readonly prompts: string[] = []
  interrupts = 0
  closed = false

  constructor(
    readonly options: SessionOptions,
    private readonly turns: TurnScript[]
  ) {}

  async *stream(prompt: string): AsyncGenerator<DroidStreamMessage> {
    this.prompts.push(prompt)
    const turn = this.turns.shift()
    if (!turn) throw new Error('No scripted turn left')
    yield* turn(this)
  }

  async interrupt(): Promise<void> {
    this.interrupts++
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** One permission request, possibly covering several tool uses. */
  async requestPermission(toolUses: ToolConfirmationInfo[]): Promise<'proceed' | 'cancelled'> {
    const decision = await this.options.permissionHandler({
      toolUses,
      options: [
        { label: 'Allow once', value: ToolConfirmationOutcome.ProceedOnce },
        { label: 'Cancel', value: ToolConfirmationOutcome.Cancel }
      ]
    })
    const selected = typeof decision === 'object' ? decision.selectedOption : decision
    return selected === ToolConfirmationOutcome.ProceedOnce ? 'proceed' : 'cancelled'
  }

  /** What droid does for an MCP tool call: permission first, then the tool handler. */
  async callTool(
    name: string,
    input: Record<string, unknown>,
    info: ToolConfirmationInfo = toolUse(name, input)
  ): Promise<'cancelled' | DroidToolResult> {
    if ((await this.requestPermission([info])) === 'cancelled') return 'cancelled'
    return this.runHandler(name, input)
  }

  /** Calls the SDK tool handler directly, bypassing the permission step. */
  runHandler(name: string, input: Record<string, unknown>): Promise<DroidToolResult> {
    const tool = this.options.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`No SDK tool ${name}`)
    return Promise.resolve(tool.handler(input))
  }
}

/** An AgentService wired to fakes; `turns` is shared by every session it opens. */
export function makeAgent(turns: TurnScript[], overrides: Partial<AgentDeps> = {}) {
  const { tools, runs, runTool } = makeTools()
  const events: AgentEvent[] = []
  const recent: CompletedTask[] = []
  const sessions: FakeSession[] = []
  const openSession: SessionFactory = async (options) => {
    const session = new FakeSession(options, turns)
    sessions.push(session)
    return session
  }
  const agent = new AgentService({
    tools,
    runTool,
    openSession,
    apiKey: () => 'fk-test',
    droidPath: async () => ({ ok: true, value: '/usr/local/bin/droid' }),
    addRecentTask: (task) => recent.push(task),
    cwd: '/tmp',
    now: () => new Date('2026-10-24T22:45:00Z'),
    timeZone: () => 'America/Los_Angeles',
    ...overrides
  })
  const emit = (event: AgentEvent): void => {
    events.push(event)
  }
  return { agent, emit, events, recent, runs, sessions, tools, runTool }
}

export const request = (intent: string) => ({ intent, sentence: intent, frontmost: { name: 'Messages' } })
