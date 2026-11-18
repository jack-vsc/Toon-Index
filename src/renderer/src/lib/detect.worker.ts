/// <reference lib="webworker" />
import { detectTextIn } from './detect'

/** Finds the text on one image's pixels, sent by detectWorkers.ts. */
self.onmessage = (e: MessageEvent<{ id: number; data: Uint8ClampedArray; width: number; height: number }>) => {
  const { id, data, width, height } = e.data
  try {
    self.postMessage({ id, result: detectTextIn(data, width, height) })
  } catch (err) {
    self.postMessage({ id, error: String((err as Error).message ?? err) })
  }
}
