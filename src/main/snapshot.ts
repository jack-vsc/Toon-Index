import { app, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Developer screenshots without showing the window (it would take the focus from whatever is in front):
 * MI_SNAPSHOT (PNG path), MI_SNAPSHOT_CLICK (CSS selector of a button to click first),
 * MI_SNAPSHOT_SCRIPT (JavaScript to run in the page first, e.g. to fill a field), MI_SNAPSHOT_WAIT
 * (milliseconds to wait before the capture) and MI_SNAPSHOT_HEIGHT (window height, to take in more of a
 * long page; a hidden window does not scroll). The app quits afterwards.
 */
export function snapshotRequested(): boolean {
  return !!process.env.MI_SNAPSHOT
}

export function takeSnapshot(win: BrowserWindow): void {
  const out = resolve(process.env.MI_SNAPSHOT!)
  const click = process.env.MI_SNAPSHOT_CLICK
  const wait = Number(process.env.MI_SNAPSHOT_WAIT) || 2_000
  const height = Number(process.env.MI_SNAPSHOT_HEIGHT)
  if (height) win.setContentSize(win.getContentSize()[0], height)
  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(1_500)
      if (process.env.MI_SNAPSHOT_SCRIPT) {
        const result = await win.webContents.executeJavaScript(process.env.MI_SNAPSHOT_SCRIPT)
        if (result !== undefined) console.log(`[snapshot] script: ${JSON.stringify(result)}`)
      }
      if (click) await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(click)})?.click()`)
      await sleep(wait)
      const image = await win.webContents.capturePage()
      await writeFile(out, image.toPNG())
      console.log(`[snapshot] ${out}`)
    } catch (err) {
      console.error('[snapshot] failed:', err)
    } finally {
      app.quit()
    }
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
