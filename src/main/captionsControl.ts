/**
 * Lets the agent's tools open and close the caption camera window (captionWindow.ts), which lives
 * in the app's main process and needs index.ts's renderer loader. index.ts sets it once at boot.
 */
export interface CaptionsControl {
  open(): void
  close(): void
}

let control: CaptionsControl | null = null

export function setCaptionsControl(next: CaptionsControl | null): void {
  control = next
}

export function getCaptionsControl(): CaptionsControl | null {
  return control
}
