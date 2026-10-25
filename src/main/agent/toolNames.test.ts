import { describe, expect, it } from 'vitest'
import { ToolConfirmationType } from '@factory/droid-sdk/node'
import type { ToolConfirmationInfo } from '@factory/droid-sdk/node'
import { findFastaslTool, foreignToolIds, isToolCallScript, matchPermissionTool, scriptCalls } from './toolNames'
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

describe('isToolCallScript', () => {
  const names = ['send_message', 'calendar_create_event']

  it.each([
    'text(await tools.ToolSearch({query:"select:fastasl___calendar_create_event"}));\n',
    'text(await tools.fastasl.calendar_create_event({title:"Meeting",start_iso:"2026-10-24T13:00:00",end_iso:"2026-10-24T14:00:00"}));',
    'text(await tools.fastasl.send_message({ to: "Mom", text: "it\'s 5; call me" }))',
    'await tools.fastasl.calendar_create_event({ attendees: ["a@b.c"], notes: "", video_link: null })'
  ])('accepts %s', (script) => {
    expect(isToolCallScript(script, names)).toBe(true)
  })

  it.each([
    "require('fs').rmSync('/')",
    'await tools.fastasl.send_message({to:"a",text:"b"}); await fetch("http://evil")',
    'await tools.fastasl.send_message({to:"a",text:"b"}); process.exit()',
    'await tools.fastasl.send_message({}); require("child_process").exec("rm -rf ~")',
    'text(await tools.fastasl.send_message({to: `${secret}`}))',
    'await tools.fastasl.send_message({to: x => x})',
    'await tools.fastasl.send_message({to: a + b})',
    'await tools.Execute({command: "rm -rf ~"})',
    'await tools.fastasl.send_message({to: "unterminated})',
    'tools.constructor.constructor("return process")()'
  ])('rejects %s', (script) => {
    expect(isToolCallScript(script, names)).toBe(false)
  })
})

describe('scriptCalls', () => {
  const info = (script: string, calls: unknown[], type = 'script'): ToolConfirmationInfo =>
    ({
      toolUse: { type: 'tool_use', id: 'u', name: 'Script', input: { script } },
      confirmationType: type,
      details: { type, impactLevel: 'high', calls }
    }) as unknown as ToolConfirmationInfo
  const call = (toolName: string, toolInput: object, serverName = 'fastasl') => ({
    toolName,
    toolInput,
    confirmation: { type: 'mcp_tool', toolName, serverName }
  })

  it('is undefined for anything that is not a Script', () => {
    expect(scriptCalls(toolUse('send_message', {}), tools)).toBeUndefined()
  })

  it('lists the fastasl calls of a safe script, with their arguments', () => {
    const script = 'text(await tools.fastasl.send_message({to:"Mom",text:"hi"}))'
    const result = scriptCalls(info(script, [call('fastasl___send_message', { to: 'Mom', text: 'hi' })]), tools)
    expect(result).toEqual([{ def: tools[2], input: { to: 'Mom', text: 'hi' } }])
  })

  it('is an empty list for a script that only looks a tool up', () => {
    expect(scriptCalls(info('text(await tools.ToolSearch({query:"calendar"}))', []), tools)).toEqual([])
  })

  it('refuses a script with other code, another server, an unknown tool, or a non-script confirmation', () => {
    expect(scriptCalls(info('require("fs")', []), tools)).toBeNull()
    expect(scriptCalls(info('await tools.evil.send_message({})', [call('evil___send_message', {}, 'evil')]), tools)).toBeNull()
    expect(scriptCalls(info('await tools.fastasl.rm({})', [call('fastasl___rm', {})]), tools)).toBeNull()
    expect(scriptCalls(info('await tools.fastasl.send_message({})', [call('fastasl___send_message', {})], 'mcp_tool'), tools)).toBeNull()
  })
})

describe('foreignToolIds keeps the way to MCP tools', () => {
  it('never disables Script or ToolSearch', () => {
    const listed = [
      { id: 'Read', source: 'native' },
      { id: 'Script', source: 'native' },
      { id: 'ToolSearch', source: 'native' },
      ...tools.map((t) => ({ id: `fastasl___${t.name}`, source: 'mcp' }))
    ]
    expect(foreignToolIds(listed, tools).ids).toEqual(['Read'])
  })
})
