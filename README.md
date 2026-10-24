# fastASL

## LLM provider

`LLM_PROVIDER` in `.env` picks the model that turns signing into a sentence and an intent (and suggests spellings):

- `LLM_PROVIDER=claude` is the demo and submission setting, needed for the Anthropic track. It uses `ANTHROPIC_API_KEY` and is the default when `LLM_PROVIDER` is unset.
- `LLM_PROVIDER=gemini` is for free testing. It uses `GEMINI_API_KEY`, plus `GEMINI_MODEL` (optional, default `gemini-3.5-flash-lite`).
- `LLM_PROVIDER=local` runs Ollama on your Mac with no key. It uses `LOCAL_LLM_URL` (default `http://127.0.0.1:11434`) and `LOCAL_LLM_MODEL` (default `llama3.2`).
- `LLM_PROVIDER=mock` gives canned answers, with no key and no network.

Restart the app after changing `.env`. In `npm run dev`, the card's footer shows the active provider.
