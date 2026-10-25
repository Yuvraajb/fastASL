# fastASL UI kit

Everything a card view needs. Import from the barrel:

```tsx
import { Header, Feed, TokenPill, Footer, Notice, Stack } from '../ui'
```

Use the primitives instead of re-creating them in a view: headings above a list are
`SectionTitle`, the 11px dim help line is `Hint`, dark rounded boxes are `Panel`, numbered
rows are `OptionList` (it covers icon menus, context actions and settings rows too).
Font sizes come from the `--fs-*` tokens only.

Source of truth for visuals: `docs/reference/crops/` (ref3 = primary layout language).
Tokens live in `src/renderer/src/styles/tokens.css`. Owned by the design-system agent;
ask before adding tokens or changing a primitive's props.

---

## 1. Layout rules

The card (`CardShell`) already gives you the dark glass, 22px radius, 1px border and
**14px padding**. Content width is therefore **272px** (300px card) or **312px**
(340px card: conversation, confirm). Toast is 320 (content 292).

Every view's root is a `<Stack>` (flex column, **10px gap**). Order, top to bottom:

| Row | Height | Notes |
| --- | --- | --- |
| `Header` | 20px | Always first (except collapsed / toast). |
| `Feed` | by aspect | Full width, radius 14. |
| body | - | Token, strip, sentence, steps, options, buttons... |
| `Notice` | 30px (46px when it wraps) | Renders nothing when `store.notice` is empty. Put it just above the footer / buttons. |
| `Footer` or `ButtonRow` | 32px / 38px | Last row. |

- Gap between rows: **10px** (Stack default). Inside a group (e.g. token + bars, letter + divider) use a nested `<Stack gap={8}>`.
- Feed corner brackets (`brackets`) on ready, recognizing and letter building (ref1-01..03): the viewfinder look stays through the signing states. Agent / menu feeds go without.
- Feed aspect per state (follow the reference crop for your state):
  `6/5` ready (ref3-01), `4/3` listening / recognizing (ref3-02), `16/10` default (building letters ref3-03, sentence ref3-04),
  `2/1` short wide strip when lots of content follows (phrase building ref2-03, agent ready ref3-05 ≈ 2.2, working ref3-06 ≈ 1.85).
- Side-by-side layouts (confirm ref3-07, done ref3-08, toast ref2-07, did-you-mean ref2-06) use `Feed variant="thumb"` next to the details, aligned to the top of the detail block, gap 10-12px.
- Never set card width yourself: `cardWidth(view)` in `app/types.ts` decides.

### Type scale (system font, SF Pro)

| Token | Size / weight | Use |
| --- | --- | --- |
| `--fs-badge` | 10px / 500-600 | Finger-count number badges, tag chips (`OptionList`) |
| `--fs-micro` | 11px / 500-600 | `Hint` lines, mode label, mono sub lines, feed error |
| `--fs-small` | 12px / 500 | Status label, notices, meta text, option sub lines, word chips |
| `--fs-body` | 13px / 500-600 | Title "fastASL" (600), buttons (600), steps, options, details |
| `--fs-title` | 15px / 600, line-height 20px | `SectionTitle` (menu / page headings), toast title, detail title |
| `--fs-quote` | 16px / 600 | Quoted running sentence (`QuoteBox`) only |
| `--fs-result` | 17px / 600 | Result title on the conversation card (ref3-08's Done title), a long reply |
| `--fs-sentence` | 21px / 600, line-height 1.25, max 3-4 lines | The agent's reply on the conversation card (the size of ref3-04's sentence) |
| `--fs-token` | 22px / 600 | Recognized letter / word (`TokenPill`) |

Letter-spacing: `-0.01em` on 15px and up, `-0.005em` on 13px semibold.

Other sizing tokens: `--badge` 18px (number badge), `--badge-box` 24px (badge + hold ring box),
`--panel-radius` 12px (`Panel`, `QuoteBox`).

### Gray levels (white on dark, monochrome)

| Token | Value | Use |
| --- | --- | --- |
| `--text` | #fff | Primary text, current token, done/current step labels |
| `--text-1` | 82% white | Status label, footer icons, secondary emphasis |
| `--text-2` | 60% white | Secondary text (subtitles, pending steps, hints) |
| `--text-3` | 38% white | Dim: mode label, details, disabled icons |
| `--surface` | 5.5% white | Pills, panels, chips (TokenPill, QuoteBox, Notice) |
| `--surface-2` | 10% white | Secondary buttons, number badges, highlighted rows, current chip |
| `--surface-3` | 16% white | Hover on surface-2 |
| `--hairline` | 8% white | Dividers |

**Only colors allowed:** `--green` (status dot when active, success badge) and `--red`
(dictation recording dot). Nothing else gets a hue.

### Radii

Card 22 · Feed 14 (thumb 12) · Panels / notices / option rows 10-12 · Chips 8 · Pills, buttons, dots: fully round.

### Motion

`--dur` 200ms with `--ease-spring` for content; the window resize is a native spring
(main process). The card content fades in per view (`fa-fade-in`, CardShell). New
tokens and steps pop in with the same keyframe. `prefers-reduced-motion` turns
animations off globally (base.css); rAF components (Feed, ActivityBars) also freeze
their idle motion.

---

## 2. Primitives

### `Stack`, `Divider`

```tsx
<Stack gap={10} align="stretch">...</Stack>   // gap default 10, align: 'stretch' | 'center' | 'start'
<Divider />                                     // 1px hairline
```

### `Header`

Title "fastASL" (13px semibold) left, optional mode label (11px, dim, shown when
`mode !== 'command'`, highlighted for 1.6s after a mode switch), `StatusLabel` right
from `statusFor(view, mode)`.

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `view` | `View` | required | Used for the status label |
| `status` | `StatusInfo \| null` | from `statusFor` | Override; `null` hides it |
| `close` | `boolean` | `false` | Adds a plain gray 20px X after the status (circle only on hover, ref2 style); its glyph lines up with the title's inset |
| `onClose` | `() => void` | `controller.tap('close')` | |
| `title` | `string` | `'fastASL'` | |

```tsx
<Header view={view} />
<Header view={view} close />            // working / confirm / settings
```

### `StatusLabel`

6px dot (green when `tone === 'active'`, gray otherwise) + 12px label. Used by Header; use
it directly only for ref2-style rows like "● Did you mean?".

```tsx
<StatusLabel label="Ready" tone="active" />
```

### `Feed`

Live camera: grayscale, mirrored, cover-fit, MediaPipe landmarks (1.5px white lines,
3px dots). Without a camera (`live.mock`) it draws a mock grayscale hand for
`live.mockPose` (the controller sets the pose per view). Shows a CameraOff placeholder
when `cameraOn` is false and `live.error` as small gray text. With the live camera it
draws `live.source` (a `<video>` or the MJPEG canvas) and `live.hands`, mirroring both at
draw time; in dev the full feed adds a tiny gray FPS readout top-right (`.feed__fps`).

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `variant` | `'full' \| 'thumb' \| 'round'` | `'full'` | |
| `aspect` | `number` | `16/10` | full only (width / height) |
| `width`, `height` | `number` | `96`, `=width` | thumb only, px |
| `size` | `number` | `28` | round only, diameter |
| `brackets` | `boolean` | `false` | Viewfinder corner marks (ready, recognizing, letter building) |
| `recording` | `boolean` | `false` | Red dot top-left (dictation) |
| `className`, `style` | | | |

```tsx
<Feed aspect={6 / 5} brackets />                          // ready
<Feed aspect={4 / 3} brackets />                          // recognizing
<Feed brackets />                                          // building letters, 16:10
<Feed />                                                   // 16:10
<Feed variant="thumb" width={110} height={104} />          // confirm (ref3-07)
<Feed variant="thumb" width={64} height={64} />            // toast (ref2-07)
<Feed aspect={16 / 10} recording />                        // dictation (ref1-10)
```

Drawing lives in pure functions shared by the mock hand and the real landmarks:
`ui/feedDraw.ts` exports `coverRect`, `projectLandmark`, `drawFrame(ctx, source, srcW, srcH, w, h, { mirrored, grayscale })`
(returns the frame rect), `drawLandmarks(ctx, hands, w, h, { mirrored, rect, lineWidth, dotRadius })`,
`drawBrackets`, `drawMockFrame`. `ui/handConnections.ts` exports `HAND_CONNECTIONS`, `FINGERS`.
`ui/mockHands.ts` exports `MOCK_HANDS` (21-point landmark sets per pose, normalized, NOT mirrored) and `animateMockHands(pose, t)`.
A `MockHand` carries `fingerWidth` and optional `fingerScale` (per-finger thickness, thumb..pinky) used only
for the mock silhouette; fists pass a higher thickness so curled fingers merge into one mass, and
foreshortened (curled) finger segments get no contour line.
Landmarks are always raw MediaPipe coordinates; mirroring happens only at draw time.

`useLiveError(active)` returns `live.error` as React state (polled each animation frame,
re-rendering only on a change). The feed uses it for its one-line error; Settings › Camera
source shows the whole message in its `Notice`.

### `TokenPill`

Centered 22px semibold token, 44px tall dark pill (full width by default). The text has its
own 1.3 line box, so descenders (g, p, y) are never clipped.

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `text` | `string \| null` | | Letter or word |
| `quoted` | `boolean` | `false` | Curly quotes (detected word, ref1-02) |
| `variant` | `'pill' \| 'bare'` | `'pill'` | `bare` = no background, 32px tall (big current letter, ref3-03) |
| `fit` | `boolean` | `false` | Shrink to content (min 112px) and center |
| `children` | `ReactNode` | | Replaces the text (e.g. `<ActivityBars/>` while listening) |

```tsx
<TokenPill text="A" />
<TokenPill text="good" quoted fit />
<TokenPill><ActivityBars /></TokenPill>
```

### `TokenStrip`

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `items` | `readonly string[]` | required | Tokens in order, current one included |
| `current` | `number \| null` | `null` | Index drawn brighter |
| `variant` | `'letters' \| 'words'` | required | |
| `slots` | `number` | `5` | letters: minimum underline slots (empty ones dim); max 8, older letters drop off |

Letters (ref3-03): each letter over a 2px underline; done = 42% white, current = white, empty = 14%.
Words (ref2-03): 26px chips, 12px semibold; newest word stays in view, left edge fades when overflowing.

```tsx
<TokenStrip variant="letters" items={['A', 'M', 'C']} current={2} />
<TokenStrip variant="words" items={['meeting', 'tomorrow', 'at', '3', 'pm']} current={4} />
```

### `QuoteBox`

Running sentence in curly quotes, 16px semibold, max 2 lines, in a 12px-radius
`--surface` panel (min height 48). `aside` puts something on the right (e.g. a thumb feed, ref2-06).

```tsx
<QuoteBox text="Meeting tomorrow at 3pm" />
<QuoteBox text={quote} aside={<Feed variant="thumb" width={72} height={52} />} />
<QuoteBox text={quote} variant="plain" />
```

### `ActivityBars`

12 bars, 3px wide, 3px gap, 60% white, heights driven by **hand motion** (`live.motion`,
read in rAF; synthetic rhythm while `live.mock`). Never audio.

| Prop | Default |
| --- | --- |
| `count` | `12` |
| `height` | `20` (max bar height px) |

```tsx
<ActivityBars />
```

### `IconButton`

32px box, 20px lucide icon, 82% white (hover: white + faint surface).

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `icon` | `LucideIcon` | required | |
| `label` | `string` | required | aria-label + tooltip |
| `onClick` | `() => void` | | |
| `variant` | `'plain' \| 'filled'` | `'plain'` | `filled` = round `--surface-2` circle (pencil ref3-04, proceed ">" ref2-03) |
| `tone` | `'light' \| 'dim'` | `'light'` | |
| `size` / `iconSize` | `number` | `32` / `20` | |
| `indicator` | `boolean` | `false` | Static, non-interactive glyph (mic-off) |

```tsx
<IconButton icon={Pencil} label="Edit sentence" variant="filled" size={30} iconSize={15} onClick={...} />
```

### `Footer`

Three-column row (32px | center | 32px): camera toggle (`controller.tap('camera')`,
icon follows `cameraOn`), center slot, collapse chevron (`controller.tap('collapse')`).

| Prop | Default | |
| --- | --- | --- |
| `camera` | `true` | |
| `micOff` | `false` | Dim mic-off indicator in the center ("no audio is used") |
| `collapse` | `true` | |
| `brand` | `false` | Small "fastASL" label in the center (ref1 style) |
| `children` | | Custom center content (overrides micOff / brand) |

```tsx
<Footer />                 // ready: camera ... chevron
<Footer micOff />          // recognizing / building
<Footer><ActivityBars /></Footer>
```

### `Button`, `ButtonRow`

38px pills, 13px semibold. `primary` = white with black text, `secondary` = 10% white with
white text, `round` = 38px icon-only dark circle with a faint ring (ref3-05 X).

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `variant` | `'primary' \| 'secondary' \| 'round'` | `'primary'` | |
| `icon` | `LucideIcon` | | |
| `iconPosition` | `'leading' \| 'trailing'` | `'trailing'` | |
| `stretch` | `'fill' \| 'flex'` | | `fill` = 100% width, `flex` = share a ButtonRow |
| `label` | `string` | | Required for `round` |
| `onClick`, `disabled`, `className` | | | |

```tsx
<ButtonRow>                                         {/* ref3-05 */}
  <Button variant="round" icon={X} label="Cancel" onClick={() => controller.tap('secondary')} />
  <Button icon={ArrowRight} stretch="flex" onClick={() => controller.tap('primary')}>Send to agent</Button>
</ButtonRow>
<ButtonRow>                                         {/* ref3-07 */}
  <Button variant="secondary" stretch="flex">Cancel</Button>
  <Button icon={Check} stretch="flex">Confirm</Button>
</ButtonRow>
<Button icon={Send} iconPosition="leading" stretch="fill">Send</Button>        {/* ref2-04 */}
<Button variant="secondary" icon={ChevronRight} stretch="flex">New command</Button>  {/* ref3-08 */}
```

### `StepsList`

Agent steps: 28px rows, 13px/500 text, 16px icons. done = filled white circle with black
check, current = spinner, pending = hollow 1.5px circle (gray text), error = hollow circle with x.

```tsx
<StepsList steps={view.steps} />     // AgentStep[] works as-is
```

### `Spinner`

```tsx
<Spinner size={16} />
```

### `OptionList`

Rows picked by holding up N fingers (or clicking): did-you-mean lists, the quick menu,
context actions, settings. The row whose number equals `store.pick.count` gets a
`--surface-2` background, an inverted number badge and a 24px `HoldRing` (stroke 1.75)
drawn **around the badge**, so hold feedback never looks like the working `Spinner`.
Click calls `onPick(i)` (default `controller.tap('option', i)`).

Badges are 18px circles with 10px numbers (`--badge`, `--fs-badge`) in a fixed 24px box,
so rows never shift when the ring appears. Rows are 34px, 44px with a `sub` line, 40px
with `iconStyle="circle"`.

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `options` | `(string \| OptionItem)[]` | required | See below |
| `numbered` | `boolean` | `true` | Finger-count badges |
| `badge` | `'leading' \| 'trailing'` | `'trailing'` if any option has an icon, else `'leading'` | Badge position. Icon rows keep the icon in front and the badge on the right (ref2-09) |
| `iconStyle` | `'plain' \| 'circle'` | `'plain'` | `plain` = bare 16px icon (quick menu ref2-09); `circle` = icon in a 30px circle, semibold label (context actions ref1-11) |
| `selected` | `number \| null` | `null` | Gray check on that row (current setting) |
| `onPick` | `(i) => void` | controller | |

`OptionItem`:

| Field | Type | |
| --- | --- | --- |
| `label` | `string` | |
| `icon` | `LucideIcon` | Leading line icon |
| `muted` | `boolean` | Gray label (e.g. "More options") |
| `sub` | `string` | Second gray 12px line (a level's note, a gesture's task) |
| `mono` | `boolean` | `sub` in 11px monospace (URLs) |
| `tag` | `string` | Small outlined chip on the right, e.g. "built-in" |
| `detail` | `string` | Short gray text on the right |

```tsx
<OptionList options={view.options} />                                                // did you mean (ref1-12)
<OptionList options={QUICK_MENU.map((label, i) => ({ label, icon: ICONS[i] }))} />    // quick menu: icon left, badge right
<OptionList options={actions} iconStyle="circle" />                                   // context actions
<OptionList options={levels.map((label, i) => ({ label, sub: NOTES[i] }))} selected={1} />
<OptionList options={gestures.map((g) => ({ label: g.name, sub: g.task, tag: g.builtin ? 'built-in' : undefined }))} />
```

### `HoldRing`

Circular progress (white arc on a 20% track, starts at 12 o'clock). Wraps content when given children.

```tsx
<HoldRing progress={0.6} size={16} />
<HoldRing progress={holdProgress} size={36}><Feed variant="round" /></HoldRing>
```

### `CheckBadge`

Green circle with a dark check (ref3-08), pops in. `ok={false}` = gray circle with an X.

```tsx
<CheckBadge />              // 28px
<CheckBadge size={32} />
<CheckBadge ok={false} />
```

### `ProgressLine`

3px line that runs out over `duration` ms (toast countdown, ref2-07). Static at 50% with reduced motion.

```tsx
<ProgressLine duration={2600} width={120} />
```

### `Notice`

30px for one line, info icon, `--surface` panel. A long message (a permission's System Settings path) wraps to a second line, then ellipsis (`lines` allows more: Settings › Camera source shows camera errors on up to 4). Reads `store.notice` unless `text` is given; renders nothing when empty.

```tsx
<Notice />
<Notice text={cameraError} lines={4} />
```

### `CloseButton`

24px X, `circle` (default, `--surface-2`) or `plain` (gray glyph, larger, circle only on hover;
used by `Header close`). Default action `controller.tap('close')`.

```tsx
<CloseButton />
<CloseButton variant="plain" size={20} />
```

### `SectionTitle`

Heading above a menu or option list: 15px/600 (`--fs-title`), line-height 20px, 2px side
inset like the header title, one line with ellipsis.

```tsx
<SectionTitle>Did you mean...</SectionTitle>
<SectionTitle>What would you like to do?</SectionTitle>
<SectionTitle>Sensitivity</SectionTitle>
```

### `Hint`

One centered line of 11px/500 `--text-3` help text. `items` are joined by a middle dot and
may carry a 12px lucide icon (never emoji). Replaces per-view `*__hint` classes and
`GestureHint`.

| Prop | Type | |
| --- | --- | --- |
| `items` | `(string \| { label, icon? })[]` | Segments joined by " · " |
| `children` | `ReactNode` | Free-form content instead of `items` |

```tsx
<Hint items={['hold up 1–5 fingers', 'fist = back']} />
<Hint items={[{ icon: HandFist, label: 'fist to stop' }]} />
```

### `Panel`

Dark rounded box: `--surface`, radius 12 (`--panel-radius`), padding 10px 12px, faint inner
rim. For confirm details, the email target, dictated text, empty states. `QuoteBox` uses
the same styles.

```tsx
<Panel>No custom gestures yet</Panel>
<Panel className="dictation__text">...</Panel>
```

---

## 3. Reference recipes for the remaining views

These are compositions, not components. Match the crop listed.

- **Chat card** (`views/ChatView.tsx`, Command mode's one card, 340px: Ready, the phrase being signed, the exchange with the agent and its inline Confirm; replaced the Conversation card): `Header view={view}` (with the X while the agent works or asks) · `Feed aspect={16/9}` (brackets while it takes signs) · the transcript (`store.chat`, min 92px, the card capped at 560px, then it scrolls with a 22px top fade): bubbles 13px/500, radius 16 with a 6px tail corner; yours right-aligned on `rgba(255,255,255,0.15)`, the agent's left-aligned on `rgba(0,0,0,0.34)` + hairline, labelled "Agent" (11px/600 `--text-3`); live steps as 12px rows with a 13px spinner; results with `CheckBadge size={22}`, a 15px/600 title, a 12px `--text-2` subtitle, or a 92px 16:10 screenshot; errors on a soft red fill; Confirm with a green outline, the details and Allow / Cancel pills (28px); notes as a centered 11px line between hairlines; the composing bubble (dimmed, green caret, pulses while Listening; dashed placeholder when empty) · `Notice` · a slim footer: 28px camera · `Hint` for the phase · 28px minimize.
- **Working** (ref3-06; a gesture shortcut's agent fallback): `Header view={view} close` · `Feed aspect={16/9}` · `StepsList` · `Hint items={[{ icon: HandFist, label: 'fist to stop' }]}`.
- **Confirm** (ref3-07, 340px): `Header` · row: `Panel` (lucide icon + 13px lines, title `--fs-title`/600 white, rest `--text-2`) + `Feed variant="thumb"` (~104px wide, stretch to panel height) · `ButtonRow` secondary Cancel + primary "Confirm ✓".
- **Toast** (ref2-07 / ref1-09, 320px, no header): row: `CheckBadge size={32}` + title `--fs-title` 15px/600 + subtitle 13px `--text-2` + `Feed variant="thumb" width={64} height={64}` on the right; `ProgressLine` under the text. A screenshot replaces the feed tile with a 96px 16:10 thumbnail, and a `Hint` "thumbs up = open in Preview · fist = dismiss" follows.
- **Did you mean** list (ref1-12): `Header view={view} close` · `SectionTitle` "Did you mean..." ("Pick a spelling" in Spell mode, "Is this HELLO?" for a guess) · `OptionList` · `Hint` "hold up 1–N fingers · swipe ← edit".
- **Quick menu** (ref2-09): `Header` · `SectionTitle` "What would you like to do?" · `OptionList` with icons (badges trail) · `ActivityBars` centered · `Hint`.
- **Dictation** (ref1-10): `Header` · `Feed recording` · `ActivityBars` · dictated text `--fs-title`/500 in a `Panel` with a 2px white caret.
- **Settings**: `Header view={view} close` · `SectionTitle` page title · `OptionList` (`sub`, `mono`, `tag`; `selected` for the current value; `badge="leading"` only if a page really needs number-then-icon) · `Hint`.
