/**
 * Confirmation dialogs for the browser's own pages.
 *
 * `window.confirm` draws Chromium's dialog, which carries the app's internal
 * name in its title bar and the operating system's colours in its chrome. On a
 * page that is part of the browser that reads as a message from somewhere else
 * entirely — exactly the wrong impression for a question about deleting the
 * user's data. This builds the same question in our own surface instead.
 */

import './dialog.css'

export interface ConfirmOptions {
  title: string
  /** Each string is its own paragraph. */
  body: string[]
  /** Label for the button that goes ahead. */
  confirmLabel?: string
  cancelLabel?: string
  /** Marks the action as destructive, which colours the confirming button. */
  danger?: boolean
}

/**
 * Ask, and resolve to what the user chose. Escape and the backdrop both count
 * as cancelling, which is what a destructive question should default to.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'dialog-backdrop'

    const dialog = document.createElement('div')
    dialog.className = 'dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')

    const heading = document.createElement('h2')
    heading.textContent = options.title
    dialog.append(heading)

    for (const paragraph of options.body) {
      const p = document.createElement('p')
      p.textContent = paragraph
      dialog.append(p)
    }

    const buttons = document.createElement('div')
    buttons.className = 'dialog-buttons'

    const cancel = document.createElement('button')
    cancel.className = 'dialog-cancel'
    cancel.textContent = options.cancelLabel ?? 'Cancel'

    const confirm = document.createElement('button')
    confirm.className = options.danger ? 'dialog-confirm danger' : 'dialog-confirm'
    confirm.textContent = options.confirmLabel ?? 'Continue'

    buttons.append(cancel, confirm)
    dialog.append(buttons)
    backdrop.append(dialog)
    document.body.append(backdrop)

    // Whichever way it ends, the dialog and its key handler go with it.
    const close = (answer: boolean): void => {
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      resolve(answer)
    }

    // Escape only. Enter is left to whichever button has the focus, so it
    // cannot mean "go ahead" while the caret is sitting on Cancel.
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close(false)
    }

    document.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', () => close(false))
    confirm.addEventListener('click', () => close(true))
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close(false)
    })

    // The safe choice takes the focus, so a stray Enter cannot delete anything
    // the user had not read the question about.
    cancel.focus()
  })
}

export interface PromptField {
  name: string
  label: string
  placeholder?: string
  value?: string
  maxLength?: number
}

/**
 * Ask for a few short values. `window.prompt` is Chromium's again, takes one
 * value, and looks like it belongs to another program.
 */
export function promptDialog(options: {
  title: string
  body?: string[]
  fields: PromptField[]
  confirmLabel?: string
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'dialog-backdrop'

    const dialog = document.createElement('div')
    dialog.className = 'dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')

    const heading = document.createElement('h2')
    heading.textContent = options.title
    dialog.append(heading)

    for (const paragraph of options.body ?? []) {
      const p = document.createElement('p')
      p.textContent = paragraph
      dialog.append(p)
    }

    const inputs = new Map<string, HTMLInputElement>()

    for (const field of options.fields) {
      const label = document.createElement('label')
      label.className = 'dialog-field'

      const span = document.createElement('span')
      span.textContent = field.label
      label.append(span)

      const input = document.createElement('input')
      input.type = 'text'
      input.value = field.value ?? ''
      input.placeholder = field.placeholder ?? ''
      if (field.maxLength) input.maxLength = field.maxLength
      label.append(input)

      inputs.set(field.name, input)
      dialog.append(label)
    }

    const buttons = document.createElement('div')
    buttons.className = 'dialog-buttons'

    const cancel = document.createElement('button')
    cancel.className = 'dialog-cancel'
    cancel.textContent = 'Cancel'

    const confirm = document.createElement('button')
    confirm.className = 'dialog-confirm'
    confirm.textContent = options.confirmLabel ?? 'Add'

    buttons.append(cancel, confirm)
    dialog.append(buttons)
    backdrop.append(dialog)
    document.body.append(backdrop)

    const close = (answer: Record<string, string> | null): void => {
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      resolve(answer)
    }

    const submit = (): void => {
      const values: Record<string, string> = {}
      for (const [name, input] of inputs) values[name] = input.value.trim()
      close(values)
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(null)
      }
      // Nothing here is destructive, so Enter may submit.
      if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    }

    document.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', () => close(null))
    confirm.addEventListener('click', submit)
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close(null)
    })

    inputs.values().next().value?.focus()
  })
}
