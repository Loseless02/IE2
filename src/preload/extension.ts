import { contextBridge, ipcRenderer } from 'electron'

/**
 * The parts of Chrome's extension API that Electron leaves out, for extensions'
 * own pages and background service workers.
 *
 * Electron runs extensions — their content scripts, storage, messaging — but
 * has no browser around them: no toolbar button, no badge, no right-click
 * items, and no idea which tab is in front. Those calls are answered here and
 * carried to the main process, which knows. Registered on the browsing session
 * for frames and for service workers alike; anywhere that is not an
 * extension's own page, it does nothing.
 */

type Call = (method: string, args: unknown[]) => Promise<unknown>
type Listen = (handler: (name: string, args: unknown[]) => void) => void

/**
 * Runs in the extension's own world, where `chrome` lives. It is serialised
 * across, so it must not touch anything outside itself.
 */
function install(call: Call, listen: Listen, inWorker: boolean): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const chrome = (globalThis as any).chrome
  if (!chrome?.runtime?.id) return

  // A worker can call before the browser has finished wiring it up; such a
  // call is tried again for a moment rather than lost.
  const send = call
  call = async (name, args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(name, args)
      } catch (error) {
        if (attempt >= 20 || !/No handler registered/i.test(String(error))) throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }

  // --- events ---

  const handlers: Record<string, Set<(...args: any[]) => void>> = {}
  const announced = new Set<string>()
  listen((name, args) => {
    for (const handler of [...(handlers[name] ?? [])]) {
      try {
        handler(...args)
      } catch (error) {
        console.error(error)
      }
    }
  })

  const event = (name: string): Record<string, unknown> => {
    const set = (handlers[name] ??= new Set())
    return {
      addListener(handler: (...args: any[]) => void) {
        set.add(handler)
        // Told once, so a stopped worker is woken only for what it listens to.
        if (!announced.has(name)) {
          announced.add(name)
          void call('events.listen', [name])
        }
      },
      removeListener(handler: (...args: any[]) => void) {
        set.delete(handler)
      },
      hasListener(handler: (...args: any[]) => void) {
        return set.has(handler)
      },
      hasListeners() {
        return set.size > 0
      }
    }
  }

  // --- calls: Chrome's callback-or-promise convention ---

  const method =
    (name: string, prepare?: (args: any[]) => any[]) =>
    (...args: any[]): any => {
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null
      const result = call(name, prepare ? prepare(args) : args).then((value) => (value === null ? undefined : value))
      if (!callback) return result
      result.then(
        (value) => callback(value),
        (error) => {
          console.error(error)
          callback()
        }
      )
      return undefined
    }

  /** Adds to an API, or makes it. `keep` leaves anything already there alone. */
  const extend = (name: string, mine: Record<string, unknown>, keep = false): void => {
    let target = chrome[name]
    if (!target) {
      target = {}
      try {
        chrome[name] = target
      } catch {
        // Read-only: defined below instead.
      }
      if (chrome[name] !== target) {
        try {
          Object.defineProperty(chrome, name, { value: target, configurable: true, enumerable: true, writable: true })
        } catch {
          return
        }
      }
    }
    for (const [key, value] of Object.entries(mine)) {
      if (keep && target[key] !== undefined) continue
      try {
        target[key] = value
      } catch {
        // Tried again below.
      }
      if (target[key] !== value) {
        try {
          Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true })
        } catch {
          // A frozen API: what Electron has stays.
        }
      }
    }
  }

  const noFunctions = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value
    const copy: Record<string, unknown> = {}
    for (const [key, each] of Object.entries(value)) if (typeof each !== 'function') copy[key] = each
    return copy
  }

  // An icon drawn by the extension arrives as pixels; they travel as plain numbers.
  const pixels = (image: any): unknown =>
    image && typeof image === 'object' && 'data' in image && 'width' in image
      ? { width: image.width, height: image.height, data: Array.from(image.data as ArrayLike<number>) }
      : null
  const iconArgs = (args: any[]): any[] => {
    const details = { ...(args[0] ?? {}) }
    const data = details.imageData
    if (data) {
      if ('data' in data) details.imageData = pixels(data)
      else {
        const sizes = Object.keys(data).map(Number).sort((a, b) => a - b)
        const best = sizes.find((size) => size >= 32) ?? sizes[sizes.length - 1]
        details.imageData = pixels(data[best])
      }
    }
    return [details]
  }

  // --- the toolbar button ---

  const onClicked = event('action.onClicked')
  const action = {
    setBadgeText: method('action.setBadgeText'),
    getBadgeText: method('action.getBadgeText'),
    setBadgeBackgroundColor: method('action.setBadgeBackgroundColor'),
    getBadgeBackgroundColor: method('action.getBadgeBackgroundColor'),
    setBadgeTextColor: method('action.setBadgeTextColor'),
    getBadgeTextColor: method('action.getBadgeTextColor'),
    setTitle: method('action.setTitle'),
    getTitle: method('action.getTitle'),
    setPopup: method('action.setPopup'),
    getPopup: method('action.getPopup'),
    setIcon: method('action.setIcon', iconArgs),
    enable: method('action.enable'),
    disable: method('action.disable'),
    isEnabled: method('action.isEnabled'),
    openPopup: method('action.openPopup'),
    getUserSettings: method('action.getUserSettings'),
    onClicked
  }
  extend('action', action)
  extend('browserAction', action)

  // --- right-click menu items ---

  const clicks = new Map<string, (...args: any[]) => void>()
  let nextMenuId = 1
  const contextMenusClicked = event('contextMenus.onClicked')
  // Items made with an `onclick` of their own (Manifest V2) hear it here.
  ;(contextMenusClicked.addListener as (handler: (...args: any[]) => void) => void)((info: any, tab: any) =>
    clicks.get(String(info?.menuItemId))?.(info, tab)
  )
  extend('contextMenus', {
    create(properties: any, callback?: () => void) {
      const id = properties?.id ?? `ie2-${nextMenuId++}`
      if (typeof properties?.onclick === 'function') clicks.set(String(id), properties.onclick)
      void call('contextMenus.create', [{ ...(noFunctions(properties) as object), id }]).then(
        () => callback?.(),
        () => callback?.()
      )
      return id
    },
    update: method('contextMenus.update', (args) => {
      if (typeof args[1]?.onclick === 'function') clicks.set(String(args[0]), args[1].onclick)
      return [args[0], noFunctions(args[1])]
    }),
    remove: method('contextMenus.remove', (args) => {
      clicks.delete(String(args[0]))
      return args
    }),
    removeAll: method('contextMenus.removeAll', (args) => {
      clicks.clear()
      return args
    }),
    onClicked: contextMenusClicked,
    ACTION_MENU_TOP_LEVEL_LIMIT: 6
  })

  // --- tabs and windows: which exist, and which is in front ---

  extend('tabs', {
    query: method('tabs.query'),
    get: method('tabs.get'),
    getCurrent: method('tabs.getCurrent'),
    create: method('tabs.create'),
    update: method('tabs.update', (args) => (typeof args[0] === 'object' ? [undefined, args[0]] : args)),
    remove: method('tabs.remove'),
    duplicate: method('tabs.duplicate'),
    highlight: method('tabs.highlight'),
    captureVisibleTab: method('tabs.captureVisibleTab', (args) =>
      typeof args[0] === 'object' ? [undefined, args[0]] : args
    ),
    onActivated: event('tabs.onActivated'),
    onUpdated: event('tabs.onUpdated'),
    onCreated: event('tabs.onCreated'),
    onRemoved: event('tabs.onRemoved'),
    onHighlighted: event('tabs.onHighlighted'),
    onMoved: event('tabs.onMoved'),
    onReplaced: event('tabs.onReplaced'),
    TAB_ID_NONE: -1
  })

  const windowArgs = (args: any[]): any[] => (typeof args[0] === 'number' ? args : [undefined, ...args])
  extend('windows', {
    get: method('windows.get'),
    getCurrent: method('windows.getCurrent', (args) => [undefined, ...args]),
    getLastFocused: method('windows.getLastFocused', (args) => [undefined, ...args]),
    getAll: method('windows.getAll', (args) => [undefined, ...args]),
    create: method('windows.create'),
    update: method('windows.update', windowArgs),
    remove: method('windows.remove'),
    onCreated: event('windows.onCreated'),
    onRemoved: event('windows.onRemoved'),
    onFocusChanged: event('windows.onFocusChanged'),
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2
  })

  // --- notifications ---

  extend('notifications', {
    create: method('notifications.create', (args) => (typeof args[0] === 'string' ? args : ['', ...args])),
    update: method('notifications.update'),
    clear: method('notifications.clear'),
    getAll: method('notifications.getAll'),
    getPermissionLevel: method('notifications.getPermissionLevel'),
    onClicked: event('notifications.onClicked'),
    onClosed: event('notifications.onClosed'),
    onButtonClicked: event('notifications.onButtonClicked')
  })

  // --- keyboard shortcuts, alarms, permissions ---

  extend('commands', {
    getAll: method('commands.getAll'),
    onCommand: event('commands.onCommand')
  })

  extend('alarms', {
    create: method('alarms.create', (args) => (typeof args[0] === 'string' ? args : ['', ...args])),
    get: method('alarms.get', (args) => (typeof args[0] === 'string' ? args : [''])),
    getAll: method('alarms.getAll'),
    clear: method('alarms.clear', (args) => (typeof args[0] === 'string' ? args : [''])),
    clearAll: method('alarms.clearAll'),
    onAlarm: event('alarms.onAlarm')
  })

  extend('permissions', {
    contains: method('permissions.contains'),
    getAll: method('permissions.getAll'),
    request: method('permissions.request'),
    remove: method('permissions.remove'),
    onAdded: event('permissions.onAdded'),
    onRemoved: event('permissions.onRemoved')
  })

  extend('downloads', {
    download: method('downloads.download'),
    onChanged: event('downloads.onChanged'),
    onCreated: event('downloads.onCreated')
  })

  // IE2 has no side panel. Asking about it should not stop the rest working.
  extend('sidePanel', {
    setPanelBehavior: method('sidePanel.ignored'),
    setOptions: method('sidePanel.ignored'),
    getOptions: method('sidePanel.getOptions'),
    getPanelBehavior: method('sidePanel.getOptions'),
    open: method('sidePanel.ignored')
  })

  // --- small things Electron leaves out ---

  extend('runtime', { openOptionsPage: method('runtime.openOptionsPage') }, true)
  // Electron never says an extension was just installed or updated, and that
  // is where most extensions make their right-click items. The browser says it.
  extend('runtime', { onInstalled: event('runtime.onInstalled') })
  // Without an account to sync to, "sync" storage is the local kind.
  if (chrome.storage?.local) extend('storage', { sync: chrome.storage.local }, true)

  // A popup closing itself closes the popup, not some window behind it.
  if (!inWorker) {
    ;(globalThis as any).close = () => void call('window.close', [])
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// A worker's preload has no window and cannot see its own address; `install`
// checks for itself that it is in an extension. A frame can look, and every
// web page is spared the work.
const inWorker = typeof window === 'undefined'

if (inWorker || location.protocol === 'chrome-extension:') {
  const call: Call = (method, args) => ipcRenderer.invoke('ext:call', method, args)
  const listen: Listen = (handler) => {
    ipcRenderer.on('ext:event', (_event, name: string, args: unknown[]) => handler(name, args))
  }
  try {
    contextBridge.executeInMainWorld({ func: install, args: [call, listen, inWorker] })
  } catch (error) {
    console.error('IE2 extension support failed to start', error)
  }
}
