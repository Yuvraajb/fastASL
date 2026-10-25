import type { ZodRawShape, z } from 'zod'
import type { ConfirmDetails, ViewAction } from '@shared/types'

/**
 * What a tool implementation returns. `text` goes back to the model; `title` /
 * `subtitle` (when present) are what the result card shows, so the card is always
 * built from real tool results and never from the model's own claim.
 */
export interface ToolOutcome {
  ok: boolean
  text: string
  title?: string
  subtitle?: string
  view?: ViewAction
}

/**
 * A Mac automation tool exposed to the agent. `risk` decides the permission flow:
 * 'write' (sends / creates / deletes / invites) -> Confirm card (thumbs up / fist);
 * 'read' (read-only, open, play, pause, screenshot) -> auto-approved.
 */
export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  schema: S
  risk: 'read' | 'write'
  /** Short present-tense step label for the Working card, e.g. "Creating event". */
  stepLabel(args: z.infer<z.ZodObject<S>>): string
  /** Details card for the Confirm state (write tools only). */
  confirmDetails?(args: z.infer<z.ZodObject<S>>): ConfirmDetails
  run(args: z.infer<z.ZodObject<S>>): Promise<ToolOutcome>
}

/** Helper that keeps the generic inference when declaring tools. */
export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}
