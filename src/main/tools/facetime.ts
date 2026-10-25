import { z } from 'zod'
import { exec } from '../mac/exec'
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
    return {
      // FaceTime takes it from here: the text says the call was started, not that anyone answered.
      ok: true,
      text: `Opened FaceTime to start a ${kind} call to ${label} (${handle}).`,
      title: `Calling ${label}`,
      subtitle: kind,
      view: { kind: 'openApp', app: 'FaceTime' }
    }
  }
})
