import type { LlmProviderName, Result } from '@shared/types'
import { claudeSource } from '../claude/structured'
import type { ClaudeProvider } from '../claude/client'
import { geminiSource, type GeminiProvider } from './gemini'
import { localSource, type LocalChat, type LocalConfig } from './local'
import { mockLlm } from './mock'
import type { LlmSource } from './structured'

export const LLM_PROVIDERS: readonly LlmProviderName[] = ['claude', 'gemini', 'local', 'mock']

/** LLM_PROVIDER, trimmed and case-insensitive. Unset or blank is claude; anything else unknown is an error. */
export function parseLlmProvider(raw: string | undefined): Result<LlmProviderName> {
  const value = raw?.trim().toLowerCase() ?? ''
  if (!value) return { ok: true, value: 'claude' }
  const known = LLM_PROVIDERS.find((p) => p === value)
  return known
    ? { ok: true, value: known }
    : { ok: false, error: `Unknown LLM_PROVIDER "${raw?.trim()}": use claude, gemini, local or mock` }
}

/** Transports to use instead of the real clients (tests). */
export interface LlmOverrides {
  claude?: ClaudeProvider
  gemini?: GeminiProvider
  geminiModel?: () => string
  localChat?: (url: string) => LocalChat
  localConfig?: () => LocalConfig
}

/** The model behind a provider. An unknown provider answers every call with its error: nothing falls back. */
export function llmSource(provider: Result<LlmProviderName>, overrides: LlmOverrides = {}): LlmSource {
  if (!provider.ok) {
    const { error } = provider
    return () => ({ ok: false, error })
  }
  switch (provider.value) {
    case 'claude':
      return claudeSource(overrides.claude)
    case 'gemini':
      return geminiSource(overrides.gemini, overrides.geminiModel)
    case 'local':
      return localSource(overrides.localChat, overrides.localConfig)
    case 'mock':
      return () => ({ ok: true, value: mockLlm })
  }
}
