/**
 * Phones paired with the app on this computer. A phone pairs once with a short code (shown as a QR
 * code) and from then on sends the token it got with every request.
 */

export interface PairedDevice {
  id: string
  name: string
  pairedAt: number
  lastSeen: number | null
}

export interface DevicesStatus {
  /** Whether the app answers phones on the network (off: this computer only, for the extension). */
  enabled: boolean
  devices: PairedDevice[]
  /** Addresses the phone can reach the app at: home network and Tailscale. */
  addresses: { address: string; kind: 'lan' | 'tailscale' }[]
  port: number
}

export interface PairingCode {
  code: string
  expiresAt: number
  /** The QR code (PNG data URL) holding the app's addresses, port and the code, for the phone to scan. */
  qr: string
}
