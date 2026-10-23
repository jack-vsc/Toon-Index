import { app } from 'electron'
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import QRCode from 'qrcode'
import type { DevicesStatus, PairedDevice, PairingCode } from '../shared/devices'

/** Saved per device; only the token's hash is kept, so the file alone does not let anyone in. */
interface StoredDevice extends PairedDevice {
  tokenHash: string
}

interface Stored {
  enabled: boolean
  devices: StoredDevice[]
}

const PAIRING_MINUTES = 10
const MAX_FAILURES = 5
const path = (): string => join(app.getPath('userData'), 'devices.json')

let pairing: { code: string; expiresAt: number; failures: number } | null = null

function load(): Stored {
  try {
    return JSON.parse(readFileSync(path(), 'utf8')) as Stored
  } catch {
    return { enabled: false, devices: [] }
  }
}

function save(stored: Stored): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(path(), JSON.stringify(stored, null, 2))
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

export function phonesEnabled(): boolean {
  return load().enabled
}

export function setPhonesEnabled(enabled: boolean): void {
  save({ ...load(), enabled })
}

/** IPv4 addresses of this computer a phone can reach: Tailscale's (100.64.0.0/10) and the home network's. */
export function addresses(): DevicesStatus['addresses'] {
  const found: DevicesStatus['addresses'] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [x, y] = a.address.split('.').map(Number)
      const tailscale = /tailscale/i.test(name) || (x === 100 && y >= 64 && y < 128)
      // Virtual adapters (WSL, Docker, VirtualBox) are not reachable from the phone.
      if (!tailscale && /vethernet|wsl|docker|virtualbox|vmware|loopback/i.test(name)) continue
      if (tailscale || x === 192 || x === 10 || (x === 172 && y >= 16 && y < 32)) {
        found.push({ address: a.address, kind: tailscale ? 'tailscale' : 'lan' })
      }
    }
  }
  return found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tailscale' ? 1 : -1))
}

export function devicesStatus(port: number): DevicesStatus {
  const { enabled, devices } = load()
  return { enabled, devices: devices.map(({ tokenHash: _t, ...d }) => d), addresses: addresses(), port }
}

/** A new six-digit code, good for a few minutes; the QR code carries it with the addresses to try. */
export async function newPairingCode(port: number): Promise<PairingCode> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  pairing = { code, expiresAt: Date.now() + PAIRING_MINUTES * 60_000, failures: 0 }
  const qrText = JSON.stringify({ app: 'manga-index', port, code, hosts: addresses().map((a) => a.address) })
  return { code, expiresAt: pairing.expiresAt, qr: await QRCode.toDataURL(qrText, { margin: 1, width: 240 }) }
}

/** Trades a valid pairing code for the token the phone will use from now on; null when the code is wrong or old. */
export function pair(code: string, name: string): { token: string; device: PairedDevice } | null {
  const current = pairing
  if (!current || Date.now() > current.expiresAt) return null
  const a = Buffer.from(code)
  const b = Buffer.from(current.code)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    // Guessing a six-digit code takes many tries; a few wrong ones end it, and a new one has to be shown.
    if (++current.failures >= MAX_FAILURES) pairing = null
    return null
  }
  // One phone per code: a second try with the same code (someone watching the screen) gets nothing.
  pairing = null
  const token = randomBytes(32).toString('hex')
  const device: StoredDevice = { id: randomUUID(), name: name.trim().slice(0, 60) || 'Celular', pairedAt: Date.now(), lastSeen: null, tokenHash: hash(token) }
  const stored = load()
  save({ ...stored, devices: [...stored.devices, device] })
  const { tokenHash: _t, ...shown } = device
  return { token, device: shown }
}

/** The device a token belongs to, noting it was seen; null for an unknown or revoked token. */
export function deviceFor(token: string): PairedDevice | null {
  const stored = load()
  const h = hash(token)
  const device = stored.devices.find((d) => d.tokenHash === h)
  if (!device) return null
  // Written at most once a minute: the phone asks often.
  if (!device.lastSeen || Date.now() - device.lastSeen > 60_000) {
    save({ ...stored, devices: stored.devices.map((d) => (d.id === device.id ? { ...d, lastSeen: Date.now() } : d)) })
  }
  const { tokenHash: _t, ...shown } = device
  return shown
}

export function revokeDevice(id: string): void {
  const stored = load()
  save({ ...stored, devices: stored.devices.filter((d) => d.id !== id) })
}
