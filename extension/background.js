// Passes what content.js saw to the Manga Index app on this computer. While the app is closed the
// reports wait here and go once it is open again, so nothing read in the meantime is lost. It also
// shows the new chapters the app found on the works' sites.

const APP = 'http://127.0.0.1:47321'
const QUEUE_LIMIT = 1000

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'reading') return
  deliver(message.report, sender.tab?.id)
})

chrome.runtime.onStartup.addListener(() => {
  flush()
  checkUpdates()
})
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('flush', { periodInMinutes: 1 })
  chrome.alarms.create('updates', { periodInMinutes: 30 })
  flush()
  checkUpdates()
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'flush') flush()
  if (alarm.name === 'updates') checkUpdates()
})

/** Each new chapter once: the app also announces it in Windows, so this only covers what it has not shown here. */
async function checkUpdates() {
  let updates
  try {
    const response = await fetch(`${APP}/updates`)
    if (!response.ok) return
    updates = await response.json()
  } catch {
    return
  }
  const { shown = {} } = await chrome.storage.local.get('shown')
  for (const update of updates) {
    if ((shown[update.workId] ?? 0) >= update.latest) continue
    shown[update.workId] = update.latest
    chrome.notifications.create(`update:${update.workId}:${update.latest}`, {
      type: 'basic',
      iconUrl: 'icon.png',
      title: `Capítulo novo: ${update.work}`,
      message: `Capítulo ${update.latest} em ${update.site}`
    })
    links[`update:${update.workId}:${update.latest}`] = update.url
  }
  links = Object.fromEntries(Object.entries(links).slice(-50))
  await chrome.storage.local.set({ shown, links })
}

// The page each notification opens; kept in storage, since the service worker sleeps between alarms.
let links = {}
chrome.storage.local.get('links').then(({ links: stored = {} }) => (links = { ...stored, ...links }))

chrome.notifications.onClicked.addListener(async (id) => {
  const { links: stored = {} } = await chrome.storage.local.get('links')
  const url = links[id] ?? stored[id]
  if (url) chrome.tabs.create({ url })
  chrome.notifications.clear(id)
})

async function post(body) {
  const response = await fetch(`${APP}/reading`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function deliver(report, tabId) {
  try {
    const result = await post(report)
    if (tabId !== undefined) badge(tabId, result)
    flush()
  } catch {
    await enqueue(report)
    if (tabId !== undefined) {
      chrome.action.setBadgeText({ tabId, text: '!' })
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#777' })
      chrome.action.setTitle({ tabId, title: 'Manga Index fechado: este capítulo será marcado quando o app abrir.' })
    }
  }
}

function badge(tabId, result) {
  if (!result) {
    chrome.action.setBadgeText({ tabId, text: '' })
    return
  }
  const read = result.status === 'read'
  const where = `${result.work} — capítulo ${result.chapter}`
  chrome.action.setBadgeText({ tabId, text: read ? '✓' : result.progress !== null ? `${Math.round(result.progress * 100)}%` : '…' })
  chrome.action.setBadgeBackgroundColor({ tabId, color: read ? '#2e9d4f' : '#c08a1e' })
  chrome.action.setTitle({ tabId, title: read ? `${where}: lido` : `${where}: em andamento` })
}

/** Keeps the latest report of each page only. */
async function enqueue(report) {
  const { queue = [] } = await chrome.storage.local.get('queue')
  const kept = queue.filter((r) => r.url !== report.url)
  kept.push(report)
  await chrome.storage.local.set({ queue: kept.slice(-QUEUE_LIMIT) })
}

let flushing = false

async function flush() {
  if (flushing) return
  flushing = true
  try {
    const { queue = [] } = await chrome.storage.local.get('queue')
    if (!queue.length) return
    await post(queue)
    // Reports queued while this one was being sent stay for the next time.
    const { queue: now = [] } = await chrome.storage.local.get('queue')
    await chrome.storage.local.set({ queue: now.filter((r) => !queue.some((q) => q.url === r.url && q.at === r.at)) })
  } catch {
    // The app is still closed.
  } finally {
    flushing = false
  }
}
