import type { EvalConfig } from '../../../shared/types'
import { looksLikeNovel } from './novel'
import { TranslationJob } from './pipeline'

/** Chapters whose first pages are all missing from the cache were translated by older code: skipped. */
const PROBE_PAGES = 2

/**
 * Rebuilding the training dataset (MI_REPLAY_LIBRARY, MI_CACHE_ONLY=1): every library chapter is
 * detected and sent again; the same request finds the answer it got before in the translation cache,
 * and main/translate/dataset keeps it. No model is called, nothing is drawn.
 */
export async function runReplay(config: EvalConfig): Promise<void> {
  const api = window.api.evaluation
  const log = (message: string) => void api.log(message)
  const chapters = config.replay ?? []
  let total = 0
  try {
    for (const [i, chapter] of chapters.entries()) {
      if (config.replayPages && total >= config.replayPages) break
      const started = performance.now()
      const job = await TranslationJob.open(await api.read(chapter.pdf), () => {})
      if (await looksLikeNovel(job.doc)) {
        job.dispose()
        await api.replayed(chapter.id)
        log(`[${i + 1}/${chapters.length}] ${chapter.title}: a novel, left out`)
        continue
      }
      job.chapter = chapter.title
      let found = 0
      let missing = 0
      for (let n = 1; n <= job.numPages; n++) {
        if (n > PROBE_PAGES && found === 0) break
        try {
          await job.readPage(n)
          found++
        } catch {
          missing++
        }
      }
      job.dispose()
      total += found
      // A chapter with nothing found is tried again next run: a wrong setting must not hide it for good.
      if (found) await api.replayed(chapter.id)
      log(`[${i + 1}/${chapters.length}] ${chapter.title}: ${found} pages kept, ${missing} not in the cache (${Math.round((performance.now() - started) / 1000)}s; ${total} so far)`)
    }
  } catch (err) {
    log(`FAILED: ${(err as Error).stack ?? err}`)
  } finally {
    await api.done()
  }
}
