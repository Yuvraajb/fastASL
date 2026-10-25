import type { LlmProviderName, Result } from '@shared/types'
import { claudeSource } from '../claude/structured'
import type { ClaudeProvider } from '../claude/client'
import { geminiSignModel, geminiSource, type GeminiProvider } from './gemini'
import { localSource, type LocalChat, type LocalConfig, type LocalShow } from './local'
import { mockLlm } from './mock'
import type { LlmSource } from './structured'

export const LLM_PROVIDERS: readonly LlmProviderName[] = ['claude', 'gemini', 'local', 'mock', 'droid']

/** LLM_PROVIDER, trimmed and case-insensitive. Unset or blank is claude; anything else unknown is an error. */
export function parseLlmProvider(raw: string | undefined): Result<LlmProviderName> {
  const value = raw?.trim().toLowerCase() ?? ''
  if (!value) return { ok: true, value: 'claude' }
  const known = LLM_PROVIDERS.find((p) => p === value)
  return known
    ? { ok: true, value: known }
    : { ok: false, error: `Unknown LLM_PROVIDER "${raw?.trim()}": use claude, gemini, local, mock or droid` }
}

/** Transports to use instead of the real clients (tests). */
export interface LlmOverrides {
  claude?: ClaudeProvider
  gemini?: GeminiProvider
  geminiModel?: () => string
  /** The Gemini model of identifySign (GEMINI_SIGN_MODEL). */
  geminiSignModel?: () => string
  localChat?: (url: string) => LocalChat
  localConfig?: () => LocalConfig
  localShow?: (url: string) => LocalShow
}

/**
 * The model behind a provider. An unknown provider answers every call with its error: nothing
 * falls back. `vision` is the model that looks at camera frames (identifySign): on Gemini it is
 * GEMINI_SIGN_MODEL; the other providers use their one model.
 */
export function llmSource(
  provider: Result<LlmProviderName>,
  overrides: LlmOverrides = {},
  use: 'text' | 'vision' = 'text'
): LlmSource {
  if (!provider.ok) {
    const { error } = provider
    return () => ({ ok: false, error })
  }
  switch (provider.value) {
    case 'claude':
      return claudeSource(overrides.claude)
    case 'gemini':
      // Sign guesses never fall back to the text model: Flash-Lite can't name signs (DECISIONS 141).
      return use === 'vision'
        ? geminiSource(overrides.gemini, overrides.geminiSignModel ?? geminiSignModel, 'GEMINI_SIGN_MODEL')
        : geminiSource(overrides.gemini, overrides.geminiModel)
    case 'local':
      return localSource(overrides.localChat, overrides.localConfig, overrides.localShow)
    case 'mock':
      return () => ({ ok: true, value: mockLlm })
    case 'droid':
      // No separate LLM: createLlmService answers interpret itself and the Droid agent reads the signs.
      return () => ({ ok: false, error: 'LLM_PROVIDER=droid has no separate model' })
  }
}
