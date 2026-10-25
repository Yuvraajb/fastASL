import { z } from 'zod'
import { exec } from '../mac/exec'
import { runJxa } from '../mac/osascript'
import { truncate } from './format'
import { resolveRecipient } from './messages'
import { defineTool } from './types'

/** facetime:// (video) or facetime-audio:// link for a phone number or Apple ID email. */
export function faceTimeUrl(handle: string, audioOnly: boolean): string {
  const clean = handle.trim()
  if (!/^\+?\d{3,}$/.test(clean) && !/^[^\s@/?#]+@[^\s@/?#]+\.[^\s@/?#]+$/.test(clean)) {
    throw new Error(`Can't call "${handle}" with FaceTime`)
  }
  return `${audioOnly ? 'facetime-audio' : 'facetime'}://${clean}`
}

const callKind = (audioOnly: boolean): string => (audioOnly ? 'FaceTime audio' : 'FaceTime video')

/**
 * Presses FaceTime's Call button once the call sheet is up, so the user does not have to.
 * The default button is found by subrole, which is language independent; window 1 is the
 * call window that opening a facetime:// URL brings to the front. Returns "true" when it
 * found and clicked it, "false" when the sheet never appeared (the user can still press it).
 */
export function confirmCallJxa(): string {
  return String.raw`(() => {
  const se = Application('System Events');
  const p = se.processes.byName('FaceTime');
  // FaceTime's buttons carry an empty name and a localized description ("Call", "Appeler"...).
  const CALL = /\b(call|appeler|llamar|chiamare|anrufen|bellen)\b/i;
  const find = () => {
    try {
      const w = p.windows[0];
      if (!w) return null;
      for (const e of w.entireContents()) {
        try {
          if (e.role() !== 'AXButton') continue;
          const d = ((e.description() || '') + ' ' + (e.name() || '')).trim();
          if (CALL.test(d)) return e;
        } catch (x) {}
      }
    } catch (x) {}
    return null;
  };
  const deadline = Date.now() + 8000;
  let btn = find();
  while (!btn && Date.now() < deadline) { delay(0.25); btn = find(); }
  if (!btn) return 'false';
  btn.actions.byName('AXPress').perform();
  // The Call button is gone once the call is placed; if it stays, the press did not take.
  delay(1);
  return find() ? 'false' : 'true';
})()`
}

/**
 * Calls someone with FaceTime. A call reaches another person, so it is a write: the user
 * confirms it on a card first. Video is the default, so a signer can sign on the call.
 */
export const faceTimeCall = defineTool({
  name: 'facetime_call',
  description:
    'Call someone with FaceTime: video by default (the user can sign), or audio_only. contact_name is a phone ' +
    'number, an email, or the full name exactly as saved in Contacts (use contacts_find first for a partial name ' +
    'or a nickname like "Mom"). The only way to call or phone someone; the user confirms first.',
  schema: {
    contact_name: z.string().trim().min(1),
    audio_only: z.boolean().default(false)
  },
  risk: 'write',
  stepLabel: (args) => truncate(`Calling ${args.contact_name}`, 40),
  confirmDetails: (args) => ({
    kind: 'generic',
    title: `${callKind(args.audio_only)} call`,
    lines: [`To: ${args.contact_name}`]
  }),
  async run(args) {
    const { label, handle } = await resolveRecipient(args.contact_name)
    await exec('open', [faceTimeUrl(handle, args.audio_only)])
    const kind = callKind(args.audio_only)
    // The URL only opens FaceTime's call sheet; press Call for the user when Accessibility
    // allows it. A refusal (-1743) is not fatal: the call sheet is up either way.
    let called = false
    try {
      called = (await runJxa(confirmCallJxa(), { timeoutMs: 15_000 })) === 'true'
    } catch {
      called = false
    }
    return {
      // FaceTime takes it from here: the text says the call was started, not that anyone answered.
      ok: true,
      text: called
        ? `Started a ${kind} call to ${label} (${handle}).`
        : `Opened FaceTime to start a ${kind} call to ${label} (${handle}); press Call to connect.`,
      title: `Calling ${label}`,
      subtitle: kind,
      view: { kind: 'openApp', app: 'FaceTime' }
    }
  }
})
