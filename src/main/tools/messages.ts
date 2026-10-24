import { z } from 'zod'
import { appleScriptString as q, runAppleScript } from '../mac/osascript'
import { findContact, messageHandle } from './contacts'
import { isEmail } from './mail'
import { defineTool } from './types'

/** A phone number typed as the recipient ("+1 555 123 4567"). */
const PHONE = /^\+?[\d\s().-]{7,}$/

export function sendMessageScript(handle: string, text: string): string {
  return `tell application "Messages"
\tset svc to missing value
\ttry
\t\tset svc to first account whose service type = iMessage
\tend try
\tif svc is missing value then error "Messages isn’t signed in to iMessage." number 9002
\tsend ${q(text)} to participant ${q(handle)} of svc
end tell
return "sent"`
}

async function resolveRecipient(name: string): Promise<{ label: string; handle: string }> {
  const trimmed = name.trim()
  if (isEmail(trimmed)) return { label: trimmed, handle: trimmed }
  if (PHONE.test(trimmed)) return { label: trimmed, handle: trimmed.replace(/[^\d+]/g, '') }
  const contact = await findContact(trimmed)
  const handle = messageHandle(contact)
  if (!handle) throw new Error(`${contact.name} has no phone number or email in Contacts`)
  return { label: contact.name, handle }
}

export const messageSend = defineTool({
  name: 'message_send',
  description:
    'Send an iMessage with the Messages app. contact_name is a phone number, an email, or the full name ' +
    'exactly as saved in Contacts (partial names are refused; use contacts_find to get the exact name).',
  schema: {
    contact_name: z.string().trim().min(1),
    text: z.string().min(1)
  },
  risk: 'write',
  stepLabel: (args) => `Messaging ${args.contact_name}`,
  confirmDetails: (args) => ({ kind: 'message', to: args.contact_name, text: args.text }),
  async run(args) {
    const { label, handle } = await resolveRecipient(args.contact_name)
    await runAppleScript(sendMessageScript(handle, args.text), { app: 'Messages', timeoutMs: 20_000 })
    return {
      ok: true,
      text: `Sent an iMessage to ${label} (${handle}).`,
      title: 'Message sent',
      subtitle: `to ${label}`
    }
  }
})
