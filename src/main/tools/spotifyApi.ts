import type { EnvKey, Result } from '@shared/types'
import { getKey as envKey, missingKeyMessage } from '../env'

export interface SpotifyTrack {
  name: string
  artists: string[]
  album: string
  uri: string
  durationMs: number
}

const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SEARCH_URL = 'https://api.spotify.com/v1/search'
/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_MARGIN_MS = 60_000

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface SpotifyDeps {
  getKey?: (key: EnvKey) => string | undefined
  fetch?: Fetch
  now?: () => number
  /** The user's country code; Spotify then only returns tracks playable there. */
  market?: () => string | undefined
}

/** Defensive parse of a /v1/search?type=track response. */
export function parseTracks(json: unknown): SpotifyTrack[] {
  const items = (json as { tracks?: { items?: unknown } } | null)?.tracks?.items
  if (!Array.isArray(items)) return []
  return items.flatMap((raw) => {
    const item = raw as {
      name?: unknown
      uri?: unknown
      duration_ms?: unknown
      is_playable?: unknown
      album?: { name?: unknown }
      artists?: { name?: unknown }[]
    } | null
    if (!item || typeof item.name !== 'string' || typeof item.uri !== 'string') return []
    if (item.is_playable === false) return [] // only reported when a market is given
    return [
      {
        name: item.name,
        uri: item.uri,
        album: typeof item.album?.name === 'string' ? item.album.name : '',
        artists: Array.isArray(item.artists)
          ? item.artists.flatMap((a) => (typeof a?.name === 'string' ? [a.name] : []))
          : [],
        durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : 0
      }
    ]
  })
}

const missing = (key: EnvKey): Result<never> => ({ ok: false, error: missingKeyMessage(key), missingKey: key })

/**
 * Spotify Web API client using the client-credentials flow (no user login;
 * enough for search). The token is cached until shortly before it expires and
 * concurrent callers share one token request.
 */
export function createSpotifyClient({
  getKey = envKey,
  fetch: fetchImpl = fetch,
  now = Date.now,
  market = () => undefined
}: SpotifyDeps = {}) {
  let token: { value: string; expiresAt: number } | null = null
  let pending: Promise<Result<string>> | null = null

  async function requestToken(): Promise<Result<string>> {
    const id = getKey('SPOTIFY_CLIENT_ID')
    if (!id) return missing('SPOTIFY_CLIENT_ID')
    const secret = getKey('SPOTIFY_CLIENT_SECRET')
    if (!secret) return missing('SPOTIFY_CLIENT_SECRET')

    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    })
    if (res.status === 400 || res.status === 401) {
      return { ok: false, error: 'Spotify rejected SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET' }
    }
    if (!res.ok) return { ok: false, error: `Spotify sign-in failed (HTTP ${res.status})` }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string') return { ok: false, error: 'Spotify sign-in returned no token' }
    const lifetimeMs = (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000
    token = { value: body.access_token, expiresAt: now() + lifetimeMs - EXPIRY_MARGIN_MS }
    return { ok: true, value: token.value }
  }

  function accessToken(): Promise<Result<string>> {
    if (token && now() < token.expiresAt) return Promise.resolve({ ok: true, value: token.value })
    pending ??= requestToken().finally(() => {
      pending = null
    })
    return pending
  }

  async function searchOnce(query: string, limit: number): Promise<Result<SpotifyTrack[]> | 'retry'> {
    const auth = await accessToken()
    if (!auth.ok) return auth
    const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit) })
    const country = market()
    if (country && /^[A-Z]{2}$/.test(country)) params.set('market', country)
    const res = await fetchImpl(`${SEARCH_URL}?${params}`, { headers: { Authorization: `Bearer ${auth.value}` } })
    if (res.status === 401) {
      token = null
      return 'retry'
    }
    if (res.status === 429) return { ok: false, error: 'Spotify is busy; try again in a moment' }
    if (!res.ok) return { ok: false, error: `Spotify search failed (HTTP ${res.status})` }
    return { ok: true, value: parseTracks(await res.json()) }
  }

  return {
    /** Track search. A rejected (revoked) token is refreshed once. */
    async search(query: string, limit = 5): Promise<Result<SpotifyTrack[]>> {
      try {
        const first = await searchOnce(query, limit)
        if (first !== 'retry') return first
        const second = await searchOnce(query, limit)
        return second === 'retry' ? { ok: false, error: 'Spotify rejected the access token' } : second
      } catch {
        return { ok: false, error: "Couldn't reach Spotify. Check your internet connection." }
      }
    }
  }
}

export type SpotifyClient = ReturnType<typeof createSpotifyClient>
