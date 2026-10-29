import { dialog, ipcMain, session, type WebContents } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import type { PasswordOffer, PasswordsForPage } from '../shared/types'
import { AMNESIA_PARTITION } from './partitions'
import { credentialCount, neverSaveOrigins, setNeverSave } from './db'
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

function fill(tab: WebContents, id: number): boolean {
  const login = readCredential(id)
  if (!login || originOf(tab.getURL()) !== login.origin) return false
  tab.mainFrame.send('pw:fill', { username: login.username, password: login.password })
  markUsed(id)
  return true
}

export function registerPasswordIpc(hooks: Hooks): void {
  const tell = (): void => {
    for (const chrome of hooks.allChromes()) {
      if (!chrome.isDestroyed()) chrome.send('browser:passwords-changed')
    }
  }
  onVaultChange(tell)

  // --- from pages ---

  ipcMain.handle('pw:form-found', (event) => {
    // Top frame only: a login form inside an embedded frame is not this site's.
    if (!event.senderFrame || event.senderFrame.parent !== null) return
    const origin = originOf(event.senderFrame?.url)
    if (!origin) return
    // One clean-up per tab, however many pages with forms it goes through.
    if (!formsSeen.has(event.sender.id)) {
      const id = event.sender.id
      event.sender.once('destroyed', () => formsSeen.delete(id))
    }
    formsSeen.set(event.sender.id, origin)

    // Unlocked, one login for this site, and autofill on: fill it now.
    if (vaultUnlocked() && getSettings().autofillPasswords) {
      const accounts = credentialsFor(origin)
      if (accounts.length === 1) fill(event.sender, accounts[0].id)
    }
    tell()
  })

  ipcMain.handle('pw:submitted', (event, value: unknown) => {
    // Top frame only: a login form inside an embedded frame is not this site's.
    if (!event.senderFrame || event.senderFrame.parent !== null) return
    const origin = originOf(event.senderFrame?.url)
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
    return {
      origin,
      count: credentialCount(origin),
      vault: vaultState(),
      accounts: credentialsFor(origin),
      hasForm: formsSeen.get(tab.id) === origin
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
      isPasswordsPage(event.senderFrame?.url) ? handler(...args) : null

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
