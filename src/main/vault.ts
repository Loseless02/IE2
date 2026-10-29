import { createCipheriv, createDecipheriv, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import type { CredentialSummary, Credential, VaultStatus } from '../shared/types'
import {
  credentialCount,
  credentialRow,
  credentialRows,
  deleteCredentialRow,
  insertCredential,
  replaceCredentialBlobs,
  setVaultMeta,
  touchCredential,
  updateCredentialRow,
  vaultMeta,
  wipeVault
} from './db'
import { getSettings } from './settings'

/**
 * The password vault.
 *
 * The master password is stretched with scrypt into a 256-bit key, and every
 * saved login is sealed with AES-256-GCM under that key — the username and the
 * note as well as the password, so the database file on its own says nothing
 * beyond which sites have a login. Only the site's origin is kept in the clear,
 * because that is how the browser knows a page has something to fill.
 *
 * The key lives in memory only while the vault is unlocked, and is dropped
 * after a few idle minutes (Settings → Passwords). There is no recovery: a
 * forgotten master password means starting over.
 */

/** scrypt cost: about a tenth of a second here, a lot more for a guesser. */
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const CHECK_TEXT = 'ie2-vault-check'

let key: Buffer | null = null
let lockTimer: NodeJS.Timeout | undefined
let listeners: (() => void)[] = []

/** Each failed unlock waits a little longer before the next is allowed. */
let failures = 0
let blockedUntil = 0

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, KDF, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

function seal(plain: string, withKey: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', withKey, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

function open(sealed: string, withKey: Buffer): string {
  const raw = Buffer.from(sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', withKey, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

interface Sealed {
  username: string
  password: string
  note: string
}

function readRow(blob: string): Sealed {
  const parsed = JSON.parse(open(blob, requireKey())) as Partial<Sealed>
  return {
    username: String(parsed.username ?? ''),
    password: String(parsed.password ?? ''),
    note: String(parsed.note ?? '')
  }
}

function requireKey(): Buffer {
  if (!key) throw new Error('locked')
  touch()
  return key
}

/** Activity keeps the vault open; silence locks it. */
function touch(): void {
  clearTimeout(lockTimer)
  const minutes = Math.max(1, getSettings().vaultLockMinutes || 5)
  lockTimer = setTimeout(lockVault, minutes * 60_000)
}

function changed(): void {
  for (const listener of listeners) listener()
}

/** Told whenever the vault locks, unlocks or its contents change. */
export function onVaultChange(listener: () => void): void {
  listeners = [...listeners, listener]
}

export function vaultExists(): boolean {
  return vaultMeta('salt') !== null
}

export function vaultUnlocked(): boolean {
  return key !== null
}

export function vaultStatus(): VaultStatus {
  return {
    exists: vaultExists(),
    unlocked: key !== null,
    count: credentialCount(),
    lockMinutes: getSettings().vaultLockMinutes
  }
}

/** A new, empty vault behind this master password. */
export async function createVault(password: string): Promise<boolean> {
  if (vaultExists() || password.length < 8) return false
  const salt = randomBytes(16)
  const derived = await derive(password, salt)
  setVaultMeta('salt', salt.toString('base64'))
  setVaultMeta('check', seal(CHECK_TEXT, derived))
  key = derived
  touch()
  changed()
  return true
}

async function verify(password: string): Promise<Buffer | null> {
  const salt = vaultMeta('salt')
  const check = vaultMeta('check')
  if (!salt || !check) return null

  const derived = await derive(password, Buffer.from(salt, 'base64'))
  try {
    const text = Buffer.from(open(check, derived))
    const expected = Buffer.from(CHECK_TEXT)
    return text.length === expected.length && timingSafeEqual(text, expected) ? derived : null
  } catch {
    // The authentication tag does not match: wrong password.
    return null
  }
}

export async function unlockVault(password: string): Promise<{ ok: boolean; waitMs?: number }> {
  const now = Date.now()
  if (now < blockedUntil) return { ok: false, waitMs: blockedUntil - now }

  const derived = await verify(password)
  if (!derived) {
    failures++
    blockedUntil = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(failures, 6))
    return { ok: false }
  }

  failures = 0
  key = derived
  touch()
  changed()
  return { ok: true }
}

export function lockVault(): void {
  clearTimeout(lockTimer)
  if (!key) return
  key.fill(0)
  key = null
  changed()
}

/** Asked again before anything leaves the vault in bulk. */
export async function confirmMaster(password: string): Promise<boolean> {
  return (await verify(password)) !== null
}

export async function changeMasterPassword(current: string, next: string): Promise<boolean> {
  if (next.length < 8) return false
  const old = await verify(current)
  if (!old) return false

  const salt = randomBytes(16)
  const fresh = await derive(next, salt)
  const rows = credentialRows().map((row) => ({ id: row.id, blob: seal(open(row.blob, old), fresh) }))
  replaceCredentialBlobs(rows, { salt: salt.toString('base64'), check: seal(CHECK_TEXT, fresh) })

  key = fresh
  touch()
  changed()
  return true
}

export function deleteVault(): void {
  lockVault()
  wipeVault()
  changed()
}

// --- logins -------------------------------------------------------------------

export function listCredentials(): CredentialSummary[] {
  return credentialRows().map((row) => {
    const { username } = readRow(row.blob)
    return { id: row.id, origin: row.origin, username, updatedAt: row.updatedAt, lastUsed: row.lastUsed }
  })
}

/** Logins for one site, without their passwords. Locked: none can be read. */
export function credentialsFor(origin: string): CredentialSummary[] {
  if (!key) return []
  return listCredentials().filter((entry) => entry.origin === origin)
}

export function readCredential(id: number): Credential | null {
  const row = credentialRow(id)
  if (!row) return null
  return { id: row.id, origin: row.origin, ...readRow(row.blob), updatedAt: row.updatedAt, lastUsed: row.lastUsed }
}

export function markUsed(id: number): void {
  touchCredential(id)
}

/** Add a login, or replace the one with the same id. */
export function saveCredential(entry: {
  id?: number
  origin: string
  username: string
  password: string
  note?: string
}): number {
  const blob = seal(
    JSON.stringify({ username: entry.username, password: entry.password, note: entry.note ?? '' }),
    requireKey()
  )
  if (entry.id) {
    updateCredentialRow(entry.id, entry.origin, blob)
    changed()
    return entry.id
  }
  const id = insertCredential(entry.origin, blob)
  changed()
  return id
}

export function deleteCredential(id: number): void {
  requireKey()
  deleteCredentialRow(id)
  changed()
}

/** The login for this site and username, if there is one. */
export function findCredential(origin: string, username: string): Credential | null {
  for (const row of credentialRows(origin)) {
    const sealed = readRow(row.blob)
    if (sealed.username === username) {
      return { id: row.id, origin, ...sealed, updatedAt: row.updatedAt, lastUsed: row.lastUsed }
    }
  }
  return null
}

// --- moving logins in and out -------------------------------------------------

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The CSV layout Chrome, Edge, Brave and Firefox all import. */
export function exportCsv(): string {
  const lines = ['name,url,username,password,note']
  for (const row of credentialRows()) {
    const { username, password, note } = readRow(row.blob)
    let name = row.origin
    try {
      name = new URL(row.origin).host
    } catch {
      // Keep the origin.
    }
    lines.push([name, row.origin, username, password, note].map(csvField).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  row.push(field)
  if (row.some((cell) => cell !== '')) rows.push(row)
  return rows
}

/**
 * Logins exported from another browser as CSV. The columns are found by name,
 * since every browser orders them differently. A login that already exists is
 * updated rather than duplicated.
 */
export function importCsv(text: string): { added: number; updated: number; skipped: number } {
  requireKey()
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''))
  const result = { added: 0, updated: 0, skipped: 0 }
  if (!header) return result

  const column = (...names: string[]): number =>
    header.findIndex((name) => names.includes(name.trim().toLowerCase()))
  const urlAt = column('url', 'origin', 'website', 'login_uri', 'hostname')
  const userAt = column('username', 'login', 'user', 'email', 'login_username')
  const passAt = column('password', 'login_password')
  const noteAt = column('note', 'notes', 'extra')
  if (urlAt === -1 || passAt === -1) return result

  for (const row of rows) {
    let origin: string
    try {
      const url = new URL(row[urlAt] ?? '')
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
      origin = url.origin
    } catch {
      result.skipped++
      continue
    }
    const username = userAt === -1 ? '' : (row[userAt] ?? '')
    const password = row[passAt] ?? ''
    if (!password) {
      result.skipped++
      continue
    }

    const existing = findCredential(origin, username)
    if (existing && existing.password === password) continue
    saveCredential({
      id: existing?.id,
      origin,
      username,
      password,
      note: noteAt === -1 ? existing?.note : (row[noteAt] ?? '')
    })
    if (existing) result.updated++
    else result.added++
  }
  return result
}

/** Random, from the browser's cryptographic source, with no ambiguous look-alikes. */
export function generatePassword(length = 20): string {
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*-_=+?']
  const all = sets.join('')
  // randomInt is unbiased, so no character is likelier than another.
  const pick = (from: string): string => from[randomInt(from.length)]
  const chars = sets.map(pick)
  while (chars.length < length) chars.push(pick(all))
  // Shuffle so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
