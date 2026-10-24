import type { ToolSummary } from './intent'

/**
 * The Mac agent's planned tools, listed in the intent prompt so Claude phrases intents the
 * agent can carry out. Phase 6 replaces this with the tool registry (src/main/tools), which
 * uses the same names.
 */
export const TOOL_CATALOG: ToolSummary[] = [
  { name: 'get_frontmost_app', description: 'Which app and window the user is working in right now.' },
  {
    name: 'calendar_list_events',
    description: "List events in the user's Calendar for today, tomorrow, the next 7 days or a date range."
  },
  {
    name: 'calendar_create_event',
    description: 'Create a Calendar event with a title, start and end time, and optional guests and video link.'
  },
  { name: 'mail_send', description: 'Send an email from Mail to addresses or contact names, with a subject and body.' },
  { name: 'message_send', description: 'Send an iMessage to a contact name, phone number or email.' },
  { name: 'notes_search', description: 'Search the Notes app by title and text.' },
  { name: 'notes_read', description: 'Read the full text of a note by its title.' },
  { name: 'spotify_search', description: 'Search Spotify for songs.' },
  { name: 'spotify_play', description: 'Play a song, album or playlist in the Spotify app.' },
  { name: 'spotify_pause', description: 'Pause Spotify playback.' },
  { name: 'open_app', description: 'Open, or bring to the front, a Mac app by name.' },
  { name: 'web_search', description: 'Open a Google search in the default browser.' },
  { name: 'type_text', description: 'Type text into the app the user is focused on.' },
  { name: 'take_screenshot', description: 'Take a full-screen screenshot and save it to the Desktop.' }
]
