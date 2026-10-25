import type { ChatEvent, Result } from '@shared/types'

/** What the chat needs from a model session, so tests can stand in a fake. */
export type ChatPiece =
  | { kind: 'delta'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'end'; ok: boolean; interrupted: boolean }

export interface ChatSessionLike {
  /** One turn of the conversation; aborting `signal` interrupts it. */
  stream(prompt: string, signal: AbortSignal): AsyncIterable<ChatPiece>
  close(): Promise<void>
}

export type ChatSessionFactory = (options: { apiKey: string; execPath: string; cwd: string }) => Promise<ChatSessionLike>

export interface ChatDeps {
  openSession: ChatSessionFactory
  apiKey(): string | undefined
  droidPath(): Promise<Result<string>>
  cwd: string
}

export const MISSING_KEY_ERROR = 'Add FACTORY_API_KEY to .env'

type Emit = (event: ChatEvent) => void

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Chat with a Factory Droid model, one persistent conversation. It is separate from the agent
 * (which drives the Mac): this session has no tools and every permission request is refused.
 * Replies stream to the renderer as `delta` events; only one turn runs at a time.
 */
export class ChatService {
  private session: Promise<Result<ChatSessionLike>> | null = null
  private queue: Promise<void> = Promise.resolve()
  private current: AbortController | null = null
  private disposed = false

  constructor(private readonly deps: ChatDeps) {}

  /** Opens the session in the background so the first reply isn't slowed by the droid start-up. */
  init(): void {
    void this.ensureSession().then((opened) => {
      if (!opened.ok) console.warn('[chat] session not started:', opened.error)
    })
  }

  /** Starts a turn. Always answers ok: progress and failures arrive as events tagged with `id`. */
  send(id: string, text: string, emit: Emit): Result<void> {
    const prompt = text.trim()
    if (!prompt) return { ok: false, error: 'Nothing to send' }
    this.queue = this.queue.then(() => this.turn(id, prompt, emit)).catch(() => undefined)
    return { ok: true, value: undefined }
  }

  /** Interrupts the reply being written, if any. */
  stop(): void {
    this.current?.abort()
  }

  /** Starts a new conversation. */
  async reset(): Promise<void> {
    this.stop()
    const opening = this.session
    this.session = null
    const opened = await opening
    if (opened?.ok) await opened.value.close().catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.reset()
  }

  private async turn(id: string, prompt: string, emit: Emit): Promise<void> {
    const opened = await this.ensureSession()
    if (!opened.ok) return emit({ type: 'error', id, message: opened.error })
    const controller = new AbortController()
    this.current = controller
    let failed: string | null = null
    try {
      for await (const piece of opened.value.stream(prompt, controller.signal)) {
        if (piece.kind === 'delta') emit({ type: 'delta', id, text: piece.text })
        else if (piece.kind === 'error') failed = piece.message
        else if (!piece.ok && !piece.interrupted) failed ??= 'The model could not answer'
      }
    } catch (e) {
      // An abort throws its reason; that is the user pressing stop, not a failure.
      if (!controller.signal.aborted) failed = errorText(e)
    } finally {
      if (this.current === controller) this.current = null
    }
    if (failed) emit({ type: 'error', id, message: failed })
    else emit({ type: 'done', id })
  }

  private ensureSession(): Promise<Result<ChatSessionLike>> {
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

  private async openSession(): Promise<Result<ChatSessionLike>> {
    const apiKey = this.deps.apiKey()
    if (!apiKey) return { ok: false, error: MISSING_KEY_ERROR, missingKey: 'FACTORY_API_KEY' }
    const execPath = await this.deps.droidPath()
    if (!execPath.ok) return execPath
    try {
      return { ok: true, value: await this.deps.openSession({ apiKey, execPath: execPath.value, cwd: this.deps.cwd }) }
    } catch (e) {
      return { ok: false, error: `Couldn't start the chat: ${errorText(e)}` }
    }
  }
}
