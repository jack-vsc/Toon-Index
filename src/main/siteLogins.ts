import { app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Sign-ins for sites that send their chapters to a login page, kept by the person in a file of the
 * app's data folder (never in the project, never sent anywhere but to the site itself):
 *
 *   MEDIOCRESCAN_USER=…
 *   MEDIOCRESCAN_PASSWORD=…
 *
 * A site is named by its address without "www." and its ending (mediocrescan.com → MEDIOCRESCAN).
 */
export const loginsPath = (): string => join(app.getPath('userData'), 'site-logins.env')

const TEMPLATE = `# Contas dos sites que pedem login para ler (o Toon Index entra sozinho quando o site mandar para a página de login).
# Um site por par de linhas, com o nome do site sem "www." e sem o final (mediocrescan.com -> MEDIOCRESCAN).
# Este arquivo fica só neste PC; a senha vai só para o próprio site.

MEDIOCRESCAN_USER=
MEDIOCRESCAN_PASSWORD=
`

/** Writes the file with the sites' lines empty, for the person to fill in, when there is none yet. */
export function ensureLoginsFile(): string {
  const path = loginsPath()
  if (!existsSync(path)) writeFileSync(path, TEMPLATE, 'utf8')
  return path
}

function siteKey(url: string): string {
  const labels = new URL(url).hostname.replace(/^www\./, '').split('.')
  return (labels.length > 1 ? labels.slice(0, -1).join('_') : labels[0]).replace(/[^a-z0-9_]/gi, '_').toUpperCase()
}

function loginFor(url: string): { user: string; password: string } | null {
  let text: string
  try {
    text = readFileSync(loginsPath(), 'utf8')
  } catch {
    return null
  }
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) values.set(m[1], m[2].replace(/^(["'])(.*)\1$/, '$2'))
  }
  const key = siteKey(url)
  const user = values.get(`${key}_USER`)
  const password = values.get(`${key}_PASSWORD`)
  return user && password ? { user, password } : null
}

const LOGIN_PATH = /\/(entrar|login|signin|sign-in|auth)(\/|$|\?)/i

/**
 * When the window landed on the site's login page and the file has the site's account: fills it in
 * (keeping the session, "Manter conectado"), sends it and goes back to `url`. True when it signed in.
 */
export async function signInIfAsked(win: BrowserWindow, url: string, load: (url: string) => Promise<void>): Promise<boolean> {
  if (win.isDestroyed() || !LOGIN_PATH.test(new URL(win.webContents.getURL()).pathname + new URL(win.webContents.getURL()).search)) return false
  const login = loginFor(win.webContents.getURL())
  if (!login) return false
  const sent = (await win.webContents.executeJavaScript(`(async () => {
    const shown = (el) => el && el.getClientRects().length > 0
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // A remembered account first offers "Usar outra conta": the form is behind it.
    // Pages drawn by their script show the form a moment later.
    let password = null
    for (let i = 0; i < 20 && !password; i++) {
      password = [...document.querySelectorAll('input[type=password]')].find(shown)
      if (!password) await wait(250)
    }
    if (!password) {
      const other = [...document.querySelectorAll('button, a')].find((b) => /usar outra conta|use another account|outra conta/i.test(b.innerText))
      other?.click()
      await wait(800)
      password = [...document.querySelectorAll('input[type=password]')].find(shown)
    }
    if (!password) return false
    const form = password.closest('form') || document
    const user = [...form.querySelectorAll('input[type=email], input[type=text], input[name*=user i], input[name*=email i], input:not([type])')].find(shown)
    if (!user) return false
    const set = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    set(user, ${JSON.stringify(login.user)})
    set(password, ${JSON.stringify(login.password)})
    for (const box of form.querySelectorAll('input[type=checkbox]')) {
      const label = (box.closest('label')?.innerText || box.parentElement?.innerText || '')
      if (/manter|lembrar|remember|keep/i.test(label) && !box.checked) box.click()
    }
    // Drawn as a button that only acts as a box ("Manter conectado" on MediocreToons).
    for (const box of form.querySelectorAll('[role=checkbox][aria-checked=false]')) {
      if (/manter|lembrar|remember|keep/i.test(box.innerText || box.getAttribute('aria-label') || '')) box.click()
    }
    const submit = [...form.querySelectorAll('button[type=submit], input[type=submit], button')].find((b) => shown(b) && /entrar|login|sign in|acessar/i.test(b.innerText || b.value))
    if (submit) submit.click()
    else password.form?.requestSubmit()
    return true
  })()`)) as boolean
  if (!sent) return false
  // The site takes the account and goes on (to the page asked for, or its start).
  for (let i = 0; i < 20 && !win.isDestroyed() && LOGIN_PATH.test(new URL(win.webContents.getURL()).pathname); i++) await new Promise((r) => setTimeout(r, 500))
  if (win.isDestroyed() || LOGIN_PATH.test(new URL(win.webContents.getURL()).pathname)) return false
  await load(url)
  return true
}
