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
