# fastASL

## LLM provider

`LLM_PROVIDER` in `.env` picks the model that turns signing into a sentence and an intent, suggests spellings, and guesses a sign it doesn't know yet from a few camera frames ("Is this HELLO?"):

- `LLM_PROVIDER=claude` is the demo and submission setting, needed for the Anthropic track. It uses `ANTHROPIC_API_KEY` and is the default when `LLM_PROVIDER` is unset.
- `LLM_PROVIDER=gemini` is for free testing. It uses `GEMINI_API_KEY`, plus `GEMINI_MODEL` (optional, default `gemini-3.5-flash-lite`). Sign guesses use `GEMINI_SIGN_MODEL` (optional, default `gemini-3.5-flash`).
- `LLM_PROVIDER=local` runs Ollama on your Mac with no key. It uses `LOCAL_LLM_URL` (default `http://127.0.0.1:11434`) and `LOCAL_LLM_MODEL` (default `llama3.2`). Sign guesses need a vision model there (for example `llava`); otherwise they are off with a short message.
- `LLM_PROVIDER=mock` gives canned answers, with no key and no network.

Restart the app after changing `.env`. In `npm run dev`, the card's footer shows the active provider.

Camera frames leave the Mac only for sign guesses, and only on `claude`, `gemini`, or `local` with `LOCAL_LLM_URL` set to another machine. See DECISIONS, "Guess, confirm, learn".
