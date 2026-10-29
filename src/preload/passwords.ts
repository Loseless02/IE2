import { ipcRenderer } from 'electron'

/**
 * The password manager's eyes and hands inside a web page.
 *
 * Runs in the preload's isolated world, so the page's own scripts cannot see
 * or call any of this. It does three things: notices login forms, notices a
 * login being submitted, and fills a login the main process sends back. It
 * never decides anything — which site a login belongs to is worked out in the
 * main process from the frame's real address, not from anything said here.
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

/** The field a username goes in: the closest likely input before the password. */
function usernameFieldFor(password: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? document
  const candidates = [
    ...scope.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
    )
  ].filter(usable)

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

let reported = false
let lastSent = ''

function lookForForms(): void {
  if (reported || passwordFields().length === 0) return
  reported = true
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

export function watchForLogins(): void {
  const start = (): void => {
    lookForForms()

    // Single-page sites draw their login forms long after the page has loaded.
    let pending: number | undefined
    new MutationObserver(() => {
      if (reported) return
      window.clearTimeout(pending)
      pending = window.setTimeout(lookForForms, 400)
    }).observe(document.documentElement, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

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
    const password = passwordFields()[0]
    if (!password) return
    const username = usernameFieldFor(password)
    if (username && login.username) setValue(username, login.username)
    setValue(password, login.password)
  })
}
