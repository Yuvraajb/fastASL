import { describe, expect, it } from 'vitest'
import { ToolConfirmationType } from '@factory/droid-sdk/node'
import { findFastaslTool, foreignToolIds, matchPermissionTool } from './toolNames'
import { toolUse } from './testing/fakes'

const tools = [{ name: 'screenshot' }, { name: 'take_screenshot' }, { name: 'send_message' }]

describe('findFastaslTool', () => {
  it.each([
    ['send_message', 'send_message'],
    ['mcp__fastasl__send_message', 'send_message'],
    ['fastasl___take_screenshot', 'take_screenshot'],
    ['fastasl:screenshot', 'screenshot']
  ])('maps %s to %s', (name, expected) => {
    expect(findFastaslTool(name, tools)?.name).toBe(expected)
  })

  it.each(['mcp__other__send_message', 'fastasl__resend_message', 'Execute', undefined])('rejects %s', (name) => {
    expect(findFastaslTool(name, tools)).toBeUndefined()
  })
})

describe('matchPermissionTool', () => {
  it('accepts fastasl MCP requests by tool name or actual tool name', () => {
    expect(matchPermissionTool(toolUse('send_message', {}), tools)?.name).toBe('send_message')
    const prefixed = toolUse('mcp__fastasl__send_message', {})
    const info = { ...prefixed, details: { ...prefixed.details, actualToolName: 'send_message' } }
    expect(matchPermissionTool(info, tools)?.name).toBe('send_message')
  })

  it('rejects other MCP servers and built-in tools', () => {
    expect(matchPermissionTool(toolUse('send_message', {}, 'evil'), tools)).toBeUndefined()
    const edit = {
      ...toolUse('Edit', {}),
      details: { type: ToolConfirmationType.Edit, filePath: '/etc/hosts', fileName: 'hosts' }
    } as const
    expect(matchPermissionTool(edit, tools)).toBeUndefined()
  })
})

describe('foreignToolIds', () => {
  const native = [
    { id: 'Read', source: 'native' },
    { id: 'Execute', source: 'native' }
  ]

  it('disables every built-in and other MCP tool once all fastasl tools are recognised', () => {
    const listed = [...native, ...tools.map((t) => ({ id: `mcp__fastasl__${t.name}`, source: 'mcp' })), { id: 'mcp__github__push', source: 'mcp' }]
    expect(foreignToolIds(listed, tools)).toEqual({ ids: ['Read', 'Execute', 'mcp__github__push'], sure: true })
  })

  it('disables only built-ins when the fastasl ids are in an unknown format', () => {
    const listed = [...native, ...tools.map((t) => ({ id: `${t.name}___fastasl`, source: 'mcp' })), { id: 'mcp__github__push' }]
    expect(foreignToolIds(listed, tools)).toEqual({ ids: ['Read', 'Execute'], sure: false })
  })
})
