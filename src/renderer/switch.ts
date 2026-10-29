import './switch.css'

/**
 * The browser's on/off switch. A button rather than a checkbox, so it can be
 * drawn freely, with the state carried in `aria-checked` for screen readers.
 */
export function createSwitch(
  on: boolean,
  onChange: (on: boolean) => void,
  options: { small?: boolean; label?: string } = {}
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = options.small ? 'x-switch small' : 'x-switch'
  button.setAttribute('role', 'switch')
  if (options.label) button.setAttribute('aria-label', options.label)
  setSwitch(button, on)

  button.addEventListener('click', () => {
    const next = !isOn(button)
    setSwitch(button, next)
    onChange(next)
  })
  return button
}

export function setSwitch(button: HTMLElement, on: boolean): void {
  button.classList.toggle('on', on)
  button.setAttribute('aria-checked', String(on))
}

export function isOn(button: HTMLElement): boolean {
  return button.classList.contains('on')
}

/** A switch and its words, clicking either flips it. */
export function switchRow(
  text: string,
  on: boolean,
  onChange: (on: boolean) => void,
  small = true
): { row: HTMLElement; button: HTMLButtonElement } {
  // A div, not a label: a label would click the button a second time.
  const row = document.createElement('div')
  row.className = 'x-switch-row'
  const button = createSwitch(on, onChange, { small, label: text })
  const words = document.createElement('span')
  words.textContent = text
  // Clicking the words flips the switch, like a label for a checkbox.
  words.addEventListener('click', () => button.click())
  row.append(button, words)
  return { row, button }
}
