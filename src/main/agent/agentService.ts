import {
  DroidMessageType,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type DroidResultMessage,
  type DroidTool,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams
} from '@factory/droid-sdk/node'
import type { AgentEvent, AgentRunRequest, CompletedTask, Result, ToolCallRecord } from '@shared/types'
import type { ToolDef } from '../tools/types'
import { callsComplete, confirmDetailsFor, errorText, parseArgs, performCall, summarize, type ToolArgs } from './calls'
import { buildDroidTools } from './droidTools'
import { SYSTEM_PROMPT, turnPrompt } from './prompt'
import { Run } from './run'
import type { McpConfig } from './mcpConfig'
import { findFastaslTool, matchPermissionTool, mcpToolAllowed, mcpToolWrites, SCRIPT_HELPERS } from './toolNames'
import type { DroidSessionLike, RunOutcome, SessionFactory, ToolRunner } from './types'

/** How long a stopped turn may take to wind down before the session is replaced. */
const STOP_GRACE_MS = 3000

export const MISSING_KEY_ERROR = 'Add FACTORY_API_KEY to .env'

/** A tool result's text: either a plain string or MCP content blocks. */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : ''
      )
      .join('\n')
      .trim()
  }
  return ''
}

export interface AgentDeps {
  tools: readonly ToolDef[]
  runTool: ToolRunner
  openSession: SessionFactory
  apiKey(): string | undefined
  droidPath(): Promise<Result<string>>
  addRecentTask(task: CompletedTask): void
  /** Working directory for the droid process (an empty folder, so no project files are in reach). */
  cwd: string
  /** External MCP servers the user opted into (see mcpConfig.ts); empty by default. */
  mcp?: McpConfig
  now?: () => Date
  timeZone?: () => string
}

export type Emit = (event: AgentEvent) => void

interface ActiveRun {
  run: Run
  /** Agent turns run in the Droid session; compiled replays do not. */
  inSession: boolean
  finished: Promise<RunOutcome>
}

interface Turn {
  result?: DroidResultMessage
  errors: string[]
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * The fastASL agent: one persistent Droid session, one run at a time. Every
 * write tool goes through a Confirm card, and a result's title and subtitle are
 * built from tool outcomes only (the model's reply rides along, AgentResult.reply).
 */
export class AgentService {
  private session: Promise<Result<DroidSessionLike>> | null = null
  private active: ActiveRun | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private stopCount = 0
  /** Set on quit: no run starts and no session opens after it. */
  private disposed = false
  private lastCalls: ToolCallRecord[] = []
  private readonly droidTools: DroidTool[]

  constructor(private readonly deps: AgentDeps) {
    this.droidTools = buildDroidTools(deps.tools, () => this.sessionRun())
  }

  /** Starts the Droid session in the background so the first command doesn't wait for it. */
  init(): void {
    void this.ensureSession().then((opened) => {
      if (!opened.ok) console.warn('[agent] session not started:', opened.error)
    })
  }

  async run(req: AgentRunRequest, emit: Emit): Promise<Result<{ runId: string }>> {
    const started = await this.start(req, emit)
    return started.ok ? { ok: true, value: { runId: started.value.runId } } : started
  }

  /** Like run(), but also hands back a promise for the run's outcome. Never throws. */
  start(req: AgentRunRequest, emit: Emit): Promise<Result<{ runId: string; completion: Promise<RunOutcome> }>> {
    const stops = this.stopCount
    return this.enqueue(async () => {
      await this.halt()
      const opened = await this.ensureSession()
      if (!opened.ok) return opened
      if (this.stopCount !== stops) return { ok: false, error: 'Stopped' }
      const run = new Run(req.intent, emit)
      this.lastCalls = []
      run.announce()
      run.openPlanStep()
      const completion = this.drive(run, req)
      this.track({ run, inSession: true, finished: completion })
      return { ok: true, value: { runId: run.runId, completion } }
    })
  }

  /**
   * Replays a compiled tool sequence without the model. Silent unless a write
   * step needs the Confirm card; 'failed' means a step failed and the caller
   * should fall back to the agent.
   */
  async replay(intent: string, calls: readonly ToolCallRecord[], emit: Emit): Promise<RunOutcome> {
    const stops = this.stopCount
    const { completion } = await this.enqueue(async (): Promise<{ completion: Promise<RunOutcome> }> => {
      await this.halt()
      if (this.disposed || this.stopCount !== stops) return { completion: Promise.resolve({ kind: 'stopped' }) }
      const run = new Run(intent, emit)
      this.lastCalls = []
      const finished = this.replaySteps(run, calls)
      this.track({ run, inSession: false, finished })
      return { completion: finished }
    })
    return completion
  }

  /**
   * Interrupts the current run right away (a pending Confirm resolves as Cancel), and a run still
   * queued behind it ends as stopped; the session stays usable.
   */
  async stop(): Promise<void> {
    this.stopCount++
    if (this.active) await this.interrupt(this.active)
  }

  async respond(requestId: string, approved: boolean): Promise<void> {
    this.active?.run.respond(requestId, approved)
  }

  /** Successful tool calls of the most recent run if it completed the task, in order (what a gesture shortcut compiles to); else empty. */
  lastRunCalls(): ToolCallRecord[] {
    return [...this.lastCalls]
  }

  /** On quit. Queued runs end as stopped and no session opens again, so no droid outlives the app. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stopCount++
    this.active?.run.stop()
    await this.dropSession()
  }

  // -- runs -------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private track(active: ActiveRun): void {
    this.active = active
    void active.finished.then(() => {
      if (this.active === active) this.active = null
    })
  }

  private sessionRun(): Run | null {
    return this.active?.inSession ? this.active.run : null
  }

  private async interrupt(active: ActiveRun): Promise<void> {
    active.run.stop()
    if (!active.inSession) return
    const opened = await this.session
    if (!opened?.ok) return
    await opened.value.interrupt().catch((error: unknown) => console.warn('[agent] interrupt failed:', error))
  }

  /**
   * Stops the active run and waits (briefly) for it to wind down. A turn that
   * won't stop costs the session; a replay never touched it, so a slow replay
   * step just finishes on its own.
   */
  private async halt(): Promise<void> {
    const active = this.active
    if (!active) return
    if (!active.run.stopped) await this.interrupt(active)
    if (!(await settlesWithin(active.finished, STOP_GRACE_MS)) && active.inSession) await this.dropSession()
  }

  private async drive(run: Run, req: AgentRunRequest): Promise<RunOutcome> {
    const now = this.deps.now?.() ?? new Date()
    const timeZone = this.deps.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    return this.conclude(run, await this.streamTurn(run, turnPrompt(req, now, timeZone)))
  }

  /** Streams one turn. Never throws: a session that won't start or a stream that breaks ends up in `errors`. */
  private async streamTurn(run: Run, prompt: string): Promise<Turn> {
    for (let attempt = 1; ; attempt++) {
      const opened = await this.ensureSession()
      if (!opened.ok) return { errors: [opened.error] }
      const turn: Turn = { errors: [] }
      let received = false
      try {
        for await (const message of opened.value.stream(prompt)) {
          received = true
          if (message.type === DroidMessageType.Result) turn.result = message
          else if (message.type === DroidMessageType.Error) turn.errors.push(message.message)
          else if ((message as { type?: string }).type === 'tool_result') {
            // What an external lookup actually returned, so the card can show it instead of
            // trusting the model to repeat it.
            const result = message as unknown as { toolName?: string; content?: unknown; isError?: boolean }
            if (!result.isError && result.toolName && mcpToolAllowed(result.toolName, this.deps.mcp?.names ?? [])) {
              const text = textOfContent(result.content)
              if (text) run.recordRead(result.toolName, text.slice(0, 600))
            }
          }
        }
        return turn
      } catch (error) {
        // A throwing stream means the session is unusable (droid exited, protocol error): replace it,
        // and retry once if the turn never got going (never once a tool ran: that could repeat a write).
        await this.dropSession()
        const started = received || run.calls.length > 0
        if (started || run.stopped || attempt > 1) return { ...turn, errors: [...turn.errors, errorText(error)] }
      }
    }
  }

  private conclude(run: Run, { result, errors }: Turn): RunOutcome {
    if (run.stopped) return this.stoppedRun(run)
    // Interrupted without our stop() = droid ended the turn after a cancelled permission request.
    const crashed = !result || (!result.success && !result.interrupted)
    const error = crashed ? (result?.error?.message ?? errors.at(-1) ?? 'The agent stopped without finishing') : undefined
    // Whatever really ran is reported as done, so the user never redoes a sent message.
    if (error !== undefined && !run.calls.some((c) => c.outcome.ok)) {
      run.emit({ type: 'error', runId: run.runId, message: error })
      return { kind: 'failed', message: error }
    }
    // The model's last message is its answer only when the turn ended normally (not cancelled or broken off).
    const reply = result?.success ? { reply: result.text } : {}
    return this.finish(run, { finished: result?.success === true, error, ...reply })
  }

  private async replaySteps(run: Run, calls: readonly ToolCallRecord[]): Promise<RunOutcome> {
    for (const call of calls) {
      const def = this.deps.tools.find((t) => t.name === call.tool)
      const args = def && parseArgs(def, call.args)
      if (!def || !args) return { kind: 'failed', message: `Can't replay ${call.tool}` }
      if (def.risk === 'write' && !(await run.confirm(def.name, confirmDetailsFor(def, args)))) {
        if (run.stopped) return this.stoppedRun(run)
        run.declined = true
        break
      }
      const outcome = await performCall(run, def, args, () => this.deps.runTool(def.name, args))
      // Checked before the failure: a stopped or superseded shortcut must not fall back to the agent.
      if (run.stopped) return this.stoppedRun(run)
      if (!outcome.ok) return { kind: 'failed', message: outcome.text }
    }
    return run.stopped ? this.stoppedRun(run) : this.finish(run)
  }

  /**
   * A stopped run sends no Done, unless a write had gone through, one still running at the stop
   * included (an AppleScript send can't be called back). Then Done reports it once that tool
   * settles, so the user doesn't repeat it. The outcome doesn't wait for that.
   */
  private stoppedRun(run: Run): RunOutcome {
    void run.idle().then(() => {
      if (!run.calls.some((c) => c.def.risk === 'write' && c.outcome.ok)) return
      run.reportStopped(summarize(run.calls, { complete: false, declined: run.declined, stopped: true }))
    })
    return { kind: 'stopped' }
  }

  /**
   * Emits Done. `turn` is how the agent turn itself ended (and the model's last text, when it
   * finished); a replay has none and is not saved as a recent task. Only a complete run counts
   * as a success: a reply with no tool call is an answer, not a task done.
   */
  private finish(run: Run, turn?: { finished: boolean; error?: string; reply?: string }): RunOutcome {
    // A run whose work happened entirely inside an external MCP server has no recorded calls;
    // it still did something, and its reply is the only thing worth showing.
    const acted = run.calls.length > 0 || run.external.length > 0
    const complete =
      (turn?.finished ?? true) &&
      (run.calls.length > 0 ? callsComplete(run.calls, run.declined) : acted && !run.declined)
    const result = summarize(run.calls, {
      complete,
      declined: run.declined,
      error: turn?.error,
      reply: turn?.reply,
      external: run.external,
      ...(run.read ? { read: run.read } : {})
    })
    const succeeded = run.calls.filter((c) => c.outcome.ok).map((c) => c.record)
    this.lastCalls = complete ? succeeded : []
    if (process.env.FASTASL_LOG === '1')
      console.info(
        `[agent] done complete=${complete} calls=${run.calls.length} external=${run.external.length}` +
          ` reply=${turn?.reply ? JSON.stringify(turn.reply.slice(0, 80)) : 'none'}`
      )
    run.emit({ type: 'done', runId: run.runId, result, complete })
    if (turn && complete) {
      const at = (this.deps.now?.() ?? new Date()).getTime()
      try {
        this.deps.addRecentTask({ intent: run.intent, title: result.title, at, evidence: result.evidence })
      } catch (error) {
        console.warn('[agent] could not save recent task:', error)
      }
    }
    return { kind: 'done', result, complete, succeeded }
  }

  // -- permissions ------------------------------------------------------------

  /** Auto-approves fastasl read tools, confirms write tools with the user, cancels everything else. */
  private async onPermission({
    toolUses,
    options
  }: RequestPermissionRequestParams): Promise<RequestPermissionHandlerResult> {
    const cancel = ToolConfirmationOutcome.Cancel
    const run = this.sessionRun()
    if (!run || run.stopped || toolUses.length === 0) return cancel

    const matched: [ToolDef, ToolArgs][] = []
    // Calls into the external MCP servers the user opted into. Reads run straight through;
    // anything that could change something is confirmed like our own write tools.
    const external: { name: string; args: Record<string, unknown>; writes: boolean }[] = []
    const mcpNames = this.deps.mcp?.names ?? []
    for (const use of toolUses) {
      // Droid calls MCP tools from a Script: allowed when every call inside is ours (or loads tool schemas).
      if (use.details.type === ToolConfirmationType.Script) {
        for (const call of use.details.calls) {
          if (SCRIPT_HELPERS.has(call.toolName)) continue
          const def = findFastaslTool(call.toolName, this.deps.tools)
          if (!def) {
            if (mcpToolAllowed(call.toolName, mcpNames)) {
              console.info('[agent] external tool call:', call.toolName)
              external.push({
                name: call.toolName,
                args: (call.toolInput ?? {}) as Record<string, unknown>,
                writes: mcpToolWrites(call.toolName)
              })
              continue
            }
            console.warn('[agent] cancelled a script calling a non-fastasl tool:', call.toolName)
            return cancel
          }
          matched.push([def, call.toolInput as ToolArgs])
        }
        continue
      }
      const def = matchPermissionTool(use, this.deps.tools)
      if (!def) {
        if (mcpToolAllowed(use.toolUse.name, mcpNames)) {
          console.info('[agent] external tool call:', use.toolUse.name)
          external.push({
            name: use.toolUse.name,
            args: (use.toolUse.input ?? {}) as Record<string, unknown>,
            writes: mcpToolWrites(use.toolUse.name)
          })
          continue
        }
        console.warn('[agent] cancelled a non-fastasl tool:', use.toolUse.name, use.details)
        return cancel
      }
      matched.push([def, use.toolUse.input])
    }

    const confirmed: string[] = []
    for (const [def, input] of matched) {
      if (def.risk !== 'write') continue
      // Invalid args never reach the tool (the SDK validates them); the model sees the error and retries.
      const args = parseArgs(def, input)
      if (!args) continue
      if (!(await run.confirm(def.name, confirmDetailsFor(def, args)))) {
        if (!run.stopped) run.declined = true
        return cancel
      }
      confirmed.push(def.name)
    }

    // A third-party server is never run without the user seeing which tool it is.
    for (const call of external.filter((c) => c.writes)) {
      if (!(await run.confirm(call.name, { kind: 'generic', title: 'External tool', lines: [call.name] }))) {
        if (!run.stopped) run.declined = true
        return cancel
      }
    }

    const offered = options.some((o) => o.value === ToolConfirmationOutcome.ProceedOnce)
    if (!offered || run.stopped) return cancel
    // Approvals exist only for a request that is allowed as a whole, so a partly declined one leaves none behind.
    for (const name of confirmed) run.approve(name)
    // External calls have no tool handler to record them, so remember them here.
    for (const call of external) run.recordExternal(call.name, call.args)
    return ToolConfirmationOutcome.ProceedOnce
  }

  // -- session ----------------------------------------------------------------

  /** Droid's prompt plus a note about any external MCP servers the user opted into. */
  private systemPrompt(): string {
    const names = this.deps.mcp?.names ?? []
    if (names.length === 0) return SYSTEM_PROMPT
    return (
      `${SYSTEM_PROMPT}\n- The user also added these external MCP servers: ${names.join(', ')}. ` +
      'Their tools are allowed too, and every call into one is confirmed on the card first.'
    )
  }

  private ensureSession(): Promise<Result<DroidSessionLike>> {
    if (this.disposed) return Promise.resolve({ ok: false, error: 'Stopped' })
    if (!this.session) {
      const opening = this.openSession()
      this.session = opening
      void opening.then((opened) => {
        if (!opened.ok && this.session === opening) this.session = null
      })
    }
    return this.session
  }

  private async openSession(): Promise<Result<DroidSessionLike>> {
    const apiKey = this.deps.apiKey()
    if (!apiKey) return { ok: false, error: MISSING_KEY_ERROR, missingKey: 'FACTORY_API_KEY' }
    const execPath = await this.deps.droidPath()
    if (!execPath.ok) return execPath
    try {
      const session = await this.deps.openSession({
        apiKey,
        execPath: execPath.value,
        cwd: this.deps.cwd,
        systemPrompt: this.systemPrompt(),
        tools: this.droidTools,
        permissionHandler: (params) => this.onPermission(params),
        ...(this.deps.mcp && this.deps.mcp.servers.length ? { mcp: this.deps.mcp } : {})
      })
      return { ok: true, value: session }
    } catch (error) {
      return { ok: false, error: `Couldn't start the agent: ${errorText(error)}` }
    }
  }

  private async dropSession(): Promise<void> {
    const current = this.session
    this.session = null
    const opened = await current
    if (opened?.ok) await opened.value.close().catch(() => undefined)
  }
}
