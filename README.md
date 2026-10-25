# fastASL

## Sign recognition

Signs are recognized out of the box by a pretrained model, with nothing to teach. `npm install` (or `npm run setup`) fetches what it needs next to the app: onnxruntime-web's wasm, and MediaPipe's face and pose models.

- **Built in:** the Kaggle "asl-signs" 1st-place model (MIT, 250 signs; `src/renderer/public/models/islr1st.onnx`, see `MODEL_LICENSE.md` there). It knows hello, thank you, yes, no, please, call, tomorrow, time, open, where, now, later, bad, water, eat and about 20 more. The list is in `src/renderer/src/engine/model/vocabulary.ts`.
- **Optional:** Microsoft's ASL Citizen model adds help, more, email, mail, send, music, play, meeting, stop and what. Run `npm run setup:citizen`. It downloads the official weights (about 29.8 MB in all) and converts them on your Mac. Its licence allows non-commercial research use only, with no redistribution. So it is never committed (`src/renderer/public/models/asl-citizen/` is gitignored), and a build made with it installed must not be shared.
- **Fallbacks:** signs you teach (Settings › Teach a sign) still cover words neither model knows.

See DECISIONS, "Pretrained sign model", for accuracy and how it fits with gestures.

## LLM provider

`LLM_PROVIDER` in `.env` picks the model that turns signing into a sentence and an intent, suggests spellings:

- `LLM_PROVIDER=claude` is the demo and submission setting, needed for the Anthropic track. It uses `ANTHROPIC_API_KEY` and is the default when `LLM_PROVIDER` is unset.
- `LLM_PROVIDER=gemini` is for free testing. It uses `GEMINI_API_KEY`, plus `GEMINI_MODEL` (optional, default `gemini-3.5-flash-lite`). Sign guesses use `GEMINI_SIGN_MODEL` (optional, default `gemini-3.5-flash`).
- `LLM_PROVIDER=local` runs Ollama on your Mac with no key. It uses `LOCAL_LLM_URL` (default `http://127.0.0.1:11434`) and `LOCAL_LLM_MODEL` (default `llama3.2`). Sign guesses need a vision model there (for example `llava`); otherwise they are off with a short message.
- `LLM_PROVIDER=mock` gives canned answers, with no key and no network.

Restart the app after changing `.env`. In `npm run dev`, the card's footer shows the active provider.

Camera frames leave the Mac only for sign guesses, and only on `claude`, `gemini`, or `local` with `LOCAL_LLM_URL` set to another machine. See DECISIONS, "Guess, confirm, learn".
