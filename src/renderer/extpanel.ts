import './extpanel.css'
import { icon } from './icons'
import type { ExtensionInfo } from '../shared/types'

/**
 * The extensions panel: every installed Chrome extension, to click, pin, or
 * manage. Built once here and used by the browser's toolbar and an installed
 * app's title bar, which differ only in where it hangs.
 */

type Anchor = { x: number; y: number; width: number; height: number }

export interface ExtPanelOptions {
  list: () => Promise<ExtensionInfo[]>
  /** Its button was clicked: open its popup, hanging from `anchor`. */
  click: (id: string, anchor: Anchor) => void
  /** Options, pinning, turning off, removing. */
  menu: (id: string) => void
  /** Pinning, where the host has a toolbar to pin to. */
  pin?: (id: string, pinned: boolean) => void
  store: () => void
  /** The panel's own button, which popups opened from the panel hang from. */
  anchor: () => HTMLElement
  /** The host closes the panel. */
  close: () => void
  resized: () => void
}

export interface ExtPanel {
  /** Ask for the list again and draw it. */
  open: () => Promise<void>
  draw: (list: ExtensionInfo[]) => void
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/** Where an element is, in the window's coordinates — the chrome view sits at its corner. */
export function anchorOf(element: HTMLElement): Anchor {
  const box = element.getBoundingClientRect()
  return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
}

/** An extension's icon with its badge, for a row or a toolbar button. */
export function extensionIcon(info: ExtensionInfo): HTMLElement {
  const wrap = make('span', 'ext-icon')
  if (info.icon) {
    const image = make('img')
    image.src = info.icon
    image.alt = ''
    image.draggable = false
    wrap.append(image)
  } else {
    wrap.append(icon('puzzle'))
  }
  if (info.badgeText && info.enabled) {
    const badge = make('span', 'ext-badge', info.badgeText.slice(0, 4))
    badge.style.background = info.badgeColor
    badge.style.color = info.badgeTextColor
    wrap.append(badge)
  }
  return wrap
}

export function createExtPanel(root: HTMLElement, options: ExtPanelOptions): ExtPanel {
  root.classList.add('ext-panel')

  const draw = (list: ExtensionInfo[]): void => {
    const head = make('div', 'panel-head')
    head.append(make('span', '', 'Extensions'))
    root.replaceChildren(head)

    if (list.length === 0) {
      root.append(
        make(
          'p',
          'ext-empty',
          'No extensions yet. The Chrome Web Store works here: open an extension there and press Add to Chrome.'
        )
      )
    }

    const rows = make('div', 'ext-rows')
    for (const info of list) {
      const row = make('div', 'ext-row')
      row.classList.toggle('off', !info.enabled)

      const main = make('button', 'ext-main')
      main.title = info.enabled ? info.title : `${info.name} is turned off`
      main.disabled = !info.enabled || info.actionDisabled
      const text = make('span', 'ext-name', info.name)
      main.append(extensionIcon(info), text)
      if (!info.enabled) main.append(make('span', 'ext-state', 'Off'))
      main.addEventListener('click', () => {
        options.close()
        options.click(info.id, anchorOf(options.anchor()))
      })
      row.append(main)

      if (options.pin && info.enabled) {
        const pin = make('button', 'ext-tool')
        pin.classList.toggle('on', info.pinned)
        pin.title = info.pinned ? 'Unpin from the toolbar' : 'Pin to the toolbar'
        pin.append(icon('tack'))
        pin.addEventListener('click', () => options.pin?.(info.id, !info.pinned))
        row.append(pin)
      }

      const more = make('button', 'ext-tool')
      more.title = 'Options, turn off, remove'
      more.append(icon('more'))
      more.addEventListener('click', () => options.menu(info.id))
      row.append(more)

      rows.append(row)
    }
    root.append(rows)

    const store = make('button', 'ext-store', 'Get extensions from the Chrome Web Store')
    store.prepend(icon('puzzle'))
    store.addEventListener('click', () => {
      options.close()
      options.store()
    })
    root.append(store)
    options.resized()
  }

  return {
    draw,
    open: async () => draw(await options.list())
  }
}
