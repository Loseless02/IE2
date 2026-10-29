import { applyTheme } from './theme'
import { icon } from './icons'
import { confirmDialog } from './dialog'
import type { CredentialSummary, VaultStatus } from '../shared/types'
import type { Settings } from '../shared/settings'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const vault = window.ie2.vault

let status: VaultStatus | null = null
let logins: CredentialSummary[] = []
let settings: Settings | null = null

/** The login being edited, or 0 for a new one. */
let editingId = 0

/** Passwords on screen, hidden again after this long. */
const REVEAL_MS = 20_000
const revealed = new Map<number, string>()

let noteTimer: number | undefined
function note(text: string): void {
  el('note').textContent = text
  window.clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => (el('note').textContent = ''), 3000)
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function show(section: 'setup' | 'locked' | 'open'): void {
  el('setup').hidden = section !== 'setup'
  el('locked').hidden = section !== 'locked'
  el('open').hidden = section !== 'open'
}

async function refresh(): Promise<void> {
  status = await vault.status()

  if (!status.exists) {
    show('setup')
    return
  }
  if (!status.unlocked) {
    revealed.clear()
    el('locked-hint').textContent =
      status.count === 1 ? '1 saved login.' : `${status.count} saved logins.`
    show('locked')
    if (document.activeElement?.id !== 'unlock-pass') el('unlock-pass').focus()
    return
  }

  logins = await vault.list()
  show('open')
  render()
}

function render(): void {
  const needle = el<HTMLInputElement>('filter').value.trim().toLowerCase()
  const visible = logins.filter(
    (login) => !needle || login.origin.toLowerCase().includes(needle) || login.username.toLowerCase().includes(needle)
  )
  el('count').textContent =
    visible.length === logins.length ? `${logins.length} saved` : `${visible.length} of ${logins.length}`

  const list = el('list')
  list.replaceChildren()

  if (logins.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Nothing saved yet. Sign in somewhere and IE2 offers to keep it — or add one here, or import a CSV.'
    list.append(empty)
    return
  }

  for (const login of visible) {
    const row = document.createElement('div')
    row.className = 'login'

    const site = document.createElement('div')
    site.className = 'site'
    const host = document.createElement('b')
    host.textContent = hostOf(login.origin)
    const user = document.createElement('span')
    user.textContent = login.username || '(no username)'
    site.append(host, user)

    const secret = document.createElement('code')
    secret.className = 'secret'
    const plain = revealed.get(login.id)
    secret.textContent = plain ?? '••••••••••'
    secret.classList.toggle('shown', plain !== undefined)

    const tools = document.createElement('div')
    tools.className = 'tools'
    const tool = (name: string, title: string, run: () => void): void => {
      const button = document.createElement('button')
      button.title = title
      button.append(icon(name))
      button.addEventListener('click', run)
      tools.append(button)
    }

    tool('eye', plain ? 'Hide' : 'Show for 20 seconds', () => void toggleReveal(login.id))
    tool('copy', 'Copy password', () => void copySecret(login.id))
    tool('text', 'Edit', () => void openEditor(login.id))
    tool('close', 'Delete', () => void remove(login))

    row.append(site, secret, tools)
    list.append(row)
  }
}

async function toggleReveal(id: number): Promise<void> {
  if (revealed.has(id)) {
    revealed.delete(id)
    render()
    return
  }
  const login = await vault.reveal(id)
  if (!login) return void refresh()
  revealed.set(id, login.password)
  render()
  window.setTimeout(() => {
    revealed.delete(id)
    render()
  }, REVEAL_MS)
}

async function copySecret(id: number): Promise<void> {
  const login = await vault.reveal(id)
  if (!login) return void refresh()
  await window.ie2.copyText(login.password)
  note('Password copied')
}

async function remove(login: CredentialSummary): Promise<void> {
  const sure = await confirmDialog({
    title: 'Delete this login?',
    body: [`${login.username || 'The login'} on ${hostOf(login.origin)} will be gone for good.`],
    confirmLabel: 'Delete',
    danger: true
  })
  if (!sure) return
  await vault.remove(login.id)
  note('Deleted')
  await refresh()
}

// --- setting up and unlocking -------------------------------------------------

el('setup-go').addEventListener('click', async () => {
  const pass = el<HTMLInputElement>('setup-pass').value
  const again = el<HTMLInputElement>('setup-confirm').value
  if (pass.length < 8) return void (el('setup-error').textContent = 'Use at least 8 characters.')
  if (pass !== again) return void (el('setup-error').textContent = 'The two do not match.')
  const result = await vault.create(pass)
  el('setup-error').textContent = result.ok ? '' : (result.error ?? 'Could not create the vault.')
  el<HTMLInputElement>('setup-pass').value = ''
  el<HTMLInputElement>('setup-confirm').value = ''
  await refresh()
})

async function unlock(): Promise<void> {
  const input = el<HTMLInputElement>('unlock-pass')
  const result = await vault.unlock(input.value)
  input.value = ''
  el('unlock-error').textContent = result.ok ? '' : (result.error ?? 'Could not unlock.')
  await refresh()
}

el('unlock-go').addEventListener('click', () => void unlock())
for (const [id, run] of [
  ['unlock-pass', unlock],
  ['setup-confirm', () => el('setup-go').click()],
  ['export-pass', () => el('export-go').click()]
] as [string, () => void][]) {
  el(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void run()
  })
}

el('forgot').addEventListener('click', () => (el('forgot-confirm').hidden = false))
el('forgot-cancel').addEventListener('click', () => (el('forgot-confirm').hidden = true))
el('forgot-wipe').addEventListener('click', async () => {
  await vault.wipe()
  el('forgot-confirm').hidden = true
  await refresh()
})

el('lock').addEventListener('click', async () => {
  await vault.lock()
  await refresh()
})

el<HTMLInputElement>('filter').addEventListener('input', render)

// --- adding and editing ---------------------------------------------------------

async function openEditor(id = 0): Promise<void> {
  editingId = id
  el('editor-title').textContent = id ? 'Edit login' : 'Add login'
  el('ed-error').textContent = ''
  const fields = {
    url: el<HTMLInputElement>('ed-url'),
    user: el<HTMLInputElement>('ed-user'),
    pass: el<HTMLInputElement>('ed-pass'),
    note: el<HTMLInputElement>('ed-note')
  }
  fields.pass.type = 'password'

  if (id) {
    const login = await vault.reveal(id)
    if (!login) return void refresh()
    fields.url.value = login.origin
    fields.user.value = login.username
    fields.pass.value = login.password
    fields.note.value = login.note
  } else {
    for (const field of Object.values(fields)) field.value = ''
  }
  el('editor').hidden = false
  fields.url.focus()
}

el('add').addEventListener('click', () => void openEditor())
el('ed-cancel').addEventListener('click', () => (el('editor').hidden = true))

const showButton = el('ed-show')
showButton.append(icon('eye'))
showButton.addEventListener('click', () => {
  const input = el<HTMLInputElement>('ed-pass')
  input.type = input.type === 'password' ? 'text' : 'password'
})

el('ed-generate').addEventListener('click', async () => {
  const input = el<HTMLInputElement>('ed-pass')
  input.value = await vault.generate()
  input.type = 'text'
})

el('ed-save').addEventListener('click', async () => {
  const url = el<HTMLInputElement>('ed-url').value.trim()
  const password = el<HTMLInputElement>('ed-pass').value
  if (!url || !password) return void (el('ed-error').textContent = 'A website and a password are needed.')

  const saved = await vault.save({
    id: editingId || undefined,
    url,
    username: el<HTMLInputElement>('ed-user').value.trim(),
    password,
    note: el<HTMLInputElement>('ed-note').value
  })
  if (saved === null) return void (el('ed-error').textContent = 'That website address is not valid.')
  el('editor').hidden = true
  note('Saved')
  await refresh()
})

// --- moving logins in and out ---------------------------------------------------

el('import').addEventListener('click', async () => {
  const result = await vault.importCsv()
  if (!result) return
  note(`Imported: ${result.added} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ''}`)
  await refresh()
})

el('export').addEventListener('click', () => {
  el('export-box').hidden = false
  el('export-error').textContent = ''
  el('export-pass').focus()
})
el('export-cancel').addEventListener('click', () => (el('export-box').hidden = true))
el('export-go').addEventListener('click', async () => {
  const input = el<HTMLInputElement>('export-pass')
  const result = await vault.exportCsv(input.value)
  input.value = ''
  if (!result.ok) {
    el('export-error').textContent = result.error ?? ''
    return
  }
  el('export-box').hidden = true
  note('Exported. Delete the file once it is imported elsewhere.')
})

// --- options -----------------------------------------------------------------

async function renderOptions(): Promise<void> {
  settings = await window.ie2.getSettings()
  el<HTMLInputElement>('opt-offer').checked = settings.offerToSavePasswords
  el<HTMLInputElement>('opt-fill').checked = settings.autofillPasswords
  el<HTMLSelectElement>('opt-lock').value = String(settings.vaultLockMinutes)

  const never = el('never')
  never.replaceChildren()
  const sites = await vault.neverList()
  if (sites.length === 0) {
    never.textContent = 'None.'
    never.className = 'hint'
  } else {
    never.className = 'chips'
  }
  for (const origin of sites) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.append(document.createTextNode(hostOf(origin)))
    const remove = document.createElement('button')
    remove.title = 'Offer to save here again'
    remove.append(icon('close'))
    remove.addEventListener('click', async () => {
      await vault.neverRemove(origin)
      await renderOptions()
    })
    chip.append(remove)
    never.append(chip)
  }
}

el<HTMLInputElement>('opt-offer').addEventListener('change', (event) => {
  void window.ie2.setSetting('offerToSavePasswords', (event.target as HTMLInputElement).checked)
})
el<HTMLInputElement>('opt-fill').addEventListener('change', (event) => {
  void window.ie2.setSetting('autofillPasswords', (event.target as HTMLInputElement).checked)
})
el<HTMLSelectElement>('opt-lock').addEventListener('change', (event) => {
  void window.ie2.setSetting('vaultLockMinutes', Number((event.target as HTMLSelectElement).value))
})

el('ch-go').addEventListener('click', async () => {
  const current = el<HTMLInputElement>('ch-current')
  const next = el<HTMLInputElement>('ch-next')
  const again = el<HTMLInputElement>('ch-confirm')
  if (next.value !== again.value) return void (el('ch-error').textContent = 'The new ones do not match.')
  const result = await vault.change(current.value, next.value)
  el('ch-error').textContent = result.ok ? '' : (result.error ?? '')
  if (result.ok) {
    current.value = next.value = again.value = ''
    note('Master password changed')
  }
})

el('wipe').addEventListener('click', async () => {
  const sure = await confirmDialog({
    title: 'Delete the vault?',
    body: ['Every saved login and the master password are deleted. This cannot be undone.'],
    confirmLabel: 'Delete everything',
    danger: true
  })
  if (!sure) return
  await vault.wipe()
  await refresh()
})

el('options').addEventListener('toggle', () => void renderOptions())

async function load(): Promise<void> {
  applyTheme(await window.ie2.getSettings())
  await refresh()
}

// The vault locks itself after a while; the page follows instead of showing
// stale rows that can no longer be read.
window.setInterval(() => {
  if (!status?.unlocked) return
  void vault.status().then((next) => {
    if (!next.unlocked) void refresh()
  })
}, 5000)
window.addEventListener('focus', () => void refresh())

void load()
