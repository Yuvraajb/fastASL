import { basename } from 'node:path'
import { z } from 'zod'
import { AS_SEPARATORS, SEP, appleScriptString as q, runAppleScript, splitRecords } from '../mac/osascript'
import { findContact } from './contacts'
import { allowedFile } from './files'
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
  /** Real paths of files to attach (validated by the caller). */
  attachments?: string[]
}

/** Builds and sends a message in Mail (never shown on screen). Returns "true" when Mail accepts it. */
export function sendMailScript(mail: OutgoingMail): string {
  const recipients = mail.to.map(
    (address) => `\t\tmake new to recipient at end of to recipients with properties {address:${q(address)}}`
  )
  const attachments = (mail.attachments ?? []).flatMap((path) => [
    '\ttell content of msg',
    `\t\tmake new attachment with properties {file name:(POSIX file ${q(path)})} at after the last paragraph`,
    '\tend tell'
  ])
  return [
    'tell application "Mail"',
    '\tset msg to make new outgoing message with properties ' +
      `{subject:${q(mail.subject)}, content:${q(mail.body)}, visible:false}`,
    '\ttell msg',
    ...recipients,
    '\tend tell',
    ...attachments,
    // Mail attaches asynchronously: give it a moment before sending.
    ...(attachments.length ? ['\tdelay 2'] : []),
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
    'Needs an email address in Contacts; for someone with only a phone number, offer message_send instead. ' +
    '`attachments` are full file paths from files_find (Desktop, Downloads or Documents only).',
  schema: {
    to: z.string().trim().min(1),
    subject: z.string(),
    body: z.string(),
    attachments: z.array(z.string()).max(5).optional()
  },
  risk: 'write',
  stepLabel: () => 'Sending email',
  confirmDetails: (args) => ({
    kind: 'mail',
    to: args.to,
    subject: args.subject,
    body: args.body,
    ...(args.attachments?.length ? { attachments: args.attachments.map((p) => basename(p)) } : {})
  }),
  async run(args) {
    const to = await resolveAddresses(args.to)
    if (!to.length) return fail('Add at least one recipient')
    const attachments = await Promise.all((args.attachments ?? []).map(allowedFile))
    const sent = await runAppleScript(sendMailScript({ to, subject: args.subject, body: args.body, attachments }), {
      app: 'Mail',
      launch: true,
      timeoutMs: 30_000
    })
    if (sent !== 'true') return fail('Mail did not send the message. Check that a Mail account is set up.')
    const others = to.length > 1 ? ` +${to.length - 1}` : ''
    return {
      ok: true,
      text: `Sent "${args.subject}" to ${to.join(', ')}${attachments.length ? ` with ${attachments.map((p) => basename(p)).join(', ')} attached` : ''}.`,
      title: 'Email sent',
      subtitle: `to ${to[0]}${others}${attachments.length ? ` · ${attachments.length} attached` : ''}`
    }
  }
})

// ---------------------------------------------------------------------------
// Reading the inbox and replying: mail_list, mail_read, mail_reply.
// ---------------------------------------------------------------------------

export interface MailSummary {
  id: string
  sender: string
  subject: string
  date: string
  unread: boolean
}

export interface ReadMessage {
  subject: string
  sender: string
  date: string
  body: string
}

/** Mail ids are integers; anything else cannot address a message. */
export function isMessageId(id: string): boolean {
  return /^\d+$/.test(id.trim()) && Number(id) > 0
}

/** The newest `limit` inbox messages, one SEP.record per message. */
export function mailListScript(limit: number): string {
  const n = Math.max(1, Math.min(50, Math.trunc(limit)))
  return [
    AS_SEPARATORS,
    'tell application "Mail"',
    '\tset total to count of messages of inbox',
    `\tif total > ${n} then set total to ${n}`,
    '\tset out to ""',
    '\trepeat with i from 1 to total',
    '\t\tset m to message i of inbox',
    '\t\tset out to out & (id of m as text) & US & (sender of m) & US & (subject of m) & US & ' +
      '((date received of m) as text) & US & ((read status of m) as text) & RS',
    '\tend repeat',
    '\treturn out',
    'end tell'
  ].join('\n')
}

export function parseMailList(output: string): MailSummary[] {
  return splitRecords(output)
    .filter((fields) => fields.length >= 5 && fields[0].trim())
    .map(([id, sender, subject, date, read]) => ({
      id: id.trim(),
      sender: sender.trim(),
      subject: subject.trim(),
      date: date.trim(),
      unread: read.trim().toLowerCase() !== 'true'
    }))
}

/** One message: subject, sender, date, body. */
export function mailReadScript(id: string): string {
  return [
    AS_SEPARATORS,
    'tell application "Mail"',
    `\tset m to first message of inbox whose id is ${id.trim()}`,
    '\treturn (subject of m) & US & (sender of m) & US & ((date received of m) as text) & US & (content of m)',
    'end tell'
  ].join('\n')
}

export function parseMailMessage(output: string): ReadMessage | null {
  const fields = output.split(SEP.field)
  if (fields.length < 4) return null
  const [subject, sender, date, ...rest] = fields
  return {
    subject: subject.trim(),
    sender: sender.trim(),
    date: date.trim(),
    body: rest.join(SEP.field).trim()
  }
}

/** Replies to the message, writing `body` above the quoted original. */
export function replyMailScript(id: string, body: string): string {
  return [
    AS_SEPARATORS,
    'tell application "Mail"',
    `\tset m to first message of inbox whose id is ${id.trim()}`,
    '\tset r to reply m opening window false',
    '\tset original to content of r',
    `\tset content of r to ${q(body)} & return & return & original`,
    '\treturn (send r) as text',
    'end tell'
  ].join('\n')
}

/** Reading a body this long is enough for the model; the whole thread is not needed. */
const MAX_BODY = 1800

export const mailList = defineTool({
  name: 'mail_list',
  description:
    'List the most recent messages in the Mail inbox, newest first: id, sender, subject, date and whether ' +
    'it is unread. Pass an id to mail_read to read one, then mail_reply to answer it.',
  schema: {
    limit: z.number().int().min(1).max(25).default(10),
    unread_only: z.boolean().default(false)
  },
  risk: 'read',
  stepLabel: () => 'Checking email',
  async run(args) {
    const rows = parseMailList(
      await runAppleScript(mailListScript(args.limit), { app: 'Mail', launch: true, timeoutMs: 30_000 })
    )
    const shown = args.unread_only ? rows.filter((row) => row.unread) : rows
    if (!shown.length) {
      return {
        ok: true,
        text: args.unread_only ? 'No unread messages in the inbox.' : 'The inbox is empty.',
        title: 'No email',
        subtitle: args.unread_only ? 'nothing unread' : 'inbox empty'
      }
    }
    const lines = shown.map(
      (row) => `[${row.id}] ${row.sender} — "${row.subject}" (${row.date})${row.unread ? ' · unread' : ''}`
    )
    return {
      ok: true,
      text: `${shown.length} message(s), newest first:\n${lines.join('\n')}`,
      title: 'Checked email',
      subtitle: `${shown.length} message${shown.length === 1 ? '' : 's'}`
    }
  }
})

export const mailRead = defineTool({
  name: 'mail_read',
  description:
    'Read one inbox message by the id from mail_list: sender, subject, date and the body text ' +
    '(long bodies are truncated).',
  schema: { id: z.string().trim().min(1) },
  risk: 'read',
  stepLabel: () => 'Reading email',
  async run(args) {
    if (!isMessageId(args.id)) return fail('Use an id from mail_list (a number).')
    const message = parseMailMessage(
      await runAppleScript(mailReadScript(args.id), { app: 'Mail', launch: true, timeoutMs: 30_000 })
    )
    if (!message) return fail('Mail did not return that message. Use an id from mail_list.')
    const body = message.body.length > MAX_BODY ? `${message.body.slice(0, MAX_BODY)}…` : message.body
    return {
      ok: true,
      text: `From: ${message.sender}\nSubject: ${message.subject}\nDate: ${message.date}\n\n${body}`,
      title: 'Email opened',
      subtitle: message.subject
    }
  }
})

export const mailReply = defineTool({
  name: 'mail_reply',
  description:
    'Reply to an inbox message by its id from mail_list, quoting the original. Mail supplies the ' +
    'recipient and "Re:" subject. `body` is only the words to add, not the quoted text.',
  schema: {
    id: z.string().trim().min(1),
    body: z.string().trim().min(1)
  },
  risk: 'write',
  stepLabel: () => 'Replying to email',
  confirmDetails: (args) => ({
    kind: 'generic',
    title: 'Reply to email',
    lines: [`Message ${args.id}`, args.body.length > 280 ? `${args.body.slice(0, 280)}…` : args.body]
  }),
  async run(args) {
    if (!isMessageId(args.id)) return fail('Use an id from mail_list (a number).')
    const sent = await runAppleScript(replyMailScript(args.id, args.body), {
      app: 'Mail',
      launch: true,
      timeoutMs: 30_000
    })
    if (sent !== 'true') return fail('Mail did not send the reply. Check that a Mail account is set up.')
    return {
      ok: true,
      text: 'Replied to the message, quoted below your text.',
      title: 'Reply sent',
      subtitle: `message ${args.id}`
    }
  }
})
