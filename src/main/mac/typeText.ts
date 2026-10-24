import type { Result } from '@shared/types'
import { MacError, jsString, runJxa } from './osascript'

export interface SwapOptions {
  /** JXA expression for the pasteboard to use. */
  pasteboard?: string
  /** JXA run before the clipboard is touched (may block on a permission prompt). */
  prepare?: string
  /** JXA run while `text` is on the clipboard. */
  whileSet: string
}

const GENERAL_PASTEBOARD = '$.NSPasteboard.generalPasteboard'

// Sends an Apple event to System Events first, so a pending Automation prompt
// blocks (or times out) before the clipboard has been changed.
const SYSTEM_EVENTS_PREFLIGHT = "Application('System Events').uiElementsEnabled();"

// Modifiers still held (Ctrl+Opt of a hotkey that triggered the typing) would turn the paste
// into Cmd+Ctrl+Opt+V, which pastes nothing: wait up to 1 s for Shift, Ctrl, Opt and Cmd to go up.
const AWAIT_MODIFIERS_UP =
  'for (let i = 0; i < 20 && (Number($.NSEvent.modifierFlags) & 0x1e0000); i++) delay(0.05);'

/** The notice has two lines: the generic Automation message (osaError) runs past them. */
const AUTOMATION_DENIED = 'Turn on System Events for fastASL in Privacy & Security › Automation'

const KEYSTROKE_PASTE = "Application('System Events').keystroke('v', { using: 'command down' });\ndelay(0.3);"

/**
 * JXA that snapshots every pasteboard item and type (rich text, images, file
 * copies, app-private formats), puts `text` on the pasteboard, runs
 * `whileSet`, then restores the snapshot in a `finally`. The temporary text is
 * marked transient so clipboard managers skip it. If something else copies
 * while the text is on the pasteboard, that newer copy wins and is kept.
 */
export function clipboardSwapScript(
  text: string,
  { pasteboard = GENERAL_PASTEBOARD, prepare = '', whileSet }: SwapOptions
): string {
  return `ObjC.import('AppKit');
(() => {
  ${prepare}
  const pb = ${pasteboard};
  const saved = [];
  const items = pb.pasteboardItems;
  for (let i = 0; i < Number(items.count); i++) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const copy = $.NSPasteboardItem.alloc.init;
    let kept = 0;
    for (let j = 0; j < Number(types.count); j++) {
      const type = types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (!data.isNil()) { copy.setDataForType(data, type); kept++; }
    }
    if (kept) saved.push(copy);
  }
  pb.clearContents;
  pb.setStringForType(${jsString(text)}, $.NSPasteboardTypeString);
  pb.setDataForType($.NSData.data, 'org.nspasteboard.TransientType');
  const ours = Number(pb.changeCount);
  try {
    ${whileSet}
  } finally {
    if (Number(pb.changeCount) === ours) {
      pb.clearContents;
      if (saved.length) pb.writeObjects($(saved));
    }
  }
  return 'ok';
})();`
}

/** Pastes `text` into the focused app with Cmd+V via System Events. */
export function pasteScript(text: string): string {
  return clipboardSwapScript(text, {
    prepare: `${SYSTEM_EVENTS_PREFLIGHT}\n  ${AWAIT_MODIFIERS_UP}`,
    whileSet: KEYSTROKE_PASTE
  })
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Types `text` into the focused app by pasting it, leaving the user's
 * clipboard exactly as it was. Calls run one at a time, in order.
 */
export function typeText(text: string): Promise<Result<void>> {
  const run = queue.then(() => pasteOnce(text))
  queue = run
  return run
}

async function pasteOnce(text: string): Promise<Result<void>> {
  if (!text) return { ok: true, value: undefined }
  try {
    // Generous timeout: the preflight may wait on the user answering a permission prompt.
    await runJxa(pasteScript(text), { timeoutMs: 30_000, app: 'System Events' })
    return { ok: true, value: undefined }
  } catch (err) {
    // The paste sends Apple events to System Events only, so that is what Automation must allow.
    if (err instanceof MacError && err.kind === 'automation') return { ok: false, error: AUTOMATION_DENIED }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
