# fastASL — decisions log

Decisions made while building, in the order they came up. Each entry: what, why, and what it costs.

## Setup

1. **Branch `krishna`, never `main`.** The GitHub repo was empty (no commits, no `main` yet), so `krishna` starts from an empty history.
2. **Toolchain pinned for Node 20.19.** The machine has Node 20.19.4. Electron 40+ and Vitest 5 declare `node >= 22.12`, so we pin **Electron 39**, **Vite 7**, **electron-vite 6**, **Vitest 3**, **TypeScript 5.9**. Everything else is current (React 19, lucide-react, @mediapipe/tasks-vision 1.1.1, @anthropic-ai/sdk 1.x). Upgrading to Electron 45 later is a version bump once the team is on Node 22.
3. **zod 3, not 4.** `@factory/droid-sdk` has a peer dependency on `zod@^3.24` and converts tool schemas with zod-to-json-schema, so the whole app uses zod 3.25.
4. **electron-vite** builds main / preload / renderer. `npm run dev` gives HMR for the renderer.

## Window & visuals

5. **CSS glass by default; native vibrancy is opt-in (`FASTASL_VIBRANCY=hud`).** Electron masks the NSVisualEffectView of a frameless window with a hard-coded 9pt corner radius and exposes no option to change it (verified in Electron source/docs, see `docs/research/platform-research.md`). The reference images and brief call for 22px corners, and a 9pt blur rectangle behind a 22px card leaves visible blurred wedges in each corner. So the default window is `transparent: true` with a dark translucent CSS card (exact 22px radius, 1px hairline border, native window shadow recomputed with `invalidateShadow()` after each resize). Setting `FASTASL_VIBRANCY=hud` (or `popover`) turns on real `vibrancy` + `visualEffectState: 'active'`; the card then uses a more transparent background and the system corner radius. Native custom-radius blur would need a native addon (e.g. the unofficial `electron-liquid-glass` for macOS 26), which we judged too risky for a hackathon build.
6. **`type: 'panel'` + `focusable: false` + `showInactive()`.** An NSPanel floats over full-screen apps and never steals focus, which matters because Dictation types into whatever app is focused. The window becomes focusable only while the user edits text with the keyboard (sentence pencil, stream URL), then goes back.
7. **The window is always exactly the card.** The renderer measures the card (ResizeObserver) and sends its size; the main process animates bounds with a critically damped spring (~200ms settle) at 60Hz, right edge pinned, 12px below the menu bar and 12px from the right edge. `prefers-reduced-motion` (macOS "Reduce motion") snaps instantly.
8. **Dev tooling.** Dev mode (`npm run dev`, or `FASTASL_DEV=1`) registers global hotkeys: **Option+1…9** jump to the nine states in reference image 3 (Ready, Recognizing, Building, Sentence, Agent ready, Working, Confirm, Done, Collapsed); **Option+0** toggles the in-card dev panel (every mock state, gesture simulator, FPS); **Control+Option+key** simulates gestures (T thumbs up, F fist, ←/→/↑ swipes, 1–5 fingers, P palm hold, H hands down, S next recognized sign, V peace sign). A menu-bar tray item ("ASL") has Show/Hide, Quit and (dev) the same state/gesture menus. These are global shortcuts because the overlay never has keyboard focus.
9. **Screenshots.** `npm run screens [ids]` builds into a temp dir and opens an opaque "stage" window (fake menu bar + dusk wallpaper, card top-right with CSS backdrop blur), applies each mock scene, and saves `docs/screens/NN-<id>.png` via `webContents.capturePage()`. Reference images live in `docs/reference/` with per-state zoomed crops in `docs/reference/crops/`.

## Architecture

10. **One controller owns every state change** (`src/renderer/src/app/controller.ts`). Gestures, mouse taps, recognition events and agent events all go through it; it gates gestures per state (`activeGestures`) and talks to the outside world through a `Services` interface (mock implementation for UI work/screenshots, IPC implementation for real use).
11. **High-frequency data stays out of React.** Camera frames, landmarks and hand-motion energy live in a mutable `live` object read by canvases inside `requestAnimationFrame`.
12. **More than three numbered options.** Menus with 4–5 entries (Settings, Quick menu) accept **4 fingers** (thumb folded) and **5 = open palm held 0.8s**. Open-palm-to-expand only applies in the Collapsed state, so the two never collide.

## Phase 1 — UI

13. **Design system in `src/renderer/src/ui/`** (documented in `ui/README.md`): Header, StatusLabel, Feed (+ pure `feedDraw.ts` used for both the mock hand and real landmarks), TokenPill, TokenStrip, QuoteBox, ActivityBars, IconButton, Footer, Button/ButtonRow, StepsList, OptionList, CheckBadge, HoldRing, Notice, CloseButton, Spinner, ProgressLine, Stack, Hint. Views compose only these, so every state shares one spacing/type scale.
14. **Mock hand instead of a blank feed.** With no camera (Phase 1, screenshots, camera off/denied) the feed draws a shaded grayscale hand for a pose that fits the state (palm, fist "A", "C", thumbs up, point, OK, peace, two hands) with real 21-point MediaPipe landmarks on top. It reads as an illustration rather than a photo; the live camera replaces it.
15. **Collapsed pill follows ref 2** (round live thumbnail + green dot + "fastASL" + chevron) rather than ref 3's camera-icon variant, as the brief specifies. The palm-hold progress ring wraps the thumbnail.
16. **Feed aspect varies slightly by state** (16:10 by default, taller in Ready/Recognizing like ref 3, shorter in Agent ready/Settings) to match the references' proportions while keeping the 300/340px widths.
17. **Gesture hints are tiny gray lucide icons + words** ("👍 send · ✊ cancel" without emoji color), so the palette stays monochrome (green dot/check and the red dictation dot are the only colors).
18. **Controller hardening from the test pass** (102 vitest tests in `app/controller.test.ts`): late agent events after Stop are ignored (late confirms are auto-declined), a Stop before the agent starts prevents the run, "thinking" can't get stuck or be overwritten by a stale answer, and failed results stay up 8s (matching their progress line) instead of 4s.
