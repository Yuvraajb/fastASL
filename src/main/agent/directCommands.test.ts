import { describe, expect, it } from 'vitest'
import { contactAliases, directCommand } from './directCommands'

const aliases = contactAliases({ FASTASL_CONTACT_ALIASES: 'friend=Yuvraaj SCU; Mom = Jane Doe,bad,=x' })

describe('contactAliases', () => {
  it('reads "sign=Full Name" pairs, lower-casing the sign and skipping broken ones', () => {
    expect([...aliases]).toEqual([
      ['friend', 'Yuvraaj SCU'],
      ['mom', 'Jane Doe']
    ])
    expect(contactAliases({}).size).toBe(0)
  })
})

describe('directCommand', () => {
  const call = (name: string) => ({ intent: `Call ${name}`, calls: [{ tool: 'facetime_call', args: { contact_name: name }, ok: true }] })

  it('CALL plus a nickname is a FaceTime call to that contact, in either order', () => {
    expect(directCommand('Call friend', aliases)).toEqual(call('Yuvraaj SCU'))
    expect(directCommand('friend call.', aliases)).toEqual(call('Yuvraaj SCU'))
    expect(directCommand('FaceTime mom', aliases)).toEqual(call('Jane Doe'))
  })

  it('anything else goes to the agent', () => {
    expect(directCommand('Call dad', aliases)).toBeNull()
    expect(directCommand('Email friend', aliases)).toBeNull()
    expect(directCommand('Call friend tomorrow', aliases)).toBeNull()
    expect(directCommand('friend', aliases)).toBeNull()
    expect(directCommand('Call friend', new Map())).toBeNull()
  })
})
