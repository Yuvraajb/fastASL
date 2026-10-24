/**
 * The pretrained sign models' vocabulary: the one place to edit which signs they recognize.
 *
 * - `islr`: the sign's label in the Kaggle "asl-signs" 1st-place model (MIT, 250 signs,
 *   models/islr1st.onnx, see MODEL_LICENSE.md). This model is always there.
 * - `citizen`: the sign's glosses (variants) in Microsoft's ASL Citizen ST-GCN (2731 signs,
 *   research licence, installed only by `npm run setup:citizen`, never committed).
 * - `enabled`: the models' softmax runs over the enabled words only, so each one enabled is
 *   also a competitor for every other. DECISIONS.md (Pretrained sign model) has the per-word
 *   accuracy behind these flags.
 *
 * `word` is what the token shows and types (lower case, like taught words' tokens); the LLM
 * sees it upper-cased as a known sign ("THANK YOU"), so a confirmed guess learns the same label.
 */
export interface SignWord {
  word: string
  islr?: string
  citizen?: readonly string[]
  enabled: boolean
}

export const SIGN_VOCABULARY: readonly SignWord[] = [
  // The demo vocabulary: both models know these, the Kaggle model decides them.
  { word: 'hello', islr: 'hello', citizen: ['HELLO'], enabled: true },
  { word: 'thank you', islr: 'thankyou', citizen: ['THANKYOU'], enabled: true },
  { word: 'yes', islr: 'yes', citizen: ['YES'], enabled: true },
  { word: 'no', islr: 'no', citizen: ['NO'], enabled: true },
  { word: 'please', islr: 'please', citizen: ['PLEASE'], enabled: true },
  { word: 'call', islr: 'callonphone', citizen: ['PHONE', 'CALL1', 'CALL2'], enabled: true },
  { word: 'tomorrow', islr: 'tomorrow', citizen: ['TOMORROW'], enabled: true },
  { word: 'time', islr: 'time', citizen: ['TIME'], enabled: true },
  { word: 'open', islr: 'open', citizen: ['OPEN'], enabled: true },
  { word: 'where', islr: 'where', citizen: ['WHERE'], enabled: true },
  { word: 'now', islr: 'now', citizen: ['NOW'], enabled: true },
  { word: 'later', islr: 'later', citizen: ['LATER'], enabled: true },
  { word: 'bad', islr: 'bad', citizen: ['BAD'], enabled: true },
  { word: 'water', islr: 'water', citizen: ['WATER'], enabled: true },
  { word: 'eat', islr: 'food', citizen: ['EAT1', 'EAT2'], enabled: true },
  // Extras.
  { word: 'finish', islr: 'finish', citizen: ['FINISH'], enabled: true },
  { word: 'wait', islr: 'wait', citizen: ['WAIT'], enabled: true },
  // Off: GO read as LATER 2 times in 12, and LATER moved in on other signs.
  { word: 'go', islr: 'go', citizen: ['GO'], enabled: false },
  { word: 'bye', islr: 'bye', citizen: ['BYE'], enabled: true },
  { word: 'see', islr: 'see', citizen: ['SEE'], enabled: true },
  { word: 'look', islr: 'look', citizen: ['LOOKAT'], enabled: true },
  { word: 'listen', islr: 'listen', citizen: ['LISTEN'], enabled: true },
  { word: 'home', islr: 'home', citizen: ['HOME'], enabled: true },
  { word: 'close', islr: 'close', citizen: ['CLOSE'], enabled: true },
  { word: 'who', islr: 'who', citizen: ['WHO'], enabled: true },
  { word: 'why', islr: 'why', citizen: ['WHY'], enabled: true },
  { word: 'drink', islr: 'drink', citizen: ['DRINK1', 'DRINK2'], enabled: true },
  { word: 'happy', islr: 'happy', citizen: ['HAPPY'], enabled: true },
  // Off: with ASL Citizen on, FINE took 10 of the signs left out of the list.
  { word: 'fine', islr: 'fine', citizen: ['FINE1', 'FINE2'], enabled: false },
  { word: 'yesterday', islr: 'yesterday', citizen: ['YESTERDAY'], enabled: true },
  // Off: known weak on the Kaggle model.
  { word: 'morning', islr: 'morning', citizen: ['MORNING'], enabled: false },
  { word: 'night', islr: 'night', citizen: ['NIGHT1', 'NIGHT2'], enabled: true },
  { word: 'sleep', islr: 'sleep', citizen: ['SLEEP'], enabled: true },
  { word: 'think', islr: 'think', citizen: ['THINK'], enabled: true },
  { word: 'like', islr: 'like', citizen: ['LIKE'], enabled: true },
  { word: 'dad', islr: 'dad', citizen: ['FATHER'], enabled: true },
  { word: 'mom', islr: 'mom', citizen: ['MOTHER'], enabled: true },
  // Only ASL Citizen knows these: recognized only once `npm run setup:citizen` has run.
  { word: 'help', citizen: ['HELP'], enabled: true },
  { word: 'more', citizen: ['MORE'], enabled: true },
  { word: 'email', citizen: ['EMAIL'], enabled: true },
  { word: 'mail', citizen: ['MAIL1', 'MAIL2'], enabled: true },
  { word: 'send', citizen: ['SEND'], enabled: true },
  { word: 'music', citizen: ['MUSIC'], enabled: true },
  { word: 'play', citizen: ['PLAY'], enabled: true },
  { word: 'meeting', citizen: ['MEETING'], enabled: true },
  { word: 'stop', citizen: ['STOP'], enabled: true },
  { word: 'what', citizen: ['WHAT1', 'WHAT2'], enabled: true },
  // Off: GOOD and THANK YOU are nearly the same sign, and the Kaggle model read all 12 GOODs as THANK YOU.
  { word: 'good', citizen: ['GOOD'], enabled: false }
]

/** The enabled words a model scores: those with a label in it. */
export function enabledFor(model: 'islr' | 'citizen', vocabulary: readonly SignWord[] = SIGN_VOCABULARY): SignWord[] {
  return vocabulary.filter((w) => w.enabled && (model === 'islr' ? w.islr !== undefined : (w.citizen?.length ?? 0) > 0))
}

/**
 * The enabled words as the LLM's known signs (upper case, like taught words' labels): a guess
 * names them the way the models do. `citizen`: whether the ASL Citizen model is installed (its
 * words are known only then).
 */
export function knownSigns(citizen: boolean, vocabulary: readonly SignWord[] = SIGN_VOCABULARY): string[] {
  return vocabulary.filter((w) => w.enabled && (w.islr !== undefined || citizen)).map((w) => w.word.toUpperCase())
}
