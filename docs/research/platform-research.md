# Platform research: macOS Electron + TS + React (Vite) overlay

Researched 2026-10-24 on this machine (macOS 26.3 Tahoe, build 25D125, arm64, Node v20.19.4).

How each fact was checked:
- `npm view` for versions and peer ranges.
- `npm pack` tarballs for the installed `.d.ts` files: `electron.d.ts`, `vision.d.ts`, the Anthropic SDK types.
- Electron v45.0.0 docs and Objective-C++ source, read from raw.githubusercontent at tag `v45.0.0`.
- GitHub PRs and issues via `gh`.
- Small hidden-window probe scripts run against the real Electron 45.0.0 darwin-arm64 binary. Scripts are in `scratchpad/etest/`.

Each claim is tagged with its source: [types] = installed .d.ts, [docs] = official docs at the tag, [src] = Electron/MediaPipe source, [probe] = verified at runtime here, [gh] = GitHub PR/issue.

---

## Versions (npm view, 2026-10-24)

| Package | Latest | Notes |
|---|---|---|
| electron | **45.0.0** (published 2026-10-21, 3 days old) | Ships Chrome 156.0.8078.48 [probe]. Previous stable lines: 44.9.3, 43.8.3, 42.11.18. `46.0.0-alpha.1` exists. |
| electron-vite | **6.0.0** (2026-10-14) | peer `vite: ^6.0.0 \|\| ^7.0.0 \|\| ^8.0.0`; `@swc/core ^1` (optional). engines node `^20.19.0 \|\| >=22.12.0`. Config file: `electron.vite.config.{js,ts,...}` |
| vite | **8.3.5** (2026-10-21) | engines node `^20.19.0 \|\| >=22.12.0` (local Node 20.19.4 is OK, just barely) |
| @vitejs/plugin-react | **6.1.2** (2026-10-05) | peer **`vite: ^8.0.0` only**, so pin vite 8.x. Optional peers: `oxc-transform-react ^0.152`, `@rolldown/plugin-babel`, `babel-plugin-react-compiler ^1` |
| @mediapipe/tasks-vision | **1.1.1** (`latest`); `nightly` = 1.2.0-rc.20261023 | |
| @anthropic-ai/sdk | **1.3.0** (published 2026-10-23, under a day old); 1.2.0 the same day | |

Compatible set: `electron@45` + `electron-vite@6` + `vite@8` + `@vitejs/plugin-react@6`.

---

## A. Electron (45.0.0)

### A1. BrowserWindow options on macOS

#### `type: 'panel'`
- What it does [docs]: "enables the window to float on top of full-screened apps by adding the `NSWindowStyleMaskNonactivatingPanel` style mask, normally reserved for NSPanel, at runtime. Also, the window will appear on all spaces (desktops)."
- Implementation [src]:
  - `ElectronNSPanel` (an `ElectronNSWindow` subclass) returns `originalStyleMask | NSWindowStyleMaskNonactivatingPanel` from `-styleMask`.
  - Its `setCollectionBehavior:` always ORs in `CanJoinAllSpaces | FullScreenAuxiliary`.
  - The constructor calls `[window_ setLevel:NSFloatingWindowLevel]`.
- Non-activating behaviour [src]: `show()` and `focus()` skip `activateIgnoringOtherApps` for panels. They only `makeKeyAndOrderFront`, so the panel becomes key (it gets keyboard input) and the previously frontmost app stays frontmost. `showInactive()` orders the panel front without making it key.
- Added in Electron **20.0.0**:
  - PR #34388 "feat: add panel support for BrowserWindow", merged 2022-06-14, semver/minor, backported to 20-x-y [gh].
  - The v19.0.0 docs don't mention it; the v20.0.0 docs do [docs].
- Gotcha: focus/blur events are tied to main-window notifications. A non-activating panel can be key without being main, so `focus`/`blur` may not fire reliably.
  - Open PR #52914 (not merged) would add an `activable` option and dispatch focus/blur from key-window notifications [gh].
  - Until then, don't rely on `focus`/`blur` for panels.
- In `.d.ts`, `type` is typed as plain `string` [types].

#### `vibrancy`
- Valid values [types/docs]:
  - Constructor: `'appearance-based' | 'titlebar' | 'selection' | 'menu' | 'popover' | 'sidebar' | 'header' | 'sheet' | 'window' | 'hud' | 'fullscreen-ui' | 'tooltip' | 'content' | 'under-window' | 'under-page'`.
  - `setVibrancy()` accepts the same list minus `appearance-based`, plus `null`.
- **`'hud'` and `'popover'` are both valid.** They map to `NSVisualEffectMaterialHUDWindow` and `NSVisualEffectMaterialPopover` [src].
- `'appearance-based'` has no branch in `NativeWindowMac::SetVibrancy`, so it is a no-op [src]. Don't use it.
- `setVibrancy(type, { animationDuration })`: `animationDuration` (ms) only fades vibrancy in or out. You can't animate between materials [types/docs].
- Setting vibrancy makes the window "translucent", so the WebContents background becomes transparent automatically unless you pass `backgroundColor` [src]. Your `html`/`body` must be transparent for the blur to show through.
- `blendingMode` is always `BehindWindow` [src].

#### `visualEffectState`
- Values [types/docs]: `'followWindow'` (default), `'active'`, `'inactive'`.
- It must be used with `vibrancy`.
- For an overlay that is usually not the key window, use **`'active'`**. Otherwise the material looks inactive (flat grey) whenever the window isn't key.

#### `transparent`
- Sets `[window setBackgroundColor:clearColor]`. The source comment says this "will also hide the shadow" [src].
- Also sets `setOpaque:NO` for any transparent or frameless window [src].
- Docs caveats [docs]:
  - You can't click through transparent areas (use `setIgnoreMouseEvents(true, { forward: true })` for that).
  - Transparent windows aren't reliably resizable.
  - The window isn't transparent while DevTools is open.
- `win.invalidateShadow()` (macOS) recomputes the shadow from the current shape. Use it after content or shape changes on transparent windows [docs].

#### `roundedCorners` (default `true`)
- "Whether a frameless window should have rounded corners" [docs].
- On macOS, `roundedCorners: false` with `frame: false` calls `SetBorderless(true)`: it removes `NSWindowStyleMaskTitled` and adds `Borderless` [src].

#### `focusable`
- `focusable: false` sets `disableKeyOrMainWindow = YES` [src].
- `canBecomeKeyWindow` and `canBecomeMainWindow` then return NO, so the window never gets keyboard focus.
- There's a runtime setter, `setFocusable(bool)`.

#### `hasShadow`
- Default `true`. It maps directly to `[NSWindow setHasShadow:]` [src].

#### `setAlwaysOnTop(true, 'floating')`
- Levels [types/docs]: `'normal' | 'floating' | 'torn-off-menu' | 'modal-panel' | 'main-menu' | 'status' | 'pop-up-menu' | 'screen-saver' | 'dock'` (`dock` is deprecated). Optional `relativeLevel` int.
- `'floating'` = `NSFloatingWindowLevel` and is the default when `flag` is true [src].
- Levels from `floating` through `status` sit **below the Dock**. `pop-up-menu` and higher sit above it [docs].
- Apple discourages going more than 1 above `screen-saver` [docs].
- A `panel`-type window already starts at `NSFloatingWindowLevel` [src].

#### `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
- Sets `CanJoinAllSpaces` and `FullScreenAuxiliary` [src].
- **Side effect**: unless you pass `skipTransformProcessType: true`, `visibleOnFullScreen: true` calls `Browser::DockHide()`, which turns the process into a UIElement app (no Dock icon). `visibleOnFullScreen: false` calls `DockShow` [src].
- The docs warn this "will hide the window and dock for a short time every time it is called" [docs].
- If you've already hidden the Dock icon, pass `skipTransformProcessType: true`.
- With `type: 'panel'` the collection behaviour already includes both flags, so this call is mostly redundant.

#### `app.dock.hide()`
- `app.dock` is typed `Dock | undefined`, so use `app.dock?.hide()` [types].
- It calls `TransformProcessType(kProcessTransformToUIElementApplication)` and sets `setCanHide:NO` on all windows [src].
- Known issue [docs/src]: a `hide()` within 1 second of a previous `show()`/`hide()` has no effect. The workaround is `setTimeout` ≥ 1100 ms.
- `dock.show()` returns `Promise<void>`.
- For packaged builds, set `LSUIElement: true` in Info.plist (for example electron-builder `mac.extendInfo`) so the Dock icon never flashes. In dev, call `app.dock?.hide()` as early as possible.

#### Vibrancy corner radius (the key question)
- **Yes, the vibrancy view's corners are rounded on frameless windows, and the radius is hard-coded to 9 pt** [src].
  - `NativeWindowMac::UpdateVibrancyRadii` builds a 9-slice `NSImage` mask (`radius = fullscreen ? 0 : 9.0f`, `capInsets` = radius, `NSImageResizingModeStretch`) and calls `[vibrantView setMaskImage:]`.
  - The mask applies only if the window still has `NSWindowStyleMaskTitled` (that is, `roundedCorners` isn't `false`) **and** the window is frameless (or is modal).
  - With `roundedCorners: false` there is no mask, so you get square vibrancy corners.
- **There's no Electron option to customize the radius in 45.0.0.**
  - No `cornerRadius` appears anywhere in `electron.d.ts` 45.0.0 [types].
  - The only corner-related option is the boolean `roundedCorners`.
  - The old private `_cornerMask` override was **removed** in PR #48376 (merged 2025-09-26, "MacOS 26 Tahoe - stop overriding private cornerMask API to fix WindowServer GPU load"). Corner masking now relies solely on the `NSVisualEffectView` `maskImage` [gh/src].
- No new option in recent versions:
  - PR #50415 "feat: add native Liquid Glass support on macOS 26+" would have added `glassEffect`/`setGlassEffect({ cornerRadius, style, tintColor })`. It was **closed without merging** on 2026-06-30 [gh].
  - There is no `glass` API in the 45.0.0 types [types].
- Ways to get a custom radius:
  1. **Design to 9 pt.** Use CSS `border-radius: 9px` on your root container so the content matches the vibrancy mask. This is the simplest option.
  2. **`roundedCorners: false` plus a small native addon.**
     - Get `NSView*` from `win.getNativeWindowHandle()` (the Buffer holds an `NSView*` on macOS [types]).
     - Find the `NSVisualEffectView`.
     - Set your own 9-slice `maskImage` (copy Electron's code with your radius), or set `wantsLayer` + `layer.cornerRadius`/`masksToBounds` on your own effect view.
     - Then call `win.invalidateShadow()`.
     - Requires node-addon-api + Objective-C++.
  3. **Third-party `electron-liquid-glass`** (npm 1.1.1, last published 2025-09-17, unofficial).
     - Adds an `NSGlassEffectView` via `liquidGlass.addView(win.getNativeWindowHandle(), { cornerRadius, tintColor, opaque })`.
     - Its README says it needs macOS 26+, `transparent: true`, and **no** `vibrancy`. This machine is macOS 26.3.
     - It uses private APIs for variants and its README lists Node 22+.
  - `win.setShape()` is Windows/Linux only, so it isn't an option on macOS [docs].
- Unverified: the outer window frame of a titled frameless window is rounded by AppKit with the system radius, which is larger on Tahoe. That may not match the 9 pt vibrancy mask. Screenshot your actual window to check.

### A2. `win.setBounds(bounds, animate)`
- Signature `setBounds(bounds: Partial<Rectangle>, animate?: boolean)`. `animate` is marked _macOS_ [types/docs].
- **It is supported**: it calls `[window_ setFrame:display:YES animate:animate]` [src].
  - It's AppKit's built-in frame animation, so the duration isn't configurable (NSWindow `animationResizeTime`).
  - `resized` fires once when the animation finishes [docs].
- No-op while fullscreen. Size is clamped to min/max size. y can't go above the menu bar ("tray") height [src/docs].
- The same `animate` flag exists on `setContentBounds`, `setSize`, `setContentSize`, and `setPosition` [docs].

### A3. `capturePage()` and `getMediaSourceId()`
- Signature: `win.capturePage(rect?, opts?: { stayHidden?, stayAwake? }) => Promise<NativeImage>`. `webContents.capturePage` has the same signature [types].
- **It preserves transparency** [probe]:
  - Test: a `transparent: true, frame: false` window 200×200 with a 50×50 red div.
  - Result: a 400×400 bitmap (Retina, device scale 2). Pixel in the red div = RGBA(255,0,0,255). Far corner = RGBA(0,0,0,**0**).
  - Electron maintainers confirm transparent output is intended (#29289) [gh].
- **It doesn't capture vibrancy.** Vibrancy is a native `NSVisualEffectView` behind the web contents, and `capturePage` only reads the compositor surface [src]. To capture the real composited look, use an OS-level capture (`screencapture -l`, `desktopCapturer`).
- Capturing a hidden window works with `{ stayHidden: true }` [probe].
- `getMediaSourceId()` format: `"window:<id>:<other_id>"` [types/docs].
  - On macOS, `<id>` is the CGWindowID: `NativeWindowMac::GetAcceleratedWidget()` returns `[window_ windowNumber]` [src].
  - Observed values: `"window:3911:0"`, `"window:3912:0"` [probe].
- Mapping to `screencapture`: `const id = win.getMediaSourceId().split(':')[1]`, then `screencapture -x -o -l <id> out.png`.
  - Flags (from `man screencapture`): `-l <windowid>` captures that window, `-o` drops the window shadow, `-x` is silent, `-t` sets the format.
  - Expect a Screen Recording (TCC) permission requirement for whichever process macOS treats as responsible (the terminal in dev, your app when packaged).

### A4. Camera permission
- Signatures [types]:
  - `systemPreferences.askForMediaAccess(mediaType: 'microphone' | 'camera'): Promise<boolean>` (macOS).
  - `systemPreferences.getMediaAccessStatus(mediaType: 'microphone' | 'camera' | 'screen'): 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'`.
- Behaviour [docs]:
  - If access was already denied, no prompt appears and the promise resolves with the existing status. The user must change it in System Settings.
  - Changes made there require an app restart.
  - You must set `NSCameraUsageDescription` in Info.plist.
- **The stock dev `Electron.app` 45.0.0 does include `NSCameraUsageDescription`** = "This app needs access to the camera". Read with `plutil -p` from the official darwin-arm64 zip [probe].
  - It also has `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` and `NSBluetooth*`, plus `NSAllowsArbitraryLoads`.
  - `CFBundleIdentifier` = `com.github.Electron`, `LSMinimumSystemVersion` = 13.0.
- `getMediaAccessStatus('camera')` returned `'not-determined'` when the probe ran from this agent's shell [probe].
- Dev caveat (expected macOS behaviour, not verified here): when `electron-vite dev` spawns Electron from a terminal, TCC usually treats the **terminal app** (iTerm2 here) as the responsible process. The prompt and the grant may then be attributed to iTerm2 rather than "Electron". Packaged apps get their own entry.
- For packaged builds, add your own `NSCameraUsageDescription` (electron-builder `mac.extendInfo`). With hardened runtime, add the `com.apple.security.device.camera` entitlement (standard Apple requirement).

### A5. Custom protocol for `.wasm` and model files
- Current API [types/docs]:
  - `protocol.registerSchemesAsPrivileged([{ scheme, privileges }])` must be called **before `app.ready`**, and only once.
  - `protocol.handle(scheme, (request: GlobalRequest) => Response | Promise<Response>)`.
  - `registerFileProtocol`, `registerStreamProtocol` and the other `register*Protocol` APIs are deprecated.
  - New in 45: `request.initiatorOrigin` is set for requests from web content and can't be spoofed by the page.
- Privilege flags (all default false) [types]: `standard, secure, bypassCSP, allowServiceWorkers, supportFetchAPI, corsEnabled, stream, codeCache, allowExtensions`.
- **Verified CORS behaviour, from an `http://127.0.0.1` page (like the Vite dev server)** [probe]:

| Scheme privileges | `fetch()` | `WebAssembly.compileStreaming(fetch())` | `<script crossOrigin=anonymous>` |
|---|---|---|---|
| `standard+secure+supportFetchAPI+corsEnabled` | **OK** with or without an ACAO header | OK (with `content-type: application/wasm`) | load |
| `standard+secure+supportFetchAPI` (no `corsEnabled`) | **"Failed to fetch"** even with ACAO | fails | error |
| `supportFetchAPI` only | fails | fails | error |

  - So **`corsEnabled: true` is the privilege that matters** for cross-origin fetch.
  - Recommended: `{ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }`.
  - Still return `access-control-allow-origin: *` and a correct `content-type` (`application/wasm` for `.wasm`) from the handler.
- Handler pattern [docs]: `return net.fetch(pathToFileURL(safePath).toString())`, with a path-traversal check (`path.relative` must not start with `..`).
- New and **experimental** in 45 [types/docs]: `protocol.registerSource(scheme, { routes: [{ match?: { host?, path? }, source: { type: 'directory', root, index?, headers? } }] })`.
  - It serves a directory without a JS handler, so the main thread isn't involved.
  - It handles `GET`/`HEAD`, sets `Content-Type` from the extension, and supports asar.
  - `headers` lets you add ACAO.
- Also verified [probe]: a `file://` page (production `loadFile`) **can** `fetch('./x.wasm')`, `WebAssembly.compileStreaming(fetch('./x.wasm'))`, XHR, and load `<script crossOrigin="anonymous">` from sibling `file://` paths. So MediaPipe assets placed next to the built renderer (`src/renderer/public/...`) work in both dev (http) and prod (file) **without** a custom protocol. Use a custom scheme when assets live outside the bundle (for example `userData`).

### A6. Permission handlers
- Request handler [types]: `session.setPermissionRequestHandler((webContents, permission, callback, details) => void | null)`.
  - For `'media'`, `details` is a `MediaAccessPermissionRequest`: `{ mediaTypes?: ('video'|'audio')[], securityOrigin?, isMainFrame, requestingUrl }`.
  - `'media'` = camera/mic. `'display-capture'` = screen/window/tab capture, and is a separate permission [docs].
- Check handler [types]: `session.setPermissionCheckHandler((webContents | null, permission, requestingOrigin, details) => boolean | null)`.
  - `details` includes `mediaType?: 'video'|'audio'|'unknown'`, `securityOrigin?`, `requestingUrl?`, `isMainFrame`, `embeddingOrigin?`.
- Implement **both** handlers. Most APIs check first, then request [docs].
- Default with no handlers: "Electron will automatically approve all permission requests" (security tutorial) [docs].
- Example:
  ```ts
  ses.setPermissionRequestHandler((wc, p, cb, d) => cb(p === 'media' && isTrusted(d.requestingUrl)))
  ses.setPermissionCheckHandler((wc, p, origin) => p === 'media' && isTrustedOrigin(origin))
  ```
- Chromium's `getUserMedia` prompt goes through these handlers. The macOS TCC prompt is separate, so call `askForMediaAccess('camera')` in main first.

---

## B. MediaPipe Tasks Vision `@mediapipe/tasks-vision@1.1.1` (from `vision.d.ts` and the bundle)

```ts
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

const vision = await FilesetResolver.forVisionTasks(basePath /* dir containing the wasm files, no trailing file name */);
// signature: static forVisionTasks(basePath?: string, useModule?: boolean): Promise<WasmFileset>
const hl = await HandLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: '<url>/hand_landmarker.task',   // OR modelAssetBuffer: Uint8Array | ReadableStreamDefaultReader (not both: throws)
    delegate: 'GPU',                                 // 'CPU' | 'GPU'
  },
  runningMode: 'VIDEO',                              // type RunningMode = 'IMAGE' | 'VIDEO' (default IMAGE)
  numHands: 2,                                       // default 1
  minHandDetectionConfidence: 0.5,                   // default 0.5
  minHandPresenceConfidence: 0.5,                    // default 0.5
  minTrackingConfidence: 0.5,                        // default 0.5
  // canvas?: HTMLCanvasElement | OffscreenCanvas    // optional; GPU path creates a WebGL context on it
});
const r: HandLandmarkerResult = hl.detectForVideo(source, timestampMs /*, imageProcessingOptions? */);
```

- Other constructors: `createFromModelPath(fileset, path)`, `createFromModelBuffer(fileset, buf)`. Also `setOptions(opts)`, `detect(image)` (IMAGE mode), `close()`, and `HandLandmarker.HAND_CONNECTIONS`.
- `HandLandmarkerResult` [types]:
  - `landmarks: NormalizedLandmark[][]`: x, y in [0..1] of the input image; z; `visibility`; optional `presence`.
  - `worldLandmarks: Landmark[][]`: metres.
  - `handedness: Category[][]`: `{ score, index, categoryName, displayName }`.
  - `handednesses: Category[][]` is **deprecated**: "Use `.handedness` instead". Use `handedness`.
- `ImageSource = TexImageSource` = `ImageBitmap | ImageData | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas | VideoFrame` (TS lib.dom). All four you listed are accepted.
- Gotchas found in the bundle [src]:
  - `runningMode` is tested as `!== "IMAGE"`; the type wants `'VIDEO'`. Calling `detectForVideo` on an IMAGE-mode task throws "Task is not initialized with video mode".
  - At runtime the timestamp falls back to `performance.now()` if omitted, but the type requires it.
  - Timestamps must **strictly increase**: the wasm contains "New timestamp is equal or less than the last one."
  - `detectForVideo` is **synchronous** and blocks the calling (UI) thread. The docs say so too.
  - The wasm loader is injected as `<script crossOrigin="anonymous">` appended to `document.body` (in a worker it uses `importScripts`). It therefore needs a CORS-clean response and a CSP that allows that script origin.
  - The model is loaded with plain `fetch(modelAssetPath)`.
  - With `delegate: 'GPU'`, WebGL `texImage2D` also refuses tainted cross-origin images or video, so frames must be CORS-clean.
- Which wasm files are needed:
  - `forVisionTasks(base, useModule=false)` resolves to `${base}/vision_wasm_internal.{js,wasm}` when SIMD is supported. Chromium/Electron supports SIMD.
  - Otherwise it resolves to `vision_wasm_nosimd_internal.*`. With `useModule=true` it resolves to `vision_wasm_module_internal.*`.
  - **Minimum set for Electron: `vision_wasm_internal.js` (334 KB) + `vision_wasm_internal.wasm` (13.5 MB).** Copying all 6 files in `node_modules/@mediapipe/tasks-vision/wasm/` (~40 MB) is the safe option.
- Canonical model URL (float16, the only published variant), checked with HTTP 200, 7,819,105 bytes, `access-control-allow-origin: *`, last-modified 2023-04-26:
  - `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` (pinned)
  - `.../float16/latest/hand_landmarker.task` (the docs link; same bytes today)
  - Bundle it locally for an offline overlay.
- The official docs sample is outdated: it calls `setOptions({ runningMode: "video" })` and `detectForVideo(video)` without a timestamp. Follow the `.d.ts` instead.
- **Handedness and mirroring:**
  - The legacy Hands docs say handedness "is determined assuming the input image is mirrored (selfie)" [docs, google-ai-edge/mediapipe `docs/solutions/hands.md`].
  - **The Tasks API changed that:**
    - Commit ed0c8d8 "Swap left and right hand labels." (2023-08-16, around v0.10.5) [gh].
    - The current label map is `Right = index 0`, `Left = index 1` (`hand_landmarks_detector_graph.cc`) [src].
    - Result: for an **un-mirrored** camera frame (raw `getUserMedia`), `Left`/`Right` refer to the subject's own hands. Mirroring the frame before inference swaps them.
    - Open docs issue #6376 (2026-10-09) asks Google to document this. The official guides still show the pre-swap `index: 0 = Left` example [gh].
  - CSS `transform: scaleX(-1)` on the `<video>` only mirrors the display, not what MediaPipe sees.
  - If you display mirrored video, draw landmarks at `x' = 1 - x` but keep the reported handedness.
  - Do a 5-second empirical check: raise your right hand and confirm the label.

---

## C. `@anthropic-ai/sdk@1.3.0`

From `resources/messages/messages.d.ts`:
```ts
create(params: MessageCreateParamsNonStreaming, options?: RequestOptions): APIPromise<Message>;
create(params: MessageCreateParamsStreaming,    options?: RequestOptions): APIPromise<Stream<RawMessageStreamEvent>>;
create(params: MessageCreateParamsBase,         options?: RequestOptions): APIPromise<Stream<RawMessageStreamEvent> | Message>;
```

- Required params: `max_tokens: number`, `messages: MessageParam[]`, `model: Model`.
- Optional params: `system`, `stream`, `thinking`, `output_config` (`effort`, `format`), `tools`, `tool_choice`, `stop_sequences`, `metadata`, `cache_control`, `service_tier`, `speed`, `inference_geo`, `container`, `diagnostics`, `user_profile_id`, `workspace_id`.
- `client.messages.parse()` and `client.messages.stream()` also exist.
- The `Model` union includes `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1` and others.
  - Per the bundled Claude API reference: default `claude-opus-5-5`. Thinking can't be disabled on Opus 5.5 (control it with `output_config.effort`; the default is `medium`). Assistant prefill returns a 400 on current models.
- Images: `{ type: 'image', source: { type: 'base64', media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data } }`.
- Client: `new Anthropic({ apiKey?, timeout? /* ms */, maxRetries? /* default 2 */, dangerouslyAllowBrowser? })`.
  - Browser-like environments, including an Electron renderer, are refused unless `dangerouslyAllowBrowser` is set.
  - **Call it from the main process** and keep the key out of the renderer.
- CommonJS + ESM. Optional peer `zod ^3.25 || ^4`.

---

## D. MJPEG (`multipart/x-mixed-replace`) in `<img>` → canvas (verified in Electron 45 / Chrome 156)

Probe: a Node server streams 64×48 red/lime/blue JPEG parts every 100 ms. The page is served from a different origin. Each case sampled the canvas centre pixel every 40 ms for 2.5 s [probe].

| Case | Result |
|---|---|
| ACAO `*` + `img.crossOrigin='anonymous'`, img attached to DOM | **Not tainted**; `getImageData` works; 23 colour changes (red→lime→blue…) |
| Same, img **not attached** to DOM | **Not tainted**; frames still update (23 changes) |
| No ACAO + `crossOrigin='anonymous'` | `error` event; image never loads |
| ACAO `*` but **no** `crossOrigin` attribute | Draws, but **tainted**: `SecurityError ... canvas has been tainted by cross-origin data` |
| Stream served by `protocol.handle` (`app://`, `corsEnabled`) as a `ReadableStream` with ACAO `*` | Works; not tainted; frames update |

Caveats:
- **`load` fires only once** (first part). No event fires per frame, so poll and redraw on every `requestAnimationFrame` (or a timer). `drawImage` always draws the latest decoded part.
- Set `crossOrigin` **before** `src`. ACAO must be on the multipart response headers, not on each part.
- You can pass the `<img>` straight to `detectForVideo` (`HTMLImageElement` is a `TexImageSource`). For the GPU delegate it must be CORS-clean, same as for 2D canvas.
- Use `backgroundThrottling: false` if the window may be hidden or occluded; otherwise timers and rAF get throttled.
- Alternative that avoids `<img>`: `fetch()` the stream, split parts on the boundary, then `createImageBitmap(blob)` and pass the `ImageBitmap` to MediaPipe. This gives exact per-frame events.

---

## E. This machine

| Check | Result |
|---|---|
| `which ffmpeg` | `/opt/homebrew/bin/ffmpeg`, **ffmpeg 8.1** |
| `which npx` | `/Users/kc/.nvm/versions/node/v20.19.4/bin/npx`, npx 10.8.2 (npm 10.8.2, Node v20.19.4) |
| frontmost app (`osascript ... frontmost is true`) | **`iTerm2`** |
| OS | macOS 26.3 (25D125), arm64 |

Side notes:
- A `type: 'panel'` overlay shown with `show()` won't change the frontmost app, because it's non-activating. The `osascript` frontmost check will keep returning the user's app.
- `npm install` of several packages at once in an empty dir failed here with npm 10.8.2 `Cannot read properties of null (reading 'edgesOut')`. `npm pack` worked. If you hit this, retry or upgrade npm.
