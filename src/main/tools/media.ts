import { z } from 'zod'
import { appPath } from '../mac/apps'
import { AS_SEPARATORS, runAppleScript, splitRecords } from '../mac/osascript'
import { truncate } from './format'
import { fail } from './outcome'
import type { ToolOutcome } from './types'
import { defineTool } from './types'

export type MediaAction = 'play' | 'pause' | 'next' | 'previous'
export type Player = 'Spotify' | 'Music'

const BUNDLE_IDS: Record<Player, string> = { Spotify: 'com.spotify.client', Music: 'com.apple.Music' }

const COMMAND: Record<MediaAction, string> = {
  play: 'play',
  pause: 'pause',
  next: 'next track',
  previous: 'previous track'
}

/** What "it worked" looks like, checked for up to ~3 s after the command. */
const SETTLED: Record<MediaAction, string> = {
  play: 'player state is playing',
  pause: 'player state is not playing',
  next: '(name of current track) is not beforeName',
  previous: 'player state is playing'
}

/**
 * Sends one transport command to the right player, then reports what it is doing.
 * Target: the player that is playing; else one that is open; else, for play only, the first
 * installed player is launched (Spotify resumes what it last played). Pause, next and previous
 * never launch an app. `players` lists the installed players in preference order, and only
 * their blocks are generated: an app's terminology only compiles when the app is installed.
 */
export function mediaScript(action: MediaAction, players: readonly Player[]): string {
  const lines = [AS_SEPARATORS, 'set target to ""']
  for (const p of players) {
    lines.push(
      `if target is "" and application "${p}" is running then`,
      `\ttell application "${p}"`,
      `\t\tif player state is playing then set target to "${p}"`,
      '\tend tell',
      'end if'
    )
  }
  for (const p of players) lines.push(`if target is "" and application "${p}" is running then set target to "${p}"`)
  if (action === 'play' && players.length) lines.push(`if target is "" then set target to "${players[0]}"`)
  lines.push('if target is "" then return "none"')
  for (const p of players) {
    lines.push(
      `if target is "${p}" then`,
      `\ttell application "${p}"`,
      '\t\tif not running then',
      '\t\t\tlaunch',
      '\t\t\tdelay 2',
      '\t\tend if',
      '\t\tset beforeName to ""',
      '\t\ttry',
      '\t\t\tset beforeName to name of current track',
      '\t\tend try',
      `\t\t${COMMAND[action]}`,
      '\t\trepeat 30 times',
      '\t\t\ttry',
      `\t\t\t\tif ${SETTLED[action]} then exit repeat`,
      '\t\t\tend try',
      '\t\t\tdelay 0.1',
      '\t\tend repeat',
      '\t\tset {trackName, trackArtist} to {"", ""}',
      '\t\ttry',
      '\t\t\tset trackName to name of current track',
      '\t\t\tset trackArtist to artist of current track',
      '\t\tend try',
      '\t\treturn target & US & (player state as text) & US & trackName & US & trackArtist',
      '\tend tell',
      'end if'
    )
  }
  lines.push('return "none"')
  return lines.join('\n')
}

/** Installed players, Spotify first (it resumes the user's own music; Music is always there). */
export async function installedPlayers(): Promise<Player[]> {
  const found = await Promise.all(
    (['Spotify', 'Music'] as const).map(async (p) => ((await appPath(BUNDLE_IDS[p]).catch(() => null)) ? p : null))
  )
  return found.filter((p): p is Player => p !== null)
}

const NOTHING_PLAYING: ToolOutcome = {
  ok: true,
  text: 'Nothing is playing: Spotify and Music are both closed.',
  title: 'Nothing playing',
  subtitle: 'No music app is open'
}

/** Turns the script's "player US state US track US artist" (or "none") into the card outcome. */
export function mediaOutcome(action: MediaAction, output: string): ToolOutcome {
  if (output === 'none') return NOTHING_PLAYING
  const [[player = '', state = '', track = '', artist = ''] = []] = splitRecords(output)
  if (!player) return fail('The music app did not answer')
  const by = artist ? ` by ${artist}` : ''
  const subtitle = truncate(artist ? `${artist} · ${player}` : player, 60)
  if (action === 'pause') {
    if (state === 'playing') return fail(`${player} kept playing`)
    return {
      ok: true,
      text: track ? `Paused ${track}${by} in ${player}.` : `${player} is paused.`,
      title: `Paused ${player}`,
      subtitle: track ? truncate(track, 60) : player
    }
  }
  if (state !== 'playing') {
    if (action !== 'play') return fail(`${player} isn't playing, so there is nothing to skip`)
    // Spotify's play only resumes: with no current track (never played, or a broken queue) it does nothing.
    const hint =
      player === 'Music'
        ? ' Choose something to play in Music first.'
        : track
          ? ' Make sure you are signed in to Spotify.'
          : ' Spotify has nothing to resume: play a song in Spotify once, or ask for a particular song.'
    return fail(`${player} didn't start playing.${hint}`)
  }
  return {
    ok: true,
    text: track ? `${player} is playing ${track}${by}.` : `${player} is playing.`,
    title: track ? `Playing ${truncate(track, 40)}` : `Playing on ${player}`,
    subtitle,
    view: { kind: 'openApp', app: player }
  }
}

export const mediaControl = defineTool({
  name: 'media_control',
  description:
    'Play, pause or skip music in Spotify or the Music app, with no song search and no API key. ' +
    'play resumes what the user last played (it opens Spotify if no music app is open); pause, next and ' +
    'previous act on whichever app is playing. Use this for "play music", "resume", "pause", "stop the music", ' +
    '"next song". For a particular song, artist or playlist use spotify_search, then spotify_play.',
  schema: { action: z.enum(['play', 'pause', 'next', 'previous']) },
  risk: 'read',
  stepLabel: (args) =>
    ({ play: 'Playing music', pause: 'Pausing music', next: 'Skipping to next song', previous: 'Going back a song' })[
      args.action
    ],
  async run(args) {
    const players = await installedPlayers()
    if (!players.length) return fail('Neither Spotify nor Music is installed')
    const output = await runAppleScript(mediaScript(args.action, players), { app: 'the music app', timeoutMs: 20_000 })
    return mediaOutcome(args.action, output)
  }
})
