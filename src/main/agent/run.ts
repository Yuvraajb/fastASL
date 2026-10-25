import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentResult, AgentStep, ConfirmDetails } from '@shared/types'
import type { RecordedCall, RunContext } from './types'

/**
 * State of one agent run or shortcut replay: its events, recorded calls,
 * pending confirmations and the approvals the user gave.
 */
export class Run implements RunContext {
  readonly runId = randomUUID()
  readonly calls: RecordedCall[] = []
  /**
   * External MCP tools the user approved on this run. Their calls happen inside droid, so they
   * never reach `calls`: without this the card said "didn't run any action" after Slack had
   * already posted.
   */
  readonly external: { tool: string; args: Record<string, unknown> }[] = []
  /** The last external lookup's output, for the card. */
  read: { tool: string; text: string } | null = null
  /** The user answered "no" on a Confirm card. */
  declined = false
  private isStopped = false
  private visible = false
  private planStepOpen = false
  private stepCount = 0
  /** Tool steps still running, and who waits for none to be (see idle()). */
  private running = 0
  private readonly idleWaiters: (() => void)[] = []
  private readonly approvals: string[] = []
  private readonly pending = new Map<string, (approved: boolean) => void>()

  constructor(
    readonly intent: string,
    private readonly sink: (event: AgentEvent) => void
  ) {}

  get stopped(): boolean {
    return this.isStopped
  }

  /** Emits 'started' once; until then the run is silent (compiled shortcuts stay silent unless they need a confirm). */
  announce(): void {
    if (this.visible) return
    this.visible = true
    this.emit({ type: 'started', runId: this.runId, intent: this.intent })
  }

  emit(event: AgentEvent): void {
    if (this.visible && !this.isStopped) this.sink(event)
  }

  /** A "Thinking" step shown until the first tool starts. */
  openPlanStep(): void {
    this.planStepOpen = true
    this.emitStep({ id: `${this.runId}:plan`, label: 'Thinking', status: 'current' })
  }

  beginStep(label: string): (status: 'done' | 'error') => void {
    if (this.planStepOpen) {
      this.planStepOpen = false
      this.emitStep({ id: `${this.runId}:plan`, label: 'Thinking', status: 'done' })
    }
    const id = `${this.runId}:${++this.stepCount}`
    this.emitStep({ id, label, status: 'current' })
    this.running++
    return (status) => {
      this.emitStep({ id, label, status })
      if (--this.running === 0) for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }

  /** Resolves once no tool step is running: a tool that has started can't be called back, even by stop(). */
  idle(): Promise<void> {
    return this.running === 0 ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private emitStep(step: AgentStep): void {
    this.emit({ type: 'step', runId: this.runId, step })
  }

  record(call: RecordedCall): void {
    this.calls.push(call)
  }

  /** Remember an approved external MCP call, so the result card can report it. */
  recordExternal(tool: string, args: Record<string, unknown>): void {
    this.external.push({ tool, args })
  }

  /** Remember what an external lookup returned, so the card can show it verbatim. */
  recordRead(tool: string, text: string): void {
    this.read = { tool, text }
  }

  /** One approval per confirmed call; the tool handler consumes it, so nothing runs unconfirmed. */
  approve(tool: string): void {
    this.approvals.push(tool)
  }

  takeApproval(tool: string): boolean {
    const index = this.approvals.indexOf(tool)
    if (index === -1) return false
    this.approvals.splice(index, 1)
    return true
  }

  /** Shows the Confirm card and waits for respond() or stop(). */
  confirm(tool: string, details: ConfirmDetails): Promise<boolean> {
    if (this.isStopped) return Promise.resolve(false)
    this.announce()
    const requestId = randomUUID()
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.emit({ type: 'confirm', runId: this.runId, requestId, tool, details })
    })
  }

  respond(requestId: string, approved: boolean): void {
    this.pending.get(requestId)?.(approved)
    this.pending.delete(requestId)
  }

  /** After stop() the one event still sent: Done for a write that had already gone through (see AgentService). */
  reportStopped(result: AgentResult): void {
    if (this.visible) this.sink({ type: 'done', runId: this.runId, result, complete: false })
  }

  /** Cancels pending confirmations and emits 'stopped' (unless the run was silent); later events are dropped. */
  stop(): void {
    if (this.isStopped) return
    for (const resolve of this.pending.values()) resolve(false)
    this.pending.clear()
    this.isStopped = true
    if (this.visible) this.sink({ type: 'stopped', runId: this.runId })
  }
}
