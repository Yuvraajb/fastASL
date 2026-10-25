import { describe, expect, it } from 'vitest'
import { ToolConfirmationType } from '@factory/droid-sdk/node'
import { findFastaslTool, foreignToolIds, matchPermissionTool, mcpToolAllowed, mcpToolWrites } from './toolNames'
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

describe('mcpToolAllowed', () => {
  it('keeps ids that name an opted-in server, or are that server', () => {
    for (const id of ['notion', 'mcp__notion__search', 'notion___search', 'notion/search', 'tools.notion.search']) {
      expect(mcpToolAllowed(id, ['notion']), id).toBe(true)
    }
  })

  it('does not keep other servers, ours, or nothing at all', () => {
    expect(mcpToolAllowed('mcp__github__issues', ['notion'])).toBe(false)
    expect(mcpToolAllowed('open_app', [])).toBe(false)
    expect(mcpToolAllowed(undefined, ['notion'])).toBe(false)
  })

  it('lets opted-in server tools through foreignToolIds, and only those', () => {
    const listed = [
      { id: 'open_app', source: 'mcp' },
      { id: 'mcp__notion__search', source: 'mcp' },
      { id: 'mcp__github__issues', source: 'mcp' },
      { id: 'Execute', source: 'native' }
    ]
    const { ids } = foreignToolIds(listed, [{ name: 'open_app' }], ['notion'])
    expect(ids).toEqual(['mcp__github__issues', 'Execute'])
  })
})

describe('mcpToolWrites', () => {
  it('treats lookups as reads', () => {
    for (const id of [
      'slack___slack_get_channel_history',
      'slack___slack_list_channels',
      'filesystem___read_file',
      'memory___read_graph',
      'fetch___fetch_url'
    ])
      expect(mcpToolWrites(id), id).toBe(false)
  })

  it('confirms anything that could change something, including replying', () => {
    // "reply" was missing from the old deny-list, so this posted with no card and was never recorded.
    for (const id of [
      'slack___slack_reply_to_thread',
      'slack___slack_post_message',
      'slack___slack_add_reaction',
      'filesystem___write_file',
      'memory___create_entities',
      'unknown___do_something'
    ])
      expect(mcpToolWrites(id), id).toBe(true)
  })
})
