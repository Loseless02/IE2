import { dialog, ipcMain, session, type WebContents, type WebFrameMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { getDomain } from 'tldts-experimental'
import type { PasswordOffer, PasswordsForPage } from '../shared/types'
import { AMNESIA_PARTITION } from './partitions'
import { credentialCount, credentialRows, neverSaveOrigins, setNeverSave } from './db'
import { getSettings } from './settings'
import {
  changeMasterPassword,
  confirmMaster,
  createVault,
  credentialsFor,
  deleteCredential,
  deleteVault,
  exportCsv,
  findCredential,
  generatePassword,
  importCsv,
  listCredentials,
  lockVault,
  markUsed,
  onVaultChange,
  readCredential,
  saveCredential,
  unlockVault,
  vaultExists,
  vaultStatus,
  vaultUnlocked
} from './vault'

/**
 * The password manager's IPC: the page-side watcher reports forms and
 * submissions, the chrome asks the questions, and the passwords page manages
 * the vault. Which site a login belongs to is always taken from the sending
 * frame's real address, never from anything the page says.
 */

interface Hooks {
  /** The chrome view of the window this tab is in. */
  chromeFor: (tab: WebContents) => WebContents | null
  /** The tab in front of the window whose chrome sent this. */
  activeTabFor: (chrome: WebContents) => WebContents | null
  /** Every window's chrome. */
  allChromes: () => WebContents[]
}

/** A submitted login waiting for the user's answer, per chrome. */
interface Pending {
  origin: string
  username: string
  password: string
  expires: number
}
const pending = new Map<number, Pending>()

/** Which origin each tab last reported a login form on. */
const formsSeen = new Map<number, string>()

/** What a page found to put a login in. */
type FillResult = 'both' | 'username' | 'password' | 'none'

/** A fill sent to a tab, waiting to hear what the page actually filled. */
const filling = new Map<number, (result: FillResult) => void>()

/**
 * A login whose username went in on a page with no password field yet — the
 * email-first sign-ins, Google's and Microsoft's among them. Its password goes
 * in when a password field turns up in the same tab on the same site.
 */
const nextStep = new Map<number, { origin: string; id: number; expires: number }>()

/** The frame in each tab that last showed a login form — often not the page itself. */
const formFrames = new Map<number, WebFrameMain>()

/** Per-tab state is dropped with the tab. */
const watched = new Set<number>()
function watch(tab: WebContents): void {
  if (watched.has(tab.id)) return
  const id = tab.id
  watched.add(id)
  tab.once('destroyed', () => {
    watched.delete(id)
    formsSeen.delete(id)
    formFrames.delete(id)
    nextStep.delete(id)
    filling.get(id)?.('none')
  })
}

/**
 * The site an origin belongs to: apple.com for appleid.apple.com and
 * idmsa.apple.com alike. An address with no registrable domain — an IP,
 * localhost — is its own site.
 */
function siteOf(origin: string): string {
  const { protocol, hostname } = new URL(origin)
  return `${protocol}//${getDomain(hostname) ?? hostname}`
}

/**
 * A login saved on one address of a site may be offered on another — Apple
 * signs in on several — but only ever within the same site, and the same
 * scheme. It is offered, never filled by itself.
 */
function sameSite(a: string, b: string): boolean {
  try {
    return siteOf(a) === siteOf(b)
  } catch {
    return false
  }
}

const hostOf = (origin: string): string => new URL(origin).host

function originOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

function vaultState(): PasswordOffer['vault'] {
  return !vaultExists() ? 'missing' : vaultUnlocked() ? 'unlocked' : 'locked'
}

/** Only strings of a sane size cross from a page. */
function cleanLogin(value: unknown): { username: string; password: string } | null {
  if (!value || typeof value !== 'object') return null
  const { username, password } = value as { username?: unknown; password?: unknown }
  if (typeof password !== 'string' || !password || password.length > 1000) return null
  if (typeof username !== 'string' || username.length > 500) return null
  return { username: username.trim(), password }
}

/**
 * Where in a tab a login goes when the browser's own panel asks: the frame
 * that showed a login form, if it is on the login's site, else any frame on
 * its exact address, else the page itself.
 */
function frameFor(tab: WebContents, loginOrigin: string): WebFrameMain {
  const shown = formFrames.get(tab.id)
  const shownOrigin = shown && !shown.detached ? originOf(shown.url) : null
  if (shown && shownOrigin && sameSite(shownOrigin, loginOrigin)) return shown
  return tab.mainFrame.framesInSubtree.find((frame) => originOf(frame.url) === loginOrigin) ?? tab.mainFrame
}

/**
 * Send a login to a frame and wait for what it really filled — a page with no
 * field to put it in must not be reported as filled. The frame must be on the
 * login's own site: never into an embedded frame from somewhere else.
 */
function fill(tab: WebContents, id: number, into?: WebFrameMain | null): Promise<boolean> {
  const login = readCredential(id)
  if (!login) return Promise.resolve(false)
  const frame = into ?? frameFor(tab, login.origin)
  const origin = frame.detached ? null : originOf(frame.url)
  if (!origin || !sameSite(origin, login.origin)) return Promise.resolve(false)
  watch(tab)
  filling.get(tab.id)?.('none')

  return new Promise((resolve) => {
    const done = (result: FillResult): void => {
      clearTimeout(timer)
      filling.delete(tab.id)
      if (result === 'username') nextStep.set(tab.id, { origin, id, expires: Date.now() + 5 * 60_000 })
      else if (result !== 'none') nextStep.delete(tab.id)
      if (result !== 'none') markUsed(id)
      resolve(result !== 'none')
    }
    const timer = setTimeout(() => done('none'), 2000)
    filling.set(tab.id, done)
    try {
      frame.send('pw:fill', { username: login.username, password: login.password })
    } catch {
      done('none')
    }
  })
}

/**
 * The origin of the frame a page-side message came from — the page itself or
 * a frame embedded in it — or null for anything that is not a web page.
 */
function senderOrigin(event: Electron.IpcMainInvokeEvent): string | null {
  return event.senderFrame ? originOf(event.senderFrame.url) : null
}

export function registerPasswordIpc(hooks: Hooks): void {
  const tell = (): void => {
    for (const chrome of hooks.allChromes()) {
      if (!chrome.isDestroyed()) chrome.send('browser:passwords-changed')
    }
  }
  onVaultChange(tell)

  // --- from pages ---

  // Every frame reports, not only the page: sign-in forms often live in an
  // embedded frame (Apple's does), and a login belongs to that frame's own
  // address — the one the password is typed into.
  ipcMain.handle('pw:form-found', (event) => {
    const origin = senderOrigin(event)
    if (!origin || !event.senderFrame) return
    watch(event.sender)
    formFrames.set(event.sender.id, event.senderFrame)
    if (event.senderFrame.parent === null) formsSeen.set(event.sender.id, origin)

    // The second page of an email-first sign-in: the password of the login
    // whose username was just filled.
    const step = nextStep.get(event.sender.id)
    if (step && step.origin === origin && step.expires > Date.now() && vaultUnlocked()) {
      void fill(event.sender, step.id, event.senderFrame)
    } else if (vaultUnlocked() && getSettings().autofillPasswords) {
      // Unlocked, one login saved for exactly this address, and autofill on:
      // fill it now. Logins from elsewhere on the site wait to be picked.
      const accounts = credentialsFor(origin)
      if (accounts.length === 1) void fill(event.sender, accounts[0].id, event.senderFrame)
    }
    tell()
  })

  ipcMain.handle('pw:fill-result', (event, result: unknown) => {
    if (!senderOrigin(event)) return
    const known: FillResult[] = ['both', 'username', 'password', 'none']
    filling.get(event.sender.id)?.(known.includes(result as FillResult) ? (result as FillResult) : 'none')
  })

  // The list under a login field: usernames only. Passwords never go to the
  // page except by being filled into its fields. Logins for exactly this
  // address come first; those saved elsewhere on the same site follow, with
  // where they were saved.
  ipcMain.handle('pw:suggest', (event) => {
    const origin = senderOrigin(event)
    if (!origin) return null
    const related = credentialRows().filter((row) => row.origin !== origin && sameSite(row.origin, origin))
    const count = credentialCount(origin) + related.length
    if (count === 0) return null

    const exact = credentialsFor(origin).map(({ id, username }) => ({ id, username }))
    const elsewhere = vaultUnlocked()
      ? listCredentials()
          .filter((entry) => entry.origin !== origin && sameSite(entry.origin, origin))
          .map(({ id, username, origin: from }) => ({ id, username, from: hostOf(from) }))
      : []
    return { vault: vaultState(), count, accounts: [...exact, ...elsewhere] }
  })

  ipcMain.handle('pw:fill-mine', (event, id: unknown) => {
    if (!senderOrigin(event)) return false
    return fill(event.sender, Number(id), event.senderFrame)
  })

  // Locked: unlocking happens in the browser's own panel, never in the page.
  ipcMain.handle('pw:open-panel', (event) => {
    if (!senderOrigin(event)) return
    const chrome = hooks.chromeFor(event.sender)
    if (!chrome || chrome.isDestroyed() || hooks.activeTabFor(chrome) !== event.sender) return
    chrome.focus()
    chrome.send('browser:open-passwords')
  })

  ipcMain.handle('pw:submitted', (event, value: unknown) => {
    // Saved under the address of the frame the password was typed into.
    const origin = senderOrigin(event)
    const login = cleanLogin(value)
    if (!origin || !login) return

    // An amnesia tab writes nothing down — logins included.
    if (event.sender.session === session.fromPartition(AMNESIA_PARTITION)) return
    if (!getSettings().offerToSavePasswords || neverSaveOrigins().includes(origin)) return

    const vault = vaultState()
    let update = false
    if (vault === 'unlocked') {
      const existing = findCredential(origin, login.username)
      if (existing?.password === login.password) return
      update = existing !== null
    }

    const chrome = hooks.chromeFor(event.sender)
    if (!chrome || chrome.isDestroyed()) return
    pending.set(chrome.id, { origin, ...login, expires: Date.now() + 5 * 60_000 })

    const offer: PasswordOffer = { origin, username: login.username, update, vault }
    chrome.send('browser:password-offer', offer)
  })

  // --- from the chrome ---

  ipcMain.handle(
    'pw:offer-answer',
    async (event, choice: 'save' | 'never' | 'dismiss', master?: string): Promise<{ ok: boolean; error?: string; updated?: boolean }> => {
      const offer = pending.get(event.sender.id)
      if (!offer || offer.expires < Date.now()) {
        pending.delete(event.sender.id)
        return { ok: false, error: 'That login is no longer waiting to be saved.' }
      }
      if (choice === 'dismiss') {
        pending.delete(event.sender.id)
        return { ok: true }
      }
      if (choice === 'never') {
        pending.delete(event.sender.id)
        setNeverSave(offer.origin, true)
        return { ok: true }
      }

      if (!vaultExists()) {
        if (!master || master.length < 8) return { ok: false, error: 'Use at least 8 characters.' }
        await createVault(master)
      } else if (!vaultUnlocked()) {
        const result = await unlockVault(master ?? '')
        if (!result.ok) {
          return {
            ok: false,
            error: result.waitMs
              ? `Too many tries. Wait ${Math.ceil(result.waitMs / 1000)} seconds.`
              : 'That is not the master password.'
          }
        }
      }

      pending.delete(event.sender.id)
      const existing = findCredential(offer.origin, offer.username)
      if (existing?.password === offer.password) return { ok: true, updated: false }
      saveCredential({ id: existing?.id, origin: offer.origin, username: offer.username, password: offer.password, note: existing?.note })
      return { ok: true, updated: existing !== null }
    }
  )

  ipcMain.handle('pw:for-page', (event): PasswordsForPage | null => {
    const tab = hooks.activeTabFor(event.sender)
    const origin = originOf(tab?.getURL())
    if (!tab || !origin) return null
    // The site's logins, wherever on it they were saved: a form in an embedded
    // frame from another of the site's addresses is still this site's.
    const shown = formFrames.get(tab.id)
    const shownOrigin = shown && !shown.detached ? originOf(shown.url) : null
    return {
      origin,
      count: credentialRows().filter((row) => sameSite(row.origin, origin)).length,
      vault: vaultState(),
      accounts: vaultUnlocked() ? listCredentials().filter((entry) => sameSite(entry.origin, origin)) : [],
      hasForm: formsSeen.get(tab.id) === origin || Boolean(shownOrigin && sameSite(shownOrigin, origin))
    }
  })

  ipcMain.handle('pw:fill', (event, id: number) => {
    const tab = hooks.activeTabFor(event.sender)
    return tab ? fill(tab, id) : false
  })

  ipcMain.handle('pw:unlock', async (_event, master: string) => {
    const result = await unlockVault(String(master ?? ''))
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          error: result.waitMs
            ? `Too many tries. Wait ${Math.ceil(result.waitMs / 1000)} seconds.`
            : 'That is not the master password.'
        }
  })
}

/**
 * The passwords page. Only ie2://passwords may use these: no other page, ours
 * or anyone's, has any business near the vault.
 */
export function registerVaultPageIpc(isPasswordsPage: (url: string | undefined) => boolean): void {
  const only =
    <A extends unknown[], R>(handler: (...args: A) => R) =>
    (event: Electron.IpcMainInvokeEvent, ...args: A): R | null =>
      // The page itself, never one framed inside a website.
      event.senderFrame?.parent === null && isPasswordsPage(event.senderFrame.url) ? handler(...args) : null

  const wait = (ms?: number): string =>
    ms ? `Too many tries. Wait ${Math.ceil(ms / 1000)} seconds.` : 'That is not the master password.'

  ipcMain.handle('vault:status', only(() => vaultStatus()))
  ipcMain.handle(
    'vault:create',
    only(async (master: string) => (await createVault(String(master))) ? { ok: true } : { ok: false, error: 'Use at least 8 characters.' })
  )
  ipcMain.handle(
    'vault:unlock',
    only(async (master: string) => {
      const result = await unlockVault(String(master))
      return result.ok ? { ok: true } : { ok: false, error: wait(result.waitMs) }
    })
  )
  ipcMain.handle('vault:lock', only(() => lockVault()))
  ipcMain.handle('vault:list', only(() => (vaultUnlocked() ? listCredentials() : [])))
  ipcMain.handle('vault:reveal', only((id: number) => (vaultUnlocked() ? readCredential(Number(id)) : null)))
  ipcMain.handle(
    'vault:save',
    only((entry: { id?: number; url: string; username: string; password: string; note?: string }) => {
      const origin = originOf(entry.url) ?? originOf(`https://${entry.url}`)
      if (!vaultUnlocked() || !origin || !entry.password) return null
      return saveCredential({
        id: entry.id,
        origin,
        username: String(entry.username ?? ''),
        password: String(entry.password),
        note: String(entry.note ?? '')
      })
    })
  )
  ipcMain.handle('vault:delete', only((id: number) => (vaultUnlocked() ? deleteCredential(Number(id)) : undefined)))
  ipcMain.handle('vault:generate', only(() => generatePassword()))
  ipcMain.handle(
    'vault:change',
    only(async (current: string, next: string) =>
      (await changeMasterPassword(String(current), String(next)))
        ? { ok: true }
        : { ok: false, error: 'The current master password is wrong, or the new one is under 8 characters.' }
    )
  )
  ipcMain.handle('vault:wipe', only(() => deleteVault()))
  ipcMain.handle('vault:never-list', only(() => neverSaveOrigins()))
  ipcMain.handle('vault:never-remove', only((origin: string) => setNeverSave(String(origin), false)))

  // Everything in plain text leaves the vault only after the master password
  // is typed again, into a file the user chose.
  ipcMain.handle(
    'vault:export',
    only(async (master: string) => {
      if (!(await confirmMaster(String(master)))) return { ok: false, error: wait() }
      const stamp = new Date().toISOString().slice(0, 10)
      const target = await dialog.showSaveDialog({
        title: 'Export passwords',
        defaultPath: `IE2 passwords ${stamp}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (target.canceled || !target.filePath) return { ok: false }
      await writeFile(target.filePath, exportCsv(), 'utf8')
      return { ok: true }
    })
  )
  ipcMain.handle(
    'vault:import',
    only(async () => {
      if (!vaultUnlocked()) return null
      const source = await dialog.showOpenDialog({
        title: 'Import passwords',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        properties: ['openFile']
      })
      if (source.canceled || !source.filePaths[0]) return null
      return importCsv(await readFile(source.filePaths[0], 'utf8'))
    })
  )
}
