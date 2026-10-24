import { describe, expect, it, vi } from 'vitest'
import type { EnvKey } from '@shared/types'
import { SEP, runAppleScript } from '../mac/osascript'
import { PAUSE_SCRIPT, formatTrack, playScript, spotifyPlay, toSpotifyUri } from './spotify'
import { createSpotifyClient, parseTracks } from './spotifyApi'

vi.mock('electron', () => ({ app: {}, shell: {} }))
vi.mock('../mac/apps', () => ({ appPath: vi.fn(async () => '/Applications/Spotify.app') }))
// Nothing is ever played: every AppleScript call is answered by this mock.
vi.mock('../mac/osascript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac/osascript')>()),
  runAppleScript: vi.fn()
}))

const SEARCH_BODY = {
  tracks: {
    items: [
      {
        name: 'Motion Sickness',
        uri: 'spotify:track:5xo8RrjJ9CVNrtRg2S3B1R',
        duration_ms: 229_000,
        album: { name: 'Stranger in the Alps' },
        artists: [{ name: 'Phoebe Bridgers' }]
      },
      { name: 'Broken item without uri' },
      null
    ]
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function setup(
  keys: Partial<Record<EnvKey, string>> = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
  market?: string
) {
  let clock = 1_000_000
  const fetch = vi.fn(async (url: string) =>
    url.includes('/api/token') ? json(200, { access_token: `tok-${clock}`, expires_in: 3600 }) : json(200, SEARCH_BODY)
  )
  const client = createSpotifyClient({ getKey: (k) => keys[k], fetch, now: () => clock, market: () => market })
  const tokenCalls = (): number => fetch.mock.calls.filter(([url]) => url.includes('/api/token')).length
  return { client, fetch, tokenCalls, advance: (ms: number) => (clock += ms) }
}

describe('parseTracks', () => {
  it('keeps well-formed, playable tracks only', () => {
    expect(parseTracks(SEARCH_BODY)).toEqual([
      {
        name: 'Motion Sickness',
        uri: 'spotify:track:5xo8RrjJ9CVNrtRg2S3B1R',
        durationMs: 229_000,
        album: 'Stranger in the Alps',
        artists: ['Phoebe Bridgers']
      }
    ])
    expect(parseTracks({ tracks: { items: [{ ...SEARCH_BODY.tracks.items[0], is_playable: false }] } })).toEqual([])
    expect(parseTracks(null)).toEqual([])
    expect(parseTracks({ tracks: { items: 'nope' } })).toEqual([])
  })
})

describe('Spotify client', () => {
  it('asks for missing keys by name, without calling the network', async () => {
    const noId = setup({})
    expect(await noId.client.search('x')).toEqual({
      ok: false,
      error: 'Add SPOTIFY_CLIENT_ID to .env',
      missingKey: 'SPOTIFY_CLIENT_ID'
    })
    expect(noId.fetch).not.toHaveBeenCalled()
    const noSecret = setup({ SPOTIFY_CLIENT_ID: 'id' })
    expect(await noSecret.client.search('x')).toMatchObject({ error: 'Add SPOTIFY_CLIENT_SECRET to .env' })
  })

  it('sends client credentials and the query', async () => {
    const { client, fetch } = setup()
    await client.search('motion sickness')
    const [tokenUrl, tokenInit] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(tokenUrl).toBe('https://accounts.spotify.com/api/token')
    expect((tokenInit.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`)
    expect(tokenInit.body).toBe('grant_type=client_credentials')
    const [searchUrl, searchInit] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(searchUrl).toBe('https://api.spotify.com/v1/search?q=motion+sickness&type=track&limit=5')
    expect((searchInit.headers as Record<string, string>).Authorization).toBe('Bearer tok-1000000')
  })

  it("searches the user's market when it is a valid country code", async () => {
    const us = setup(undefined, 'US')
    await us.client.search('x')
    expect(us.fetch.mock.calls[1][0]).toBe('https://api.spotify.com/v1/search?q=x&type=track&limit=5&market=US')
    const unknown = setup(undefined, '')
    await unknown.client.search('x')
    expect(unknown.fetch.mock.calls[1][0]).not.toContain('market')
  })

  it('caches the token until shortly before it expires', async () => {
    const { client, tokenCalls, advance } = setup()
    await client.search('a')
    advance(30 * 60_000)
    await client.search('b')
    expect(tokenCalls()).toBe(1)
    advance(29.5 * 60_000) // inside the final minute of the hour-long token
    await client.search('c')
    expect(tokenCalls()).toBe(2)
  })

  it('shares one token request between concurrent searches', async () => {
    const { client, tokenCalls } = setup()
    await Promise.all([client.search('a'), client.search('b'), client.search('c')])
    expect(tokenCalls()).toBe(1)
  })

  it('refreshes a revoked token once', async () => {
    const { client, fetch, tokenCalls } = setup()
    let searches = 0
    fetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/token')) return json(200, { access_token: 't', expires_in: 3600 })
      return ++searches === 1 ? json(401, {}) : json(200, SEARCH_BODY)
    })
    const result = await client.search('x')
    expect(result.ok && result.value[0].name).toBe('Motion Sickness')
    expect(tokenCalls()).toBe(2)
  })

  it('reports bad credentials, rate limits and network failures', async () => {
    const bad = setup()
    bad.fetch.mockResolvedValue(json(400, { error: 'invalid_client' }))
    expect(await bad.client.search('x')).toMatchObject({ error: 'Spotify rejected SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET' })

    const limited = setup()
    limited.fetch.mockImplementation(async (url: string) =>
      url.includes('/api/token') ? json(200, { access_token: 't', expires_in: 3600 }) : json(429, {})
    )
    expect(await limited.client.search('x')).toMatchObject({ error: 'Spotify is busy; try again in a moment' })

    const offline = setup()
    offline.fetch.mockRejectedValue(new TypeError('fetch failed'))
    expect(await offline.client.search('x')).toMatchObject({ error: "Couldn't reach Spotify. Check your internet connection." })
  })
})

describe('Spotify app scripts', () => {
  it('normalizes URIs and open.spotify.com links', () => {
    expect(toSpotifyUri(' spotify:track:5xo8RrjJ9CVNrtRg2S3B1R ')).toBe('spotify:track:5xo8RrjJ9CVNrtRg2S3B1R')
    expect(toSpotifyUri('https://open.spotify.com/intl-de/track/5xo8RrjJ9CVNrtRg2S3B1R?si=abc')).toBe(
      'spotify:track:5xo8RrjJ9CVNrtRg2S3B1R'
    )
    expect(toSpotifyUri('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe(
      'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'
    )
    expect(toSpotifyUri('Motion Sickness')).toBeNull()
    expect(toSpotifyUri('spotify:track:abc" & quit & "')).toBeNull()
  })

  it('waits until the requested track is current, or a context has switched tracks', () => {
    const track = playScript('spotify:track:5xo8RrjJ9CVNrtRg2S3B1R')
    expect(track).toContain('set beforeId to id of current track')
    expect(track).toContain('play track "spotify:track:5xo8RrjJ9CVNrtRg2S3B1R"')
    expect(track).toContain(
      'if player state is playing and ((id of current track) is "spotify:track:5xo8RrjJ9CVNrtRg2S3B1R") then'
    )
    expect(track).toContain('return (player state as text) & US & (switched as text) & US & trackName & US & trackArtist')
    expect(track.indexOf('set beforeId')).toBeLessThan(track.indexOf('play track'))
    expect(playScript('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toContain(
      'if player state is playing and ((id of current track) is not beforeId or player position < beforePosition) then'
    )
  })

  it('never launches Spotify just to pause it', () => {
    expect(PAUSE_SCRIPT.indexOf('is not running then return')).toBeLessThan(PAUSE_SCRIPT.indexOf('tell application "Spotify"'))
  })

  it('formats tracks for the model', () => {
    expect(formatTrack(parseTracks(SEARCH_BODY)[0])).toBe('Motion Sickness — Phoebe Bridgers')
  })
})

describe('spotify_play run', () => {
  const runMock = vi.mocked(runAppleScript)
  const reply = (...fields: string[]): void => {
    runMock.mockResolvedValueOnce(fields.join(SEP.field))
  }
  const args = { uri: 'spotify:track:5xo8RrjJ9CVNrtRg2S3B1R', name: 'Motion Sickness' }

  it('reports what Spotify actually switched to', async () => {
    reply('playing', 'true', 'Motion Sickness', 'Phoebe Bridgers')
    expect(await spotifyPlay.run(args)).toEqual({
      ok: true,
      text: 'Now playing Motion Sickness by Phoebe Bridgers.',
      title: 'Playing Motion Sickness',
      subtitle: 'Phoebe Bridgers',
      view: { kind: 'openApp', app: 'Spotify' }
    })
  })

  it('fails when the previous song is still playing', async () => {
    reply('playing', 'false', 'Song A', 'Someone')
    expect(await spotifyPlay.run(args)).toEqual({
      ok: false,
      text: "Spotify didn't switch to “Motion Sickness” and is still playing Song A. It may not be available in your country."
    })
    reply('playing', 'false', '', '')
    expect((await spotifyPlay.run({ uri: 'spotify:album:1xJHno7SmdVtZAtXbdbDZp' })).text).toBe(
      "Spotify didn't switch to that album. It may not be available in your country."
    )
  })

  it('fails when nothing is playing', async () => {
    reply('paused', 'false', 'Song A', 'Someone')
    expect((await spotifyPlay.run(args)).text).toBe('Spotify did not start playing. Make sure you are signed in to Spotify.')
  })
})
