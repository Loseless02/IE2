import { net } from 'electron'
import type { PublicIp } from '../shared/types'

/**
 * The address the internet sees this machine coming from, as reported by
 * ipify. Asked only when the Public IP panel is opened — never in the
 * background — because asking tells ipify the address too.
 *
 * Fetched through the main process's network stack, outside the browsing
 * session, so a filter list that blocks IP-check services cannot break it.
 */
async function ask(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await net.fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { ip?: unknown }
    // Only ever an address: digits, hex, dots and colons, nothing to render.
    return typeof body.ip === 'string' && /^[0-9a-f.:]{3,45}$/i.test(body.ip) ? body.ip : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function publicIp(): Promise<PublicIp> {
  // api.ipify.org only answers over IPv4; api64 answers over IPv6 when there
  // is a route for it, which is how an IPv6 leak around a VPN shows up.
  const [v4, either] = await Promise.all([
    ask('https://api.ipify.org?format=json'),
    ask('https://api64.ipify.org?format=json')
  ])
  const v6 = either?.includes(':') ? either : null
  return { v4, v6, checkedAt: Date.now(), failed: !v4 && !v6 }
}
