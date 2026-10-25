import { describe, expect, it } from 'vitest'
import { expandEnv, mcpConfigPath, mcpServer, parseMcpConfig } from './mcpConfig'

describe('external MCP config', () => {
  it('reads a stdio server', () => {
    const cfg = parseMcpConfig(
      JSON.stringify({
        servers: [{ name: 'files', command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { TOKEN: 'x' } }]
      })
    )
    expect(cfg.names).toEqual(['files'])
    expect(cfg.error).toBeUndefined()
    expect(cfg.servers[0]).toEqual({
      name: 'files',
      command: 'npx',
      args: ['-y', 'server-filesystem', '/tmp'],
      env: { TOKEN: 'x' }
    })
  })

  it('reads an http server with headers, and an sse one', () => {
    const cfg = parseMcpConfig(
      JSON.stringify({
        servers: [
          { name: 'notion', url: 'https://mcp.notion.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
          { name: 'legacy', url: 'https://old.example.com/sse', type: 'sse' }
        ]
      })
    )
    expect(cfg.servers).toEqual([
      { name: 'notion', type: 'http', url: 'https://mcp.notion.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
      { name: 'legacy', type: 'sse', url: 'https://old.example.com/sse' }
    ])
  })

  it('skips unusable entries but keeps the rest', () => {
    const cfg = parseMcpConfig(
      JSON.stringify({
        servers: [
          { name: 'good', command: 'x' },
          { name: 'no-command' },
          { name: 'has space', command: 'x' },
          { url: 'https://nope.example.com' },
          'nonsense'
        ]
      })
    )
    expect(cfg.names).toEqual(['good'])
  })

  it('reports why a config could not be used', () => {
    expect(parseMcpConfig('not json').error).toBe('not valid JSON')
    expect(parseMcpConfig('{}').error).toContain('servers')
    expect(parseMcpConfig('{"servers":[{"name":"x"}]}').error).toContain('no usable server')
    expect(parseMcpConfig('{"servers":[]}')).toEqual({ servers: [], names: [] })
  })

  it('refuses entries that are not an object', () => {
    expect(mcpServer(null)).toBeUndefined()
    expect(mcpServer('x')).toBeUndefined()
    expect(mcpServer({ name: 'ok', url: 'https://a.b' })).toBeDefined()
  })

  it('resolves the config path from the data dir, unless one is configured', () => {
    expect(mcpConfigPath('/data', undefined)).toBe('/data/mcp.json')
    expect(mcpConfigPath('/data', '  ')).toBe('/data/mcp.json')
    expect(mcpConfigPath('/data', '/tmp/custom.json')).toBe('/tmp/custom.json')
  })
})

describe('${VAR} expansion', () => {
  it('reads secrets from the environment instead of the config file', () => {
    process.env.TEST_SLACK_TOKEN = 'xoxb-secret'
    const cfg = parseMcpConfig(
      JSON.stringify({
        servers: [
          {
            name: 'slack',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-slack'],
            env: { SLACK_BOT_TOKEN: '${TEST_SLACK_TOKEN}', SLACK_TEAM_ID: 'T123' }
          }
        ]
      })
    )
    expect((cfg.servers[0] as { env: Record<string, string> }).env).toEqual({
      SLACK_BOT_TOKEN: 'xoxb-secret',
      SLACK_TEAM_ID: 'T123'
    })
    delete process.env.TEST_SLACK_TOKEN
  })

  it('leaves unknown names empty rather than failing', () => {
    expect(parseMcpConfig('{"servers":[{"name":"x","command":"c","env":{"K":"${NOT_SET_ANYWHERE}"}}]}')).toBeTruthy()
    expect(expandEnv('${NOT_SET_ANYWHERE}')).toBe('')
  })
})
