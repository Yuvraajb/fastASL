import { describe, expect, it } from 'vitest'
import { buildDroidTools, createFastaslServer } from './droidTools'
import { makeTools } from './testing/fakes'

describe('buildDroidTools', () => {
  const { tools, runs } = makeTools()
  const droidTools = buildDroidTools(tools, () => null)

  it('exposes every tool with readOnlyHint matching its risk', () => {
    expect(droidTools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
      ['take_screenshot', true],
      ['send_message', false],
      ['read_calendar', true]
    ])
    expect(Object.keys(droidTools[1].inputSchema ?? {})).toEqual(['to', 'text'])
  })

  it('refuses to run outside an active run', async () => {
    expect(await droidTools[0].handler({})).toEqual({ content: [{ type: 'text', text: 'Stopped by the user.' }], isError: true })
    expect(runs).toEqual([])
  })

  it('serves the tools from an MCP server named fastasl', () => {
    const server = createFastaslServer(droidTools)
    expect(server.name).toBe('fastasl')
    expect(server.tools).toBe(droidTools)
  })
})
