import { app } from 'electron'
import { z } from 'zod'
import { appPath } from '../mac/apps'
import { exec } from '../mac/exec'
import { AS_SEPARATORS, appleScriptString as q, runAppleScript, splitRecords } from '../mac/osascript'
import { plural, truncate } from './format'
import { fail } from './outcome'
import { createSpotifyClient, type SpotifyTrack } from './spotifyApi'
import type { ToolOutcome } from './types'
import { defineTool } from './types'

const SPOTIFY_BUNDLE_ID = 'com.spotify.client'
const spotify = createSpotifyClient({ market: () => app.getLocaleCountryCode() })

const URI = /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]+$/
const WEB_URL = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/i

/** Accepts a spotify: URI or an open.spotify.com link; null for anything else. */
export function toSpotifyUri(input: string): string | null {
  const value = input.trim()
  if (URI.test(value)) return value
  const web = WEB_URL.exec(value)
  return web ? `spotify:${web[1].toLowerCase()}:${web[2]}` : null
}

export function formatTrack(track: SpotifyTrack): string {
  return track.artists.length ? `${track.name} — ${track.artists.join(', ')}` : track.name
}

/**
 * Starts playback and waits (up to ~5s) until Spotify has really switched: a
 * track URI must become the current track; for an album, playlist, artist or
 * show the current track must change or restart. Returns the player state,
 * whether it switched, and what is actually playing.
 */
export function playScript(uri: string): string {
  const switched = uri.startsWith('spotify:track:')
    ? `(id of current track) is ${q(uri)}`
    : '(id of current track) is not beforeId or player position < beforePosition'
  return `${AS_SEPARATORS}
tell application "Spotify"
\tif not running then
\t\tlaunch
\t\tdelay 2
\tend if
\tset {beforeId, beforePosition} to {"", 0}
\ttry
\t\tset beforeId to id of current track
\t\tset beforePosition to player position
\tend try
\tplay track ${q(uri)}
\tset switched to false
\trepeat 50 times
\t\ttry
\t\t\tif player state is playing and (${switched}) then
\t\t\t\tset switched to true
\t\t\t\texit repeat
\t\t\tend if
\t\tend try
\t\tdelay 0.1
\tend repeat
\tset {trackName, trackArtist} to {"", ""}
\ttry
\t\tset trackName to name of current track
\t\tset trackArtist to artist of current track
\tend try
\treturn (player state as text) & US & (switched as text) & US & trackName & US & trackArtist
end tell`
}

/** Pauses only when Spotify is already running, so pausing never launches it. */
export const PAUSE_SCRIPT = `${AS_SEPARATORS}
if application "Spotify" is not running then return "not running"
tell application "Spotify"
\tpause
\tset trackName to ""
\ttry
\t\tset trackName to name of current track
\tend try
\treturn (player state as text) & US & trackName
end tell`

/** Spotify's terminology only compiles when the app exists, so check first. */
async function requireSpotify(): Promise<void> {
  if (!(await appPath(SPOTIFY_BUNDLE_ID))) throw new Error("Spotify isn't installed")
}

/** Spotify's own search page for `query` (the desktop app handles spotify: links). */
export function spotifySearchUri(query: string): string {
  return `spotify:search:${encodeURIComponent(query.trim())}`
}

/**
 * Without API keys no track can be picked, so Spotify's own search page is opened for the user
 * to pick from. Playing a `spotify:search:` URI directly doesn't work: on a real Mac it left
 * Spotify stopped with no current track.
 */
async function openSearchPage(query: string, keyError: string): Promise<ToolOutcome> {
  await exec('open', [spotifySearchUri(query)])
  return {
    ok: true,
    text:
      `Spotify search needs API keys (${keyError}), so no song could be picked automatically. ` +
      `Opened Spotify's search page for "${query}" instead; the user can pick a song there. Do not call spotify_play.`,
    title: 'Opened Spotify search',
    subtitle: truncate(query, 60),
    view: { kind: 'openApp', app: 'Spotify' }
  }
}

export const spotifySearch = defineTool({
  name: 'spotify_search',
  description:
    'Search Spotify for a song, artist or album. Returns up to 5 tracks with their spotify:track URIs for spotify_play. ' +
    "Without Spotify API keys it opens Spotify's search page instead, for the user to pick from.",
  schema: { query: z.string().trim().min(1) },
  risk: 'read',
  stepLabel: () => 'Searching Spotify',
  async run(args) {
    const result = await spotify.search(args.query)
    if (!result.ok) {
      if (result.missingKey && (await appPath(SPOTIFY_BUNDLE_ID))) return openSearchPage(args.query, result.error)
      return fail(result.error)
    }
    const tracks = result.value
    if (!tracks.length) {
      return { ok: true, text: `No Spotify tracks match "${args.query}".`, title: 'No songs found', subtitle: args.query }
    }
    const lines = tracks.map((t, i) => `${i + 1}. ${formatTrack(t)}${t.album ? ` (${t.album})` : ''} — ${t.uri}`)
    return {
      ok: true,
      text: `${plural(tracks.length, 'track')} on Spotify:\n${lines.join('\n')}`,
      title: `Found “${truncate(tracks[0].name, 40)}”`,
      subtitle: truncate(tracks[0].artists.join(', ') || tracks[0].album, 60)
    }
  }
})

export const spotifyPlay = defineTool({
  name: 'spotify_play',
  description:
    'Play a track, album or playlist in the Spotify desktop app. Pass the spotify: URI from spotify_search; ' +
    'name is only used for the status line. Fails if Spotify does not actually switch to it.',
  schema: {
    uri: z.string().trim().min(1).describe('spotify:track:… URI or open.spotify.com link'),
    name: z.string().optional().describe('Track or playlist name, for the status line')
  },
  risk: 'read',
  stepLabel: (args) => truncate(args.name ? `Playing ${args.name}` : 'Starting Spotify', 40),
  async run(args) {
    const uri = toSpotifyUri(args.uri)
    if (!uri) return fail(`"${args.uri}" is not a Spotify URI. Use spotify_search to find one.`)
    await requireSpotify()
    const [fields = []] = splitRecords(await runAppleScript(playScript(uri), { app: 'Spotify', timeoutMs: 20_000 }))
    const [state = '', switched = '', name = '', artist = ''] = fields
    if (state !== 'playing') return fail('Spotify did not start playing. Make sure you are signed in to Spotify.')
    if (switched !== 'true') {
      const requested = args.name ? `“${args.name}”` : `that ${uri.split(':')[1]}`
      return fail(
        `Spotify didn't switch to ${requested}${name ? ` and is still playing ${name}` : ''}. ` +
          'It may not be available in your country.'
      )
    }
    return {
      ok: true,
      text: name ? `Now playing ${name}${artist ? ` by ${artist}` : ''}.` : 'Spotify is playing.',
      title: name ? `Playing ${truncate(name, 40)}` : 'Playing on Spotify',
      subtitle: artist ? truncate(artist, 60) : 'Spotify',
      view: { kind: 'openApp', app: 'Spotify' }
    }
  }
})

export const spotifyPause = defineTool({
  name: 'spotify_pause',
  description: 'Pause Spotify playback.',
  schema: {},
  risk: 'read',
  stepLabel: () => 'Pausing Spotify',
  async run() {
    await requireSpotify()
    const output = await runAppleScript(PAUSE_SCRIPT, { app: 'Spotify', timeoutMs: 10_000 })
    if (output === 'not running') {
      return {
        ok: true,
        text: 'Spotify is not running, so nothing is playing.',
        title: 'Nothing playing',
        subtitle: 'Spotify is closed'
      }
    }
    const [[state = '', name = ''] = []] = splitRecords(output)
    if (state === 'playing') return fail('Spotify kept playing')
    return {
      ok: true,
      text: name ? `Paused ${name}.` : 'Spotify is paused.',
      title: 'Paused Spotify',
      subtitle: name ? truncate(name, 60) : 'Spotify'
    }
  }
})
