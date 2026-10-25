import { z } from 'zod'
import { appleScriptString as q, runAppleScript } from '../mac/osascript'
import { findContact } from './contacts'
import { fail } from './outcome'
import { defineTool } from './types'

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/

export const isEmail = (value: string): boolean => EMAIL.test(value)

export function splitRecipients(to: string): string[] {
  return to
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface OutgoingMail {
  to: string[]
  subject: string
  body: string
}

/** Builds and sends a message in Mail (never shown on screen). Returns "true" when Mail accepts it. */
export function sendMailScript(mail: OutgoingMail): string {
  const recipients = mail.to.map(
    (address) => `\t\tmake new to recipient at end of to recipients with properties {address:${q(address)}}`
  )
  return [
    'tell application "Mail"',
    '\tset msg to make new outgoing message with properties ' +
      `{subject:${q(mail.subject)}, content:${q(mail.body)}, visible:false}`,
    '\ttell msg',
    ...recipients,
    '\tend tell',
    '\treturn (send msg) as text',
    'end tell'
  ].join('\n')
}

/** Email addresses pass through; names must exactly match a person in Contacts. */
async function resolveAddresses(to: string): Promise<string[]> {
  const addresses: string[] = []
  for (const entry of splitRecipients(to)) {
    if (isEmail(entry)) {
      addresses.push(entry)
      continue
    }
    const contact = await findContact(entry)
    const email = contact.emails[0]?.value
    if (!email) throw new Error(`${contact.name} has no email address in Contacts`)
    addresses.push(email)
  }
  return addresses
}

export const mailSend = defineTool({
  name: 'mail_send',
  description:
    'Send an email from the Mail app. `to` is one or more comma-separated email addresses or full names ' +
    'exactly as saved in Contacts (partial names are refused; use contacts_find to get the exact name). ' +
    'Needs an email address in Contacts; for someone with only a phone number, offer message_send instead.',
  schema: {
    to: z.string().trim().min(1),
    subject: z.string(),
    body: z.string()
  },
  risk: 'write',
  stepLabel: () => 'Sending email',
  confirmDetails: (args) => ({ kind: 'mail', to: args.to, subject: args.subject, body: args.body }),
  async run(args) {
    const to = await resolveAddresses(args.to)
    if (!to.length) return fail('Add at least one recipient')
    const sent = await runAppleScript(sendMailScript({ to, subject: args.subject, body: args.body }), {
      app: 'Mail',
      launch: true,
      timeoutMs: 30_000
    })
    if (sent !== 'true') return fail('Mail did not send the message. Check that a Mail account is set up.')
    const others = to.length > 1 ? ` +${to.length - 1}` : ''
    return {
      ok: true,
      text: `Sent "${args.subject}" to ${to.join(', ')}.`,
      title: 'Email sent',
      subtitle: `to ${to[0]}${others}`
    }
  }
})
