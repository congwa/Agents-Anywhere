import { convertPrompt, buildReplay } from '@openma/pi-acp'
import type { NativeVocabulary } from '../../application/ports.js'

/** Only the package root's published exports enter this anti-corruption layer. */
export const openmaVocabulary: NativeVocabulary = {
  prompt: blocks => convertPrompt(blocks, { images: false }),
  replay: (entries, cwd) => buildReplay(entries, cwd).updates,
}
