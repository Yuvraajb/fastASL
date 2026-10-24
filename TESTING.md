# fastASL manual test checklists

Step-by-step checks to run by hand on a Mac, one section per phase. Each step lists the exact action and the expected result. If a step fails, note the step number and what you saw.

**Run it**

- `npm install`, then `npm run dev`. Dev mode turns on the global hotkeys and the dev entries in the tray menu.
- Phase 1 runs on mock services and a mock animated hand in the feed. You don't need a camera or any API keys.
- Automated checks: `npm run typecheck`, `npm test`, `npm run build`.
- Screenshots: `npm run screens` writes every mock state to `docs/screens/NN-<id>.png`. For a subset, run `npm run screens -- ready,confirm`.

**Dev hotkeys** (they are global, so they work while another app has focus)

| Keys | Action |
| --- | --- |
| Option+1…9 | Ready, Recognizing, Building, Sentence, Agent ready, Working, Confirm, Done, Collapsed |
| Option+0 | Toggle the dev panel |
| Control+Option+T / F | Thumbs up / fist |
| Control+Option+← / → / ↑ | Swipe left / right / up |
| Control+Option+1…5 | Hold 1–5 fingers |
| Control+Option+P | Open palm hold (expands the collapsed pill) |
| Control+Option+H | Both hands down (ends the phrase) |
| Control+Option+S | Next recognized sign (command: meeting, tomorrow, at, 3, pm; spell: K R I S H N A; dictation: better human computer interaction) |
| Control+Option+V | Peace-sign gesture shortcut |

## Phase 1 — UI shell and states (mock data)

### Launch and window

1. Run `npm run dev`. **Expected:** a dark glass card with "fastASL" and a green dot labeled "Ready" appears in the top-right corner of the main display. It sits 12px below the menu bar and 12px from the right edge. The first launch may show a macOS camera-permission prompt; either answer is fine in Phase 1.
2. Check the Dock and the Cmd+Tab switcher. **Expected:** fastASL appears in neither.
3. Open TextEdit and start typing. **Expected:** the card stays on top, and every keystroke lands in TextEdit. The card never takes focus.
4. While typing in TextEdit, click the camera icon on the card once, then keep typing. **Expected:** the first click works with no extra activation click, and your typing still goes to TextEdit.
5. Make a window full screen (Ctrl+Cmd+F). **Expected:** the card floats over the full-screen app.
6. Switch Spaces (Ctrl+← / Ctrl+→). **Expected:** the card shows on every Space, in the same position.
7. Change the display resolution, or plug in or unplug a display. **Expected:** the card moves back to the top-right of its display with the same 12px gaps.
8. Look closely at the card. **Expected:** it is 300px wide with 22px corners, a 1px hairline border and a soft shadow. The feed is grayscale and mirrored, with thin white landmark lines, small white dots and white corner brackets. Apart from the status dot, there is no color anywhere.

### States (Option+1…9)

9. **Option+1, Ready.** **Expected:** the header shows "fastASL" on the left and a green dot with "Ready" on the right. The feed shows an open palm with corner brackets. The footer has a camera icon on the left and a chevron on the right.
10. **Option+2, Recognizing.** **Expected:** a gray dot with "Recognizing...". Under the feed, a dark pill shows "A" in large semibold type. The footer has camera, mic-off and chevron icons.
11. **Option+3, Building.** **Expected:** a gray dot with "Building...". The current letter "C" sits above a token strip reading A M C. Each token has a thin underline, and C is the brightest. The footer has camera, mic-off and chevron icons.
12. **Option+4, Sentence.** **Expected:** a gray dot with "Sentence". Under the feed is a small "Sentence" label, then "Can we meet tomorrow?" in large, left-aligned semibold type. A round pencil button sits at the bottom-right, and the hint below reads "swipe ← delete · swipe → continue".
13. **Option+5, Agent ready.** **Expected:** the card springs out to 340px wide, with a green dot and "Agent ready". Below the feed is the intent "Schedule a meeting tomorrow at 10am with the team", then a round dark X button and a white "Send to agent →" pill. The hint row reads "send · cancel", with icons.
14. **Option+6, Working.** **Expected:** the card is 300px wide, with a gray dot, "Working..." and an X. The steps list shows two rows with filled white checks, a spinner on "Adding attendees", and a dimmer hollow circle on "Adding meeting link". The hint reads "fist to stop".
15. **Option+7, Confirm.** **Expected:** the card is 340px wide, with a gray dot and "Confirm". On the left is a "Team Sync" event box with a calendar icon, "Tomorrow, Oct 25", "10:00 – 11:00 AM", "4 guests" and "Google Meet". On the right is a thumbs-up feed tile. Below are a dark "Cancel" pill and a white "Confirm ✓" pill.
16. **Option+8, Done.** **Expected:** the card is 340px wide, with a green dot and "Done". A feed thumbnail sits on the left. On the right are a green check badge, "Meeting created", the subtitle and a thin progress line that runs out. Below are "View" and "New command ›" pills, then the hint "hold 3 fingers to save as a gesture". A jump with Option+8 doesn't auto-collapse; step 25 tests that.
17. **Option+9, Collapsed.** **Expected:** a pill about 40px tall holding a round live thumbnail, a green dot, "fastASL" and a chevron. Click it. **Expected:** it expands to Ready.
18. In Ready, click the footer chevron. **Expected:** the card collapses to the pill.
19. Click the camera icon. **Expected:** the feed changes to a camera-off icon with "Camera off", and the footer icon dims. In the collapsed pill the dot turns gray. Click it again. **Expected:** the feed comes back. Quit and relaunch. **Expected:** the camera setting is kept.

### Dev panel

20. Press Option+0. **Expected:** a small dark dev panel appears at the bottom of the card, showing "dev", an FPS counter, an ×, a grid with every mock scene id and a grid of gesture buttons. Click "dictation". **Expected:** the card switches to that state. Click "fist". **Expected:** it acts like Ctrl+Opt+F. Press Option+0 again, or click ×. **Expected:** the panel closes.

### Gesture flows (Ctrl+Opt = Control+Option)

21. Press Option+1, then Ctrl+Opt+S. **Expected:** "Recognizing..." with the quoted word "meeting" in the pill. Press Ctrl+Opt+S again. **Expected:** "Building..." with the strip "meeting tomorrow". Press Ctrl+Opt+S a third time. **Expected:** the strip reads "meeting tomorrow at". Press Ctrl+Opt+H. **Expected:** "Sentence" with "Meeting tomorrow at".
22. Press Ctrl+Opt+T. **Expected:** a spinner and "Understanding..." appear next to the Sentence label for about 0.5s. Then the card springs to 340px and shows Agent ready with "Schedule a meeting tomorrow at 3pm with the team".
23. Press Ctrl+Opt+T. **Expected:** "Working..." at 300px, with steps streaming in. "Opening Calendar" shows a spinner, then turns into a check after about 0.7s. "Creating event" then shows a spinner, and about 0.7s later the card switches to Confirm (340px, Team Sync).
24. Press Ctrl+Opt+T. **Expected:** the card returns to Working with "Creating event" checked. "Adding attendees" and "Adding meeting link" each finish after about 0.7s.
25. **Expected (continues from 24):** the card shows Done with a green dot, a green check, "Meeting created" and a progress line. When the line runs out after about 4s, the card springs into the collapsed pill.
26. Press Ctrl+Opt+P. **Expected:** the pill expands to Ready.
27. Repeat steps 21–23, and at Confirm press Ctrl+Opt+F instead. **Expected:** Done appears with a gray dot, "Cancelled" and "No event was created." with no green check. It collapses after about 8s.
28. Repeat steps 21–23, and during Working press Ctrl+Opt+F. **Expected:** a toast reading "Stopped", with "The agent was interrupted" and no green check. After about 2.6s the card returns to Ready.
29. In the Sentence state from step 21, press Ctrl+Opt+←. **Expected:** the last word is deleted, leaving "Meeting tomorrow". Keep pressing it until the sentence is empty. **Expected:** the card returns to Ready.
30. In the Sentence state, click the pencil. **Expected:** the text becomes editable with the caret at the end, and a check button replaces the pencil. Type " today" and press Return. **Expected:** the sentence updates. Edit again and press Esc. **Expected:** the change is discarded. After either one, clicking the card no longer takes keyboard focus.
31. In Agent ready, press Ctrl+Opt+←. **Expected:** the card goes back to Sentence (this is the "Change" action). Press Ctrl+Opt+F. **Expected:** the card returns to Ready.
32. In Building, press Ctrl+Opt+←. **Expected:** the last token is removed. Press Ctrl+Opt+F. **Expected:** the card returns to Ready with the phrase cleared.
33. In Ready, press Ctrl+Opt+T. **Expected:** a quick menu with 5 numbered options. Press Ctrl+Opt+1. **Expected:** Ready, with the hint "Create event: sign the details".
34. In Ready, press Ctrl+Opt+→. **Expected:** "Dictation" flashes next to "fastASL", the status changes to green "Dictating...", and a red recording dot appears on the feed. Press Ctrl+Opt+S twice. **Expected:** "better human" appears in the text box. Press Ctrl+Opt+→. **Expected:** Spell mode, labeled "Spell". Press Ctrl+Opt+→ once more. **Expected:** Command mode. "Command" shows for a moment, then the label fades out.
35. Switch to Spell mode, press Ctrl+Opt+S 5 times, then press Ctrl+Opt+H. **Expected:** a "Did you mean..." numbered list starting with "KRISH". Press Ctrl+Opt+1. **Expected:** a "Typed" toast with a green check, and the card then returns to Ready.
36. In Ready, press Ctrl+Opt+↑. **Expected:** Settings with 5 numbered rows. Press Ctrl+Opt+5. **Expected:** the Sensitivity page. Press Ctrl+Opt+F. **Expected:** back to the Settings list. Press Ctrl+Opt+F again. **Expected:** back to Ready.
37. Press Option+9, then Ctrl+Opt+V. **Expected:** after about 0.4s the pill turns into a toast. It shows a green check, "Screenshot taken", "Saved to Desktop", "compiled · 0.4 s", a peace-sign thumbnail and a progress line. After about 2.6s it goes back to the pill. Do the same from Ready. **Expected:** it returns to Ready.
38. Gating check. Press Ctrl+Opt+T while collapsed, then Ctrl+Opt+P while in Ready. **Expected:** nothing happens in either case.

### Motion

39. Press Option+1, Option+5, Option+1, then Option+9, Option+1. **Expected:** the card size changes with a quick spring of about 200ms and no wobble, and the content crossfades. The right edge and top stay pinned at their 12px gaps throughout. After each resize the shadow follows the new shape, with no leftover rectangle.
40. Turn on System Settings → Accessibility → Display → Reduce motion, then repeat step 39. **Expected:** resizes snap into place, there is no crossfade, and the mock hand stops moving. Turn Reduce motion off. **Expected:** the spring returns without restarting the app.

### Tray menu

41. Click "ASL" in the menu bar. **Expected:** the menu lists "Show / hide fastASL", "Dev: states" (every mock state), "Dev: simulate gesture" (with shortcuts shown), "Dev: toggle dev panel ⌥0" and "Quit fastASL".
42. Click "Show / hide fastASL" twice. **Expected:** the card hides, then reappears, without taking focus. Choose "Dev: states → Dictation". **Expected:** the card shows Dictation.
43. Click "Quit fastASL". **Expected:** the card and the tray item disappear, and the hotkeys are released (Option+1 types "¡" again).

### Screenshots

44. Run `npm run screens`. **Expected:** it finishes in about 30s and writes 32 files, from `docs/screens/01-collapsed.png` to `32-missingKey.png`. Each is 1280×880 and shows the card at the top-right of a fake desktop. No window stays open, and `out-screens/` is gone afterwards.
45. Open a few screenshots next to `docs/reference/crops/`. **Expected:** the layout, spacing, type sizes and gray levels match the references.

## Phase 2 — Camera and hand tracking

**Before you start**

- `npm install` now runs `postinstall`, which puts the MediaPipe runtime and hand model in `src/renderer/public/mediapipe/` (gitignored, about 21 MB). `npm run setup` does the same by hand.
- The ESP32 stand-in needs ffmpeg: `brew install ffmpeg`.
- Screenshots (`npm run screens`) and `?mock=1` never start the camera; they always show the mock hand.
- Ctrl+Opt = Control+Option. Settings › Camera source is Ctrl+Opt+↑ then Ctrl+Opt+4. On that page, Ctrl+Opt+1 picks the MacBook camera, Ctrl+Opt+2 the ESP32 stream, and Ctrl+Opt+3 (or a click on "Edit stream URL") opens the URL field.

### Assets

1. Run `npm run setup`. **Expected:** "copied" / "saved" lines, then "MediaPipe assets ready". Run it again. **Expected:** "up to date" and "present". Delete `src/renderer/public/mediapipe/hand_landmarker.task` and run it again. **Expected:** it downloads again (7.8 MB).
2. Turn Wi-Fi off, delete the model, and run `npm run setup`, then `echo $?`. **Expected:** "FAILED: …" and exit code 1. Turn Wi-Fi back on and run `npm run setup` once more.

### Built-in camera

3. With the default settings (built-in camera, camera on), run `npm run dev`. **Expected:** a macOS camera prompt (in dev it may name your terminal app). Allow it. Within about 2s the mock hand is replaced by your camera: grayscale, mirrored like a mirror (raise your right hand and it shows on the right), cover-filling the feed. White landmark lines and dots sit on your fingers and follow them. A tiny gray "30 fps" (about 25–30) shows top-right inside the feed. Option+0 opens the dev panel with the same FPS.
4. Press Option+2 (Recognizing) and wave a hand. **Expected:** the activity bars rise. Hold still. **Expected:** they fall to near zero within about 0.5s. Move your hands out of frame. **Expected:** the landmarks disappear.
5. Press Option+1…9 in turn. **Expected:** every state shows the live camera instead of the mock hand. The thumbnails (Confirm, Done) show landmarks; the round thumbnail of the collapsed pill shows the camera without landmarks. Only the full-width feed shows the FPS.
6. Click the camera icon in the footer. **Expected:** "Camera off", the camera's green light goes off within a second, and no error text. Click it again. **Expected:** the live feed is back within about 2s, with no error flash.
7. With the camera off, quit from the tray ("Quit fastASL") and relaunch. **Expected:** "Camera off", no camera light and no camera prompt. Turn it back on.
8. Revoke camera access for the app (or your terminal in dev) in System Settings › Privacy & Security › Camera, then relaunch. **Expected:** the mock hand with "Camera access denied — allow fastASL in System Settings › Privacy & Security › Camera" in small gray text at the bottom of the feed. Restore access and relaunch.

### ESP32-CAM stream (mock server)

9. In a second terminal run `npm run mock:mjpeg -- --test`, then `curl -s --max-time 2 http://127.0.0.1:8081/stream | head -c 200 | xxd | head`. **Expected:** `--frame`, `Content-Type: image/jpeg`, then `ffd8`.
10. In the app open Settings › Camera source and pick "Edit stream URL". Type `http://127.0.0.1:8081/stream` and press Return. **Expected:** within about 1s the feed shows the test pattern (grayscale, mirrored, so the frame counter digits read backwards). The ESP32 row shows the URL with a check. The mock server logs "client connected (1 watching)" and about 15 fps. The feed's FPS shows about 30, because each 15 fps frame is detected twice (DECISIONS 25).
11. Stop the mock server with Ctrl+C. **Expected:** within about 6s the mock hand with "Lost the ESP32 stream" or "Can't reach the ESP32 stream". The text stays steady (no flicker) while it retries. Start the server again. **Expected:** the feed comes back by itself within 10s.
12. Press Ctrl+Opt+F twice to get back to Ready, then click the camera icon. **Expected:** the mock server logs "client left (0 watching)" right away. Click it again. **Expected:** "client connected (1 watching)" and the test pattern returns.
13. Stop the server and run `npm run mock:mjpeg` (no `--test`; it uses the Mac camera, and macOS may ask about camera access for the terminal). **Expected:** your hands are tracked with landmarks through the stream, as in step 3.
14. Try bad URLs in the URL field, one at a time:
    - `http://127.0.0.1:8081/` → "That URL isn't a camera stream — …"
    - `http://10.255.255.1/stream` → "Can't reach the ESP32 stream" after about 5s, not 8s.
    - `ftp://x/stream` → the field answers "Enter a URL starting with http://" and nothing is saved.
15. With the mock server running and the stream selected, press Ctrl+Opt+1 on the Camera source page. **Expected:** the server logs "client left (0 watching)" and the built-in camera appears.
16. Source-switch check. Set the URL to `http://10.255.255.1/stream` and wait about 30s, until "Can't reach the ESP32 stream" has shown through several retries. Press Ctrl+Opt+1 (MacBook camera). **Expected:** the ESP32 error disappears at once; the mock hand shows with no error until your camera appears. Revoke camera access first (step 8) and repeat. **Expected:** "Camera access denied…" right away, then a retry about 1s later, not 10s.
17. Relaunch with the ESP32 stream as the saved source. **Expected:** no macOS camera prompt at launch.
18. With a real ESP32-CAM (CameraWebServer sketch), enter `http://<ip>:81/stream`. **Expected:** it streams. Unplug it. **Expected:** "Lost the ESP32 stream" within about 5s; each reconnect attempt fails within about 5s while it stays unplugged. Plug it back in. **Expected:** it recovers on its own.

### Built app, proxy and screenshots

19. Run `npm run build && npm start`. **Expected:** the camera and hand tracking work as in step 3, with the assets loaded from `out/renderer/mediapipe` over file://.
20. While the app runs, find its proxy port with `lsof -iTCP -sTCP:LISTEN -P | grep -i electron`, then run `curl -i "http://127.0.0.1:<port>/mjpeg?url=http://127.0.0.1:8081/stream"`. **Expected:** `403 Forbidden` (no token).
21. Run `npm run screens`. **Expected:** all 32 screenshots show the mock hand, no FPS readout, and the camera light never turns on.
22. Terminal smoke test. Make a temp dir containing `settings.json` with `{"cameraSource":{"kind":"mjpeg","url":"http://127.0.0.1:8081/stream"},"cameraEnabled":true,"sensitivity":"medium","mode":"command"}`. With `npm run mock:mjpeg -- --test` running, run `npm run build`, then `FASTASL_LOG=1 FASTASL_DATA_DIR=<dir> node_modules/.bin/electron .` and quit after about 15s. **Expected:** stdout shows `[renderer:info] Graph successfully started running.` and then `[camera] live 640x480 · 30 fps · 0 hand(s)` lines (one per change), with no `[renderer:error]` lines.

### Missing files and broken settings

23. Missing MediaPipe files. With `npm run mock:mjpeg -- --test` running and the ESP32 stream selected, run `npm run build`, then `mv out/renderer/mediapipe /tmp/mediapipe-backup` and `FASTASL_LOG=1 node_modules/.bin/electron .`. **Expected:** the mock hand with "Hand tracking files are missing — run npm run setup" at the bottom of the feed, one `[camera] mock hand (Hand tracking files are missing — run npm run setup)` line in stdout, and the mock server logs no "client connected" while you wait 30s (the camera is never opened, nothing retries). Click the camera icon off and on. **Expected:** the same message comes back, still with no camera connection. Quit, `mv /tmp/mediapipe-backup out/renderer/mediapipe`, relaunch. **Expected:** the stream and landmarks work as in step 10.
24. The same in dev: move `src/renderer/public/mediapipe` away and run `npm run dev`. **Expected:** the same message, and with the built-in camera selected the camera light never turns on. Run `npm run setup` (or move the folder back), then click the camera icon off and on. **Expected:** the camera and tracking start.
25. Broken settings. Quit the app, then write `{"cameraEnabled":true,"cameraSource":null}` to `~/Library/Application Support/fastASL/settings.json` (or `FASTASL_DATA_DIR/settings.json`) and relaunch. **Expected:** the card and tray icon appear as usual and the built-in camera is used (Settings › Camera source shows "MacBook camera" checked). Repeat with `"cameraSource":{"kind":"mjpeg"}` (no URL). **Expected:** the same.

## Phase 3 — Gesture engine (hands-only control)

**Before you start**

- Phase 3 drives the card with your real hands. Signs are not recognized yet (Phase 4): where a step needs a phrase, add simulated signs with Ctrl+Opt+S. Services are still mocks, so no API keys are needed and nothing real is sent or run.
- Sit about 60 cm from the camera in even light, and check that the landmark lines sit on your hand before each step. Rest your hands out of view between steps.
- `FASTASL_LOG=1 npm run dev` prints one `[gesture] <gesture> in <view>` line to the terminal for every gesture that fires (for example `[gesture] fingers:2 in quickMenu`). Use it to tell "didn't fire" from "fired but did nothing".
- Automated: `npx vitest run src/renderer/src/engine/gestures src/renderer/src/app/engines.test.ts`. **Expected:** 5 files, 140 tests passed (123 engine and shape tests, plus 17 for the camera → engine → controller wiring).

### Wake, holds and picks

1. **Collapse and wake.** In Ready, hold a fist still for about 1 s. **Expected:** the card collapses to the pill. Lower your hand, then hold an open palm up, facing the camera, and keep it still. **Expected:** a ring around the round thumbnail fills over about 1 s and the card expands to Ready. Keep holding for 3 s. **Expected:** nothing else happens.
2. **Stillness.** Collapse again (fist), then slowly wave the open palm. **Expected:** the ring stays empty or keeps restarting. Stop waving. **Expected:** the card expands about 1 s later.
3. **Thumbs up.** In Ready, hold a thumbs-up for about 0.5 s. **Expected:** the quick menu opens. It also works with the palm facing sideways. Fist back to Ready, then hold an ASL "A" (thumb alongside the fist) for 2 s. **Expected:** nothing happens.
4. **Finger pick.** Open the quick menu (thumbs up) and hold up 2 fingers. **Expected:** row 2 highlights and the ring on its "2" badge fills; after about 0.8 s "Send message" is picked and Ready shows "Send message: sign the details". Repeat with 1 finger (Create event) and 3 fingers, both the index-middle-ring 3 and ASL 3 (thumb, index, middle). **Expected:** each picks its row. An open hand with a half-tucked thumb picks nothing.
5. **Fist across a view change.** In the quick menu, hold a fist for about 0.9 s. **Expected:** it cancels to Ready. Keep the fist up for 2 s more. **Expected:** the card stays in Ready (it does not collapse). Open or lower your hand for a moment, then make a fist again at least 1.5 s after the first. **Expected:** the card collapses.

### Swipes

6. **Mode swipes (Ready).** Rest a flat hand in view for a moment, then sweep it quickly about a third of the frame toward your own left (in the mirrored preview the hand moves left). **Expected:** the mode cycles backward (Command → Spell) and the header flashes the new mode. Rest for 2 s, then sweep right. **Expected:** it cycles forward (Spell → Command). Sweep right again. **Expected:** Dictation (red dot). Bringing the hand straight back right after any sweep does nothing.
7. **Dictation.** In Dictation, hold a fist about 0.9 s. **Expected:** back to Command, Ready.
8. **Settings and swipe follow-through.** In Ready, swipe up. **Expected:** Settings opens. Leave the open hand up and still for 2 s. **Expected:** option 5 (Sensitivity) is not picked. Lower the hand, then raise an open palm again and hold it still. **Expected:** Sensitivity opens after about 0.8 s. Hold a fist. **Expected:** back to the Settings list. Lower the hand (or relax it, partly closed; an open hand held still here picks option 5 again), then make a fist again at least 1.5 s after the first. **Expected:** Settings closes.
9. **Building a phrase.** In Ready (Command), press Ctrl+Opt+S three times. **Expected:** Building with "meeting tomorrow at". Swipe left. **Expected:** "at" is deleted. Raise a hand in view for a second, then lower both hands. **Expected:** about 1.2 s later, once, the Sentence card shows "Meeting tomorrow".
10. **Return stroke after a pause (Sentence).** Continuing from step 9, swipe left. **Expected:** "tomorrow" is deleted. Hold still about 1 s, then quickly move the hand back to the right. **Expected:** nothing; the sentence is not sent. Wait 2 s more, then swipe right deliberately. **Expected:** the sentence is sent (Agent ready appears about 0.5 s later, mock Claude). Hold a fist. **Expected:** cancels to Ready.
11. **Hand entering the view (Ready).** Start with no hands visible. Raise a flat hand quickly into view from below. **Expected:** Settings does not open. Slide a flat hand quickly in from the side of the frame. **Expected:** the mode does not change. Hold the hand still about 0.3 s, then swipe up. **Expected:** Settings opens.
12. **Swipes that should be ignored.** In Ready, try a slow drag across the frame, a fast sweep with a fist, one with a pointing finger, and a diagonal sweep. **Expected:** nothing happens.

### Signing, sensitivity and other cases

13. **Second hand appearing (Collapsed).** Hold an open palm still. Halfway through the ring, bring your other hand into view beside it and keep it still. **Expected:** the ring keeps filling, the card expands about 1 s after the first hand stopped, and no swipe fires.
14. **Signing doesn't trigger controls.** Press Option+2 (Recognizing) and sign normally for about 10 s, including WORK and fingerspelled A and S. **Expected:** no cancel, delete or end of phrase; the card stays in Recognizing. Lower both hands. **Expected:** the phrase ends about 1.2 s later, once (with no recognized signs yet it returns to Ready).
15. **Sensitivity.** Settings › Sensitivity, hold 1 finger (Low). **Expected:** the wake in step 1 takes about 1.35 s and swipes need bigger strokes. Pick High (3 fingers). **Expected:** about 0.75 s, and smaller swipes work. Set it back to Medium (2 fingers).
16. **Peace sign (Ready).** Hold a V for about 0.8 s. **Expected:** the screenshot shortcut's toast (mock, nothing is captured). Keep holding through the toast until you are back in Ready. **Expected:** it does not run again. Lower the hand and make the V again. **Expected:** it runs again.
17. **Camera source.** Run `npm run mock:mjpeg` (your Mac camera through the ESP32 stand-in, 15 fps) and pick the ESP32 stream in Settings › Camera source. Repeat steps 1, 4 and 6. **Expected:** the same behavior. The FPS readout shows about 30 (the detection rate; each stream frame is tracked twice, see DECISIONS 48). Reach Sentence as in step 9, then move a flat hand sideways at an even, moderate pace, about half the frame in half a second, the way you would reposition it. **Expected:** nothing happens (no word deleted, the sentence is not sent), the same as with the MacBook camera. A quick sweep still swipes.
18. **Camera restart.** In Ready, click the camera icon off and on again (or switch between the MacBook camera and the ESP32 stream). **Expected:** once the feed is back, steps 1 and 4 work as before (the engine starts fresh for every camera session).
19. **Dropouts during a hold.** During a palm hold in Collapsed, briefly pass your other hand in front of the held hand. **Expected:** a dropout of a frame or two doesn't reset the ring. A longer one, or your other hand moving in view, may restart it; the card then expands about 1 s after the palm is back and every hand in view is still.
20. **A held thumbs-up acts once.** Reach Sentence as in step 9. Hold a thumbs-up and keep it up for about 5 s, and partway through dip it out of view or cover it for a moment. **Expected:** the sentence is sent once (Agent ready appears about 0.5 s later) and the card stays on Agent ready: the agent does not start. Lower the hand, then hold a thumbs-up again. **Expected:** the agent starts (Working, mock calendar steps). Right away, lower the hand and raise a thumbs-up again while Working is shown (the confirm card appears about 1.4 s after the agent starts), and keep it up until the confirm card ("Team Sync") appears and for 2 s more. **Expected:** the confirm card stays: a gesture already up when a card appears does nothing there. Lower the hand and give a new thumbs-up. **Expected:** approved; Working continues and ends on "Meeting created" (mock, nothing is created).
21. **Dev simulation still works.** With the camera on, press Ctrl+Opt+T in Ready (quick menu), then Ctrl+Opt+2 (picks Send message). Press Option+9, then Ctrl+Opt+P. **Expected:** each acts at once, as in Phase 1.
22. **Screenshots.** Run `npm run screens`. **Expected:** the screenshots are unchanged (mock hand, the scenes' own palm-hold and pick rings) and the camera light never turns on.
