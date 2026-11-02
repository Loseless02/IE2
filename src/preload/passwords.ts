import { ipcRenderer, webFrame } from 'electron'

/**
 * The password manager's eyes and hands inside a web page.
 *
 * Runs in the preload's isolated world, so the page's own scripts cannot see
 * or call any of this. It notices login forms, notices a login being
 * submitted, fills a login the main process sends back, and shows the list of
 * saved logins under a login field. It never decides anything — which site a
 * login belongs to is worked out in the main process from the frame's real
 * address, not from anything said here.
 */

/** Visible on screen, and something a person could type in. */
function usable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false
  const box = input.getBoundingClientRect()
  if (box.width < 2 || box.height < 2) return false
  const style = getComputedStyle(input)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function passwordFields(root: ParentNode = document): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(usable)
}

const TEXTLIKE = 'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'

/** Says what it is for: a username or email, by its autocomplete hint, type or name. */
function looksLikeUsername(input: HTMLInputElement): boolean {
  if (/username|email|webauthn/i.test(input.autocomplete || '')) return true
  if (input.type === 'email') return true
  return /user|email|login|identifier|account/i.test(`${input.name} ${input.id}`)
}

/** The field a username goes in: the closest likely input before the password. */
function usernameFieldFor(password: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? document
  const candidates = [...scope.querySelectorAll<HTMLInputElement>(TEXTLIKE)].filter(usable)

  const hinted = candidates.find((input) =>
    /username|email/i.test(input.autocomplete || '')
  )
  if (hinted) return hinted

  // The last candidate that comes before the password field in the document.
  let best: HTMLInputElement | null = null
  for (const input of candidates) {
    if (input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) best = input
  }
  return best
}

/**
 * The username field of a page that asks for the username on its own, before
 * the password — Google's and Microsoft's sign-ins do.
 */
function usernameOnlyField(): HTMLInputElement | null {
  if (lastField?.isConnected && lastField.type !== 'password' && usable(lastField)) return lastField
  return [...document.querySelectorAll<HTMLInputElement>(TEXTLIKE)].find(
    (input) => usable(input) && looksLikeUsername(input)
  ) ?? null
}

/** A field the list of saved logins belongs under. */
function isLoginField(input: HTMLInputElement): boolean {
  if (!usable(input)) return false
  if (input.type === 'password') return true
  if (!['text', 'email', 'tel'].includes(input.type)) return false
  if (looksLikeUsername(input)) return true
  const password = passwordFields()[0]
  return Boolean(password && usernameFieldFor(password) === input)
}

/** Password fields already reported, so one that appears later is reported too. */
const reportedFields = new WeakSet<HTMLInputElement>()
let lastSent = ''

function lookForForms(): void {
  const fresh = passwordFields().filter((field) => !reportedFields.has(field))
  if (fresh.length === 0) return
  for (const field of fresh) reportedFields.add(field)
  void ipcRenderer.invoke('pw:form-found')
}

/**
 * Read what is about to be submitted. A change-password form has the old
 * password and the new one twice; the new one is what is worth keeping.
 */
function capture(from: Element | null): void {
  const scope: ParentNode = (from && (from.closest('form') as ParentNode | null)) ?? document
  const fields = passwordFields(scope).filter((field) => field.value)
  if (fields.length === 0) return

  // On a sign-in form this is the only field; on a change-password form the
  // last one is the new password (or its confirmation, which is the same).
  const password = fields[fields.length - 1].value

  const username = usernameFieldFor(fields[0])?.value.trim() ?? ''
  const signature = `${username}\u0000${password}`
  // A click on Submit and the submit event that follows are one login.
  if (signature === lastSent) return
  lastSent = signature
  setTimeout(() => (lastSent = ''), 3000)

  void ipcRenderer.invoke('pw:submitted', { username, password })
}

/** Put a value in the way a person typing would, so the page's own scripts see it. */
function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Fill whatever this page has room for, and say what that was. */
function fillLogin(login: { username: string; password: string }): 'both' | 'username' | 'password' | 'none' {
  const password = passwordFields()[0]
  const username = password ? usernameFieldFor(password) : usernameOnlyField()

  const wroteUsername = Boolean(username && login.username)
  if (username && login.username) setValue(username, login.username)
  if (password) setValue(password, login.password)

  if (password) return wroteUsername ? 'both' : 'password'
  return wroteUsername ? 'username' : 'none'
}

// --- passkeys ---------------------------------------------------------------
//
// Sign-in pages ask on load for passkeys "conditionally": a browser is meant to
// offer them quietly in its autofill list and wait. Electron has no such list
// and hands the request straight to Windows, which throws its passkey dialog
// over the page before anything was clicked. So in the page's own world the
// conditional request is held — still pending, as the site expects — and the
// login list offers "Use a passkey". Choosing it makes the real request, and
// only then does Windows ask. Some pages — Amazon's two-step check — make an
// ordinary request on load, with nothing clicked; that is held the same way.
// A passkey button on the site itself comes with a click, and goes through.

const PASSKEY_SHIM = `(() => {
  const credentials = navigator.credentials
  if (!credentials || typeof credentials.get !== 'function') return
  const get = credentials.get.bind(credentials)
  let waiting = null
  const say = (name) => document.dispatchEvent(new Event(name))
  // Asked for means a real click or key press on this page in the last few
  // seconds. Not navigator.userActivation: a page opened by a click arrives
  // already "activated", which is exactly the case to hold.
  let lastGesture = -Infinity
  const gesture = (event) => { if (event.isTrusted) lastGesture = performance.now() }
  addEventListener('pointerdown', gesture, true)
  addEventListener('keydown', gesture, true)
  const unasked = () => performance.now() - lastGesture > 5000
  credentials.get = function (options) {
    if (!options || !options.publicKey) return get(options)
    if (options.mediation !== 'conditional' && !unasked()) return get(options)
    const signal = options.signal
    if (signal && signal.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const entry = { options, resolve, reject }
      waiting = entry
      if (signal) signal.addEventListener('abort', () => {
        if (waiting !== entry) return
        waiting = null
        reject(signal.reason)
        say('ie2-passkey-withdrawn')
      }, { once: true })
      say('ie2-passkey-offered')
    })
  }
  document.addEventListener('ie2-passkey-use', () => {
    const entry = waiting
    if (!entry) return
    waiting = null
    const { mediation, ...rest } = entry.options
    get(rest).then(entry.resolve, entry.reject)
  })
})()`

/** The page is waiting on a passkey, held back for the login list to offer. */
let passkeyWaiting = false

function watchPasskeys(): void {
  try {
    void webFrame.executeJavaScript(PASSKEY_SHIM, true)
  } catch {
    // Without it the site's request reaches Windows as before.
    return
  }
  document.addEventListener('ie2-passkey-offered', () => {
    passkeyWaiting = true
    // Asked after the field already had focus: show the list now.
    const focused = document.activeElement
    if (focused instanceof HTMLInputElement && focused !== anchor && isLoginField(focused)) void openList(focused)
  })
  document.addEventListener('ie2-passkey-withdrawn', () => (passkeyWaiting = false))
}

function usePasskey(): void {
  closeList()
  passkeyWaiting = false
  document.dispatchEvent(new Event('ie2-passkey-use'))
}

// --- the list under a login field ---------------------------------------------

interface Suggestions {
  vault: 'missing' | 'locked' | 'unlocked'
  count: number
  accounts: { id: number; username: string }[]
}

const LIST_CSS = `
  :host { all: initial; }
  .list {
    box-sizing: border-box; min-width: 240px; max-width: 360px; padding: 4px 0;
    font: 13px/1.3 system-ui, "Segoe UI", sans-serif;
    color: #1f1f1f; background: #fff; border: 1px solid rgba(0, 0, 0, .12);
    border-radius: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, .22);
    overflow: hidden;
  }
  .row { display: flex; align-items: center; gap: 10px; padding: 7px 12px; cursor: default; }
  .row.active { background: rgba(0, 0, 0, .07); }
  .row svg { flex: none; width: 16px; height: 16px; opacity: .7; }
  .text { min-width: 0; }
  .main, .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .main { font-weight: 600; }
  .sub { opacity: .65; font-size: 12px; letter-spacing: 1px; }
  .sub.words { letter-spacing: normal; }
  .rule { height: 1px; margin: 4px 0; background: rgba(0, 0, 0, .1); }
  @media (prefers-color-scheme: dark) {
    .list { color: #e8e8e8; background: #232323; border-color: rgba(255, 255, 255, .12); }
    .row.active { background: rgba(255, 255, 255, .09); }
    .rule { background: rgba(255, 255, 255, .1); }
  }
`

const KEY_PATH =
  'M7 14a5 5 0 1 1 4.9-6H22v4h-2v3h-3v-3h-5.1A5 5 0 0 1 7 14Zm0-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'

let host: HTMLElement | null = null
let listEl: HTMLElement | null = null
let anchor: HTMLInputElement | null = null
/** The login field the list was last shown under, which a fill prefers. */
let lastField: HTMLInputElement | null = null
let rows: { el: HTMLElement; choose: () => void }[] = []
let active = -1
/** Bumped on every open and close, so a slow answer for an old field is dropped. */
let generation = 0

function keyIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', KEY_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.append(path)
  return svg
}

/**
 * The list lives in a closed shadow root: the page's styles cannot reach it
 * and its scripts cannot read it. Styles go in through a constructed sheet,
 * which a page's Content-Security-Policy does not block the way it blocks a
 * <style> element.
 */
function ensureHost(): HTMLElement {
  if (host && listEl) {
    if (!host.isConnected) document.documentElement.append(host)
    return listEl
  }
  host = document.createElement('ie2-logins')
  const shadow = host.attachShadow({ mode: 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(LIST_CSS)
  shadow.adoptedStyleSheets = [sheet]
  listEl = document.createElement('div')
  listEl.className = 'list'
  listEl.setAttribute('role', 'listbox')
  // Clicking the list must not take focus away from the field.
  listEl.addEventListener('mousedown', (event) => event.preventDefault())
  shadow.append(listEl)
  document.documentElement.append(host)
  return listEl
}

function place(): void {
  if (!host || !anchor) return
  if (!anchor.isConnected || !usable(anchor)) return closeList()
  const style = host.style
  style.setProperty('position', 'fixed', 'important')
  style.setProperty('z-index', '2147483647', 'important')
  style.setProperty('display', 'block', 'important')

  // Below the field, or above it when there is no room below.
  const box = anchor.getBoundingClientRect()
  const height = listEl?.offsetHeight ?? 0
  const below = box.bottom + 4
  const top = below + height > window.innerHeight && box.top - height - 4 > 0 ? box.top - height - 4 : below
  style.setProperty('top', `${Math.round(top)}px`, 'important')
  style.setProperty('left', `${Math.round(Math.max(4, Math.min(box.left, window.innerWidth - 244)))}px`, 'important')
}

function highlight(index: number): void {
  active = index
  rows.forEach((row, i) => row.el.classList.toggle('active', i === index))
}

function addRow(list: HTMLElement, main: string, sub: string, choose: () => void, words = false): void {
  const el = document.createElement('div')
  el.className = 'row'
  el.setAttribute('role', 'option')
  const text = document.createElement('div')
  text.className = 'text'
  const first = document.createElement('div')
  first.className = 'main'
  first.textContent = main
  text.append(first)
  if (sub) {
    const second = document.createElement('div')
    second.className = words ? 'sub words' : 'sub'
    second.textContent = sub
    text.append(second)
  }
  el.append(keyIcon(), text)
  const index = rows.length
  el.addEventListener('mouseenter', () => highlight(index))
  // Only a real click: a page cannot pick a login by faking one.
  el.addEventListener('click', (event) => {
    if (event.isTrusted) choose()
  })
  rows.push({ el, choose })
  list.append(el)
}

function closeList(): void {
  generation++
  anchor = null
  rows = []
  active = -1
  host?.style.setProperty('display', 'none', 'important')
}

async function openList(input: HTMLInputElement): Promise<void> {
  const mine = ++generation
  const found = (await ipcRenderer.invoke('pw:suggest')) as Suggestions | null
  if (mine !== generation || document.activeElement !== input || (!found && !passkeyWaiting)) return

  anchor = input
  lastField = input
  rows = []
  active = -1
  const list = ensureHost()
  list.replaceChildren()

  const choose = (id: number) => (): void => {
    closeList()
    void ipcRenderer.invoke('pw:fill-mine', id)
  }
  const openPanel = (): void => {
    closeList()
    void ipcRenderer.invoke('pw:open-panel')
  }

  if (found?.vault === 'unlocked') {
    for (const account of found.accounts) {
      addRow(list, account.username || '(no username)', '••••••••', choose(account.id))
    }
  } else if (found) {
    const what = `${found.count} saved login${found.count === 1 ? '' : 's'} for this site`
    addRow(list, 'Unlock IE2 passwords', what, openPanel, true)
  }

  if (passkeyWaiting) addRow(list, 'Use a passkey', 'Phone, security key or Windows Hello', usePasskey, true)

  if (found) {
    const rule = document.createElement('div')
    rule.className = 'rule'
    list.append(rule)
    addRow(list, 'Saved passwords…', '', openPanel)
  }

  place()
}

function watchLoginFields(): void {
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      if (target instanceof HTMLInputElement && isLoginField(target)) void openList(target)
      else closeList()
    },
    true
  )
  document.addEventListener('focusout', (event) => {
    if (event.target === anchor) closeList()
  }, true)
  // Clicking the field again after Esc, or after typing closed it.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (target instanceof HTMLInputElement && target !== anchor && target === document.activeElement && isLoginField(target)) {
        void openList(target)
      }
    },
    true
  )
  // Typing means the person is not choosing a saved login.
  document.addEventListener('input', (event) => {
    if (event.isTrusted && event.target === anchor) closeList()
  }, true)
  document.addEventListener(
    'keydown',
    (event) => {
      if (!anchor || event.target !== anchor || rows.length === 0 || !event.isTrusted) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1
        highlight((active + step + rows.length) % rows.length)
      } else if (event.key === 'Enter' && active >= 0) {
        rows[active].choose()
      } else if (event.key === 'Escape') {
        closeList()
      } else {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true
  )
  window.addEventListener('scroll', place, { capture: true, passive: true })
  window.addEventListener('resize', place, { passive: true })
}

export function watchForLogins(): void {
  const start = (): void => {
    lookForForms()

    // Single-page sites draw their login forms long after the page has loaded,
    // and email-first sign-ins swap the username field for a password field.
    let pending: number | undefined
    new MutationObserver(() => {
      window.clearTimeout(pending)
      pending = window.setTimeout(lookForForms, 400)
    }).observe(document.documentElement, { childList: true, subtree: true })
  }

  // First, before the page's own scripts take a reference to credentials.get.
  watchPasskeys()

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  watchLoginFields()

  // Forms that really submit, buttons that sign in by script, and Enter in the field.
  document.addEventListener('submit', (event) => capture(event.target as Element), true)
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null
      const button = target?.closest('button, input[type="submit"], [role="button"]')
      if (button && passwordFields().some((field) => field.value)) capture(button)
    },
    true
  )
  document.addEventListener(
    'keydown',
    (event) => {
      const target = event.target as HTMLInputElement | null
      if (event.key === 'Enter' && target?.type === 'password' && target.value) capture(target)
    },
    true
  )

  ipcRenderer.on('pw:fill', (_event, login: { username: string; password: string }) => {
    void ipcRenderer.invoke('pw:fill-result', fillLogin(login))
  })
}
