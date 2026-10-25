import { existsSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DICTIONARY } from '@shared/dictionary'
import { formatReport, replayAll, replayStream, streamReport } from './streamEval'
import { STREAM_RULES } from './streamRules'
import { StreamingSignMatcher } from './streaming'

/*
 * Replays real ASL Citizen clips through the streaming signs (the dictionary, then the stream
 * rules) and reports, per word: recall, other streaming words fired on its clips, false fires
 * on every other gloss's clips, and how early the word fires. Adapted from the teammate's
 * version (asl-dictionary-chat, commit 220f562) to the clip folders streamEval.ts reads.
 * Skipped unless FASTASL_STREAM_DATA names the folders (comma separated), e.g.
 *   FASTASL_STREAM_DATA=~/data/asl-citizen/tracked npx vitest run aslcitizen.eval
 * The data is non-commercial research data: it stays outside the repo and nothing here uploads it.
 */

const DIRS = (process.env.FASTASL_STREAM_DATA ?? '')
  .split(',')
  .map((d) => d.trim().replace(/^~/, process.env.HOME ?? ''))
  .filter((d) => d && existsSync(d))

describe.skipIf(DIRS.length === 0)('ASL Citizen replay through the streaming signs', () => {
  it('reports recall, false fires and fire time per word', () => {
    const options = { dictionary: DEFAULT_DICTIONARY, rules: STREAM_RULES }
    const words = new StreamingSignMatcher(options).words
    for (const dir of DIRS) {
      const results = replayAll([dir], (clip) => replayStream(clip, options))
      console.log(`\n== ${dir}: ${results.length} clips\n${formatReport(streamReport(results, words))}`)
      expect(results.length).toBeGreaterThan(0)
    }
  }, 600_000)
})
