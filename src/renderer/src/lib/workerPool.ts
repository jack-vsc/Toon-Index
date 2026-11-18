/**
 * A few workers taking jobs in turn. A job's reply is `{ id, result }` or `{ id, error }`; any other
 * message a worker sends (a request it needs the window for) goes to `onRequest`.
 */
export interface WorkerPool {
  run<T>(message: object, transfer?: Transferable[]): Promise<T>
}

interface Slot {
  worker: Worker
  busy: boolean
  /** The job it is on, failed when the worker dies. */
  reject?: (e: Error) => void
}

export function workerPool(
  create: () => Worker,
  size: number,
  onRequest?: (message: { request: string } & Record<string, unknown>, worker: Worker) => void
): WorkerPool {
  const slots: Slot[] = []
  const waiting: (() => void)[] = []
  const replies = new Map<number, (data: { result?: unknown; error?: string }) => void>()
  let nextId = 0

  function spawn(): Slot {
    const slot: Slot = { worker: create(), busy: false }
    slot.worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { id?: number; request?: string; result?: unknown; error?: string }
      if (data.request) return onRequest?.(data as { request: string }, slot.worker)
      replies.get(data.id!)?.(data)
      replies.delete(data.id!)
    }
    // A worker that died fails its job; a new one takes its place on the next.
    slot.worker.onerror = (e) => {
      e.preventDefault()
      slots.splice(slots.indexOf(slot), 1)
      slot.worker.terminate()
      slot.reject?.(new Error(e.message || 'o worker parou'))
    }
    slots.push(slot)
    return slot
  }

  async function take(): Promise<Slot> {
    for (;;) {
      const free = slots.find((s) => !s.busy)
      if (free) return free
      if (slots.length < size) return spawn()
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
  }

  return {
    async run<T>(message: object, transfer: Transferable[] = []): Promise<T> {
      const slot = await take()
      slot.busy = true
      const id = nextId++
      try {
        return await new Promise<T>((resolve, reject) => {
          slot.reject = reject
          replies.set(id, (data) => (data.error !== undefined ? reject(new Error(data.error)) : resolve(data.result as T)))
          slot.worker.postMessage({ ...message, id }, transfer)
        })
      } finally {
        replies.delete(id)
        slot.busy = false
        slot.reject = undefined
        waiting.shift()?.()
      }
    }
  }
}

/** Workers to keep the window free: a couple of cores stay for it and the rest of the PC. */
export const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2))
