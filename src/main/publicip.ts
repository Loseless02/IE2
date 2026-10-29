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

/**
 * Which country the address belongs to, from Cloudflare's trace page — the
 * address is looked up where it is already being seen, so no location
 * permission and no GPS: it is the country a website would guess, which is
 * exactly what is worth knowing when checking a VPN.
 */
async function country(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await net.fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: controller.signal,
      cache: 'no-store'
    })
    if (!response.ok) return null
    const line = (await response.text()).split('\n').find((entry) => entry.startsWith('loc='))
    const code = line?.slice(4).trim().toUpperCase() ?? ''
    return /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function publicIp(): Promise<PublicIp> {
  // api.ipify.org only answers over IPv4; api64 answers over IPv6 when there
  // is a route for it, which is how an IPv6 leak around a VPN shows up.
  const [v4, either, where] = await Promise.all([
    ask('https://api.ipify.org?format=json'),
    ask('https://api64.ipify.org?format=json'),
    country()
  ])
  const v6 = either?.includes(':') ? either : null
  return { v4, v6, country: where, checkedAt: Date.now(), failed: !v4 && !v6 }
}
