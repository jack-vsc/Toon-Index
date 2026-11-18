// The button's window: the work of the page open (its reading list, favorite, marking the chapter
// read) and the works to go back to. Everything comes from the app on this computer.

const APP = 'http://127.0.0.1:47321'
const SHELVES = { reading: 'Lendo', plan: 'Quero ler', paused: 'Pausado', done: 'Concluído', dropped: 'Abandonado' }

const $ = (id) => document.getElementById(id)

async function call(path, body) {
  const response = await fetch(`${APP}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

const label = (n) => String(n).replace('.', ',')

let tab = null
/** The page as its tracker reads it: the work and chapter from the page itself, and the work's own page. */
let seen = { title: '', workUrl: null }

const page = () => ({ url: tab.url, title: seen.title || tab.title || '', ...(seen.workUrl && { workUrl: seen.workUrl }) })

/** What the tracker in the tab reads; the tab's title when it cannot answer (a page opened before the extension). */
async function readPage() {
  try {
    const answer = await chrome.tabs.sendMessage(tab.id, { type: 'page' })
    if (answer?.title) seen = answer
  } catch {
    seen = { title: tab.title ?? '', workUrl: null }
  }
}

function showPage(info) {
  $('page').hidden = false
  $('pageError').hidden = true
  $('work').textContent = info.name || 'Esta página não parece ser de uma obra'
  const where = []
  if (info.chapter !== null) where.push(`capítulo ${label(info.chapter)}`)
  if (info.readUpTo !== null) where.push(`lido até o ${label(info.readUpTo)}`)
  if (info.inLibrary) where.push(`${info.inLibrary} na biblioteca`)
  if (!info.workId && info.name) where.push('ainda não está na biblioteca')
  $('where').textContent = where.join(' · ')

  const shelf = $('shelf')
  shelf.replaceChildren(
    new Option(info.workId ? 'Em nenhuma lista' : 'Adicionar a uma lista…', ''),
    ...Object.entries(SHELVES).map(([key, name]) => new Option(name, key))
  )
  shelf.value = info.shelf ?? ''
  shelf.disabled = !info.name
  $('favorite').textContent = info.favorite ? '★' : '☆'
  $('favorite').classList.toggle('on', info.favorite)
  $('favorite').disabled = !info.name
  $('favorite').dataset.on = info.favorite ? '1' : ''

  const mark = $('markRead')
  const unread = info.chapter !== null && (info.readUpTo === null || info.chapter > info.readUpTo)
  mark.hidden = !unread
  mark.textContent = `Marcar o capítulo ${label(info.chapter ?? 0)} como lido`
  // As on the PC and the phone: this chapter and every one before it.
  const upTo = $('readUpTo')
  upTo.hidden = !unread || info.chapter <= 1
  upTo.textContent = 'Lidos até aqui'
}

function pageError(message) {
  $('pageError').hidden = false
  $('pageError').textContent = message
}

async function bookmark(patch) {
  try {
    showPage(await call('/bookmark', { ...page(), ...patch }))
    loadContinue()
  } catch (err) {
    pageError(err.message)
  }
}

$('shelf').addEventListener('change', (e) => bookmark({ shelf: e.target.value || null }))
$('favorite').addEventListener('click', () => bookmark({ favorite: !$('favorite').dataset.on }))
$('markRead').addEventListener('click', async () => {
  try {
    await call('/reading', { ...page(), progress: 1, finished: true, at: Date.now() })
    showPage(await call('/page', page()))
    loadContinue()
  } catch (err) {
    pageError(err.message)
  }
})
$('readUpTo').addEventListener('click', async () => {
  try {
    showPage(await call('/read-up-to', page()))
    loadContinue()
  } catch (err) {
    pageError(err.message)
  }
})

function open(url) {
  chrome.tabs.create({ url })
  window.close()
}

async function loadContinue() {
  const list = $('continue')
  const items = await call('/continue')
  if (!items.length) {
    list.innerHTML = '<div class="muted">Os capítulos que você lê aparecem aqui.</div>'
    return
  }
  list.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('div')
      row.className = 'item'
      const text = document.createElement('div')
      text.className = 'item-text'
      const name = document.createElement('div')
      name.className = 'item-name'
      name.textContent = `${item.favorite ? '★ ' : ''}${item.name}`
      name.title = item.name
      const where = document.createElement('div')
      where.className = 'muted small'
      where.textContent = `cap. ${label(item.chapter)}${item.shelf && item.shelf !== 'reading' ? ` · ${SHELVES[item.shelf]}` : ''}`
      // New only when it came out in the last 7 days, as in the app's Novidades; older ones are just there.
      if (item.latest) {
        const fresh = document.createElement('span')
        fresh.className = item.latest.recent ? 'new' : 'muted'
        fresh.textContent = item.latest.recent ? ` · NOVO ${label(item.latest.chapter)}` : ` · saiu o ${label(item.latest.chapter)}`
        where.append(fresh)
      }
      text.append(name, where)
      const go = document.createElement('button')
      go.textContent = 'Continuar'
      go.addEventListener('click', () => open(item.url))
      row.append(text, go)
      if (item.latest) {
        const next = document.createElement('button')
        next.className = 'ghost'
        next.textContent = `Cap. ${label(item.latest.chapter)}`
        next.addEventListener('click', () => open(item.latest.url))
        row.append(next)
      }
      return row
    })
  )
}

;(async () => {
  try {
    await call('/status')
    $('app').textContent = '● conectado'
    $('app').style.color = 'var(--ok)'
  } catch {
    $('app').textContent = 'app fechado'
    $('continue').innerHTML = '<div class="muted">Abra o Toon Index no PC para ver suas obras e marcar esta página.</div>'
    return
  }
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.url && /^https?:/.test(tab.url)) {
    try {
      await readPage()
      showPage(await call('/page', page()))
    } catch (err) {
      pageError(err.message)
    }
  }
  loadContinue().catch(() => undefined)
})()
