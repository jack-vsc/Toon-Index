import { app, safeStorage } from 'electron'
import { createSign, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import { createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type Unsubscribe
} from 'firebase/firestore'
import type { CloudConfig, CloudStatus } from '../shared/cloud'
import { internalToken } from './devices'

/**
 * Sync over the internet without Tailscale, through the person's own Firebase project (Firestore on
 * the free plan). Only information goes there, never PDFs or images:
 * - the PC keeps two documents up to date, the library (works, readings, chapters list) and the queue,
 *   for the phone to read when it cannot reach the PC;
 * - the phone leaves its requests (the same ones it makes to the PC at home) as documents; the PC runs
 *   them on its own phone API and writes the answer back, or later, when it comes on.
 * Everything lives under one "space" whose members are the PC's account and each paired phone's
 * (added when it pairs at home), and the security rules let only members in.
 */

interface Stored {
  config: CloudConfig['web']
  androidAppId: string
  spaceId?: string
  /** The PC's own account in the project, made the first time (the phone uses an anonymous one). */
  email?: string
  /** Encrypted with the system's keychain. */
  password?: string
  /** The project's service account key (JSON, encrypted like the password): sends the notifications. */
  serviceKey?: string
}

interface ServiceKey {
  project_id: string
  client_email: string
  private_key: string
}

const file = (): string => join(app.getPath('userData'), 'cloud.json')
let port = 0
let firebase: FirebaseApp | null = null
let db: Firestore | null = null
let spaceId: string | null = null
let stopOps: Unsubscribe | null = null
let status: CloudStatus = { configured: false, connected: false, error: null, members: 0, push: false }
let publishTimer: NodeJS.Timeout | null = null
let sweepTimer: NodeJS.Timeout | null = null

function load(): Stored | null {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Stored) : null
  } catch {
    return null
  }
}

const save = (stored: Stored): void => writeFileSync(file(), JSON.stringify(stored, null, 2))

const seal = (text: string): string => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : `plain:${text}`)
const unseal = (text: string): string =>
  text.startsWith('plain:') ? text.slice(6) : safeStorage.decryptString(Buffer.from(text, 'base64'))

export function cloudStatus(): CloudStatus {
  return status
}

/**
 * The `firebaseConfig` block the Firebase console shows (pasted as it is, JavaScript or JSON) and the
 * Android app's id; the sync starts with them.
 */
export async function setCloudConfig(pasted: string, androidAppId: string): Promise<CloudStatus> {
  const web = parseConfig(pasted)
  if (!web) throw new Error('Não achei apiKey, projectId e appId no texto colado. Copie o bloco firebaseConfig inteiro.')
  if (!/^1:\d+:android:[a-f0-9]+$/.test(androidAppId.trim())) throw new Error('O ID do app Android começa com 1: e tem :android: no meio.')
  const old = load()
  // Another project: a new space there (the phones join it when they pair again at home).
  const sameProject = old?.config.projectId === web.projectId
  save({ config: web, androidAppId: androidAppId.trim(), ...(sameProject ? { spaceId: old?.spaceId, email: old?.email, password: old?.password, serviceKey: old?.serviceKey } : {}) })
  await startCloud(port)
  return status
}

export async function forgetCloud(): Promise<CloudStatus> {
  await stopCloud()
  writeFileSync(file(), '{}')
  status = { configured: false, connected: false, error: null, members: 0, push: false }
  return status
}

/** What a phone paired at home needs to reach the same space by itself: null when the sync is off. */
export function cloudForPhone(): { web: CloudConfig['web']; androidAppId: string; spaceId: string } | null {
  const stored = load()
  return stored?.config && spaceId ? { web: stored.config, androidAppId: stored.androidAppId, spaceId } : null
}

/** A phone paired at home joins the space with its (anonymous) account. */
export async function joinCloud(uid: string): Promise<void> {
  if (!db || !spaceId || !/^[A-Za-z0-9]{10,128}$/.test(uid)) return
  await updateDoc(doc(db, 'spaces', spaceId), { members: arrayUnion(uid) })
  status = { ...status, members: status.members + 1 }
}

export async function startCloud(readingPort: number): Promise<void> {
  port = readingPort
  await stopCloud()
  const stored = load()
  if (!stored?.config?.apiKey) {
    status = { configured: false, connected: false, error: null, members: 0, push: false }
    return
  }
  const push = !!stored.serviceKey
  status = { configured: true, connected: false, error: null, members: 0, push }
  try {
    firebase = initializeApp(stored.config, `manga-index-${Date.now()}`)
    const auth = getAuth(firebase)
    if (!stored.email || !stored.password) {
      const email = `pc-${randomBytes(6).toString('hex')}@manga-index.app`
      const password = randomBytes(24).toString('base64url')
      // Kept only once the account exists, so a refusal (sign-in off in the console) is tried again from scratch.
      await createUserWithEmailAndPassword(auth, email, password)
      stored.email = email
      stored.password = seal(password)
      save(stored)
    } else {
      await signInWithEmailAndPassword(auth, stored.email, unseal(stored.password))
    }
    const uid = auth.currentUser!.uid
    db = getFirestore(firebase)
    let members = 0
    if (!stored.spaceId) {
      // A new space is written without reading it first: the rules only let members read one.
      const space = doc(collection(db, 'spaces'))
      await setDoc(space, { members: [uid], createdAt: serverTimestamp() })
      stored.spaceId = space.id
      save(stored)
    } else {
      const found = await getDoc(doc(db, 'spaces', stored.spaceId))
      members = Math.max(0, ((found.data()?.members as string[] | undefined)?.length ?? 1) - 1)
    }
    spaceId = stored.spaceId
    const space = doc(db, 'spaces', spaceId)
    status = { configured: true, connected: true, error: null, members, push }

    stopOps = onSnapshot(collection(space, 'ops'), (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type === 'added' && !change.doc.data().status) void runOp(change.doc.id, change.doc.data())
      }
    })
    publishSoon(0)
    // Answers nobody came back for (the phone gave up waiting) are cleared every so often.
    sweepTimer = setInterval(() => void sweep(), 10 * 60_000)
  } catch (err) {
    status = { configured: true, connected: false, error: friendly(err), members: 0, push }
  }
}

/**
 * The service account key the console downloads (Configurações do projeto › Contas de serviço), as
 * pasted; null forgets it. Checked by asking Google for a token with it.
 */
export async function setPushKey(pasted: string | null): Promise<CloudStatus> {
  const stored = load()
  if (!stored?.config) throw new Error('Ligue a sincronização pela internet primeiro.')
  if (pasted === null) {
    delete stored.serviceKey
  } else {
    let key: ServiceKey
    try {
      key = JSON.parse(pasted) as ServiceKey
    } catch {
      throw new Error('Cole o conteúdo inteiro do arquivo .json baixado (começa com { e termina com }).')
    }
    if (!key.private_key || !key.client_email) throw new Error('Esse JSON não é uma chave de conta de serviço.')
    if (key.project_id !== stored.config.projectId) throw new Error(`Essa chave é do projeto "${key.project_id}", e não do "${stored.config.projectId}".`)
    accessToken = null
    await googleToken(key)
    stored.serviceKey = seal(JSON.stringify({ project_id: key.project_id, client_email: key.client_email, private_key: key.private_key }))
  }
  save(stored)
  accessToken = null
  status = { ...status, push: !!stored.serviceKey }
  return status
}

let accessToken: { token: string; until: number } | null = null

/** An OAuth token for Firebase Cloud Messaging, signed with the service key (kept for its hour). */
async function googleToken(key: ServiceKey): Promise<string> {
  if (accessToken && accessToken.until > Date.now() + 60_000) return accessToken.token
  const now = Math.floor(Date.now() / 1000)
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url')
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
  })
  const answer = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string }
  if (!answer.access_token) throw new Error(`O Google recusou a chave: ${answer.error_description ?? response.status}`)
  accessToken = { token: answer.access_token, until: Date.now() + (answer.expires_in ?? 3600) * 1000 }
  return accessToken.token
}

/**
 * A notification on every phone of the space (their addresses are left in `devices`); tapping it
 * opens the work. False when it could not go (no key, the sync off, no phone): the caller falls back.
 */
export async function sendPush(title: string, body: string, data: { workId: string; url: string }): Promise<boolean> {
  const stored = load()
  if (!db || !spaceId || !stored?.serviceKey) return false
  try {
    const key = JSON.parse(unseal(stored.serviceKey)) as ServiceKey
    const token = await googleToken(key)
    const devices = await getDocs(collection(db, 'spaces', spaceId, 'devices'))
    let sent = 0
    for (const device of devices.docs) {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: device.data().token,
            notification: { title, body },
            data,
            // One notification per work: a newer chapter replaces the one before.
            android: { priority: 'high', notification: { channel_id: 'chapters', ...(data.workId ? { tag: data.workId } : {}) } }
          }
        })
      })
      if (response.ok) sent++
      // The app was uninstalled or its address changed: that address goes.
      else if (response.status === 404) await deleteDoc(device.ref).catch(() => undefined)
      else console.warn('[cloud] push failed:', response.status, await response.text())
    }
    return sent > 0
  } catch (err) {
    console.warn('[cloud] push failed:', (err as Error).message)
    return false
  }
}

export async function stopCloud(): Promise<void> {
  stopOps?.()
  stopOps = null
  if (publishTimer) clearTimeout(publishTimer)
  if (sweepTimer) clearInterval(sweepTimer)
  publishTimer = sweepTimer = null
  if (firebase) await deleteApp(firebase).catch(() => undefined)
  firebase = db = null
  spaceId = null
}

/**
 * The library or the queue changed: both documents are written again a little later, so a chapter
 * translating page by page costs a few writes, not one a page (the free plan allows 20 000 a day).
 */
export function publishSoon(delayMs = 20_000): void {
  if (!db || publishTimer) return
  publishTimer = setTimeout(() => {
    publishTimer = null
    void publish()
  }, delayMs)
}

async function publish(): Promise<void> {
  if (!db || !spaceId) return
  try {
    const [library, queue] = await Promise.all([local('GET', '/api/library'), local('GET', '/api/queue')])
    const space = doc(db, 'spaces', spaceId)
    await setDoc(doc(space, 'state', 'library'), { json: library.text, at: serverTimestamp() })
    await setDoc(doc(space, 'state', 'queue'), { json: queue.text, at: serverTimestamp() })
  } catch (err) {
    status = { ...status, error: friendly(err) }
  }
}

/** A phone's request: run on the PC's phone API as if it had come over the home network. */
async function runOp(id: string, op: Record<string, unknown>): Promise<void> {
  if (!db || !spaceId) return
  const ref = doc(db, 'spaces', spaceId, 'ops', id)
  const method = op.method === 'GET' ? 'GET' : 'POST'
  const path = typeof op.path === 'string' && op.path.startsWith('/api/') ? op.path : null
  try {
    const answer = path ? await local(method, path, typeof op.body === 'string' ? op.body : undefined) : { status: 400, text: '{"error":"Pedido inválido."}' }
    // Firestore keeps documents under 1 MB; an answer that does not fit says so.
    const text = answer.text.length > 900_000 ? '{"error":"A resposta do PC é grande demais para a internet."}' : answer.text
    await updateDoc(ref, { status: answer.status, response: text, doneAt: serverTimestamp() })
  } catch (err) {
    await updateDoc(ref, { status: 500, response: JSON.stringify({ error: friendly(err) }), doneAt: serverTimestamp() }).catch(() => undefined)
  }
  publishSoon(3_000)
}

async function sweep(): Promise<void> {
  if (!db || !spaceId) return
  const old = await getDocs(query(collection(db, 'spaces', spaceId, 'ops'), where('doneAt', '<', new Date(Date.now() - 10 * 60_000))))
  await Promise.all(old.docs.map((d) => deleteDoc(d.ref)))
}

async function local(method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${internalToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'GET' ? undefined : body
  })
  return { status: response.status, text: await response.text() }
}

/** The fields of the console's firebaseConfig block, from JavaScript (unquoted keys) or JSON. */
function parseConfig(text: string): CloudConfig['web'] | null {
  const field = (key: string) => new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`).exec(text)?.[1]
  const config = {
    apiKey: field('apiKey'),
    authDomain: field('authDomain'),
    projectId: field('projectId'),
    storageBucket: field('storageBucket'),
    messagingSenderId: field('messagingSenderId'),
    appId: field('appId')
  }
  return config.apiKey && config.projectId && config.appId && config.messagingSenderId ? (config as CloudConfig['web']) : null
}

function friendly(err: unknown): string {
  const code = (err as { code?: string }).code ?? ''
  if (code === 'auth/operation-not-allowed') return 'Ative "E-mail/senha" e "Anônimo" em Authentication, no console do Firebase.'
  if (code === 'permission-denied') return 'O Firestore recusou: cole as regras de segurança do Toon Index em Firestore › Regras.'
  if (code === 'auth/network-request-failed' || code === 'unavailable') return 'Sem internet no PC agora.'
  return (err as Error).message ?? String(err)
}
