import { BrowserWindow } from 'electron'

/**
 * The small window that says IE2 is on its way.
 *
 * The first start after installing or updating is slow — Windows scans the new
 * files before it lets them run — and a browser that shows nothing for ten
 * seconds gets clicked again. Shown the moment Electron can draw, before the
 * database and extensions load, and closed when the real window appears.
 */

let splash: BrowserWindow | null = null

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

export function showSplash(line: string): void {
  if (splash) return
  splash = new BrowserWindow({
    width: 380,
    height: 150,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    // Alt+F4 on it would be the last window closing, which quits the browser
    // that is busy starting behind it.
    closable: false,
    center: true,
    title: 'IE2',
    backgroundColor: '#1c1c20',
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true }
  })
  splash.on('closed', () => (splash = null))

  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; }
    body { background: #1c1c20; color: #fff; font: 14px "Segoe UI", system-ui, sans-serif;
      display: flex; flex-direction: column; justify-content: center; padding: 0 28px;
      box-sizing: border-box; user-select: none; -webkit-app-region: drag; cursor: default; }
    .name { font-size: 28px; font-weight: 600; letter-spacing: .5px; }
    .line { opacity: .6; margin-top: 4px; }
    .track { position: relative; height: 3px; margin-top: 22px; border-radius: 2px;
      background: rgba(255, 255, 255, .1); overflow: hidden; }
    .track::after { content: ""; position: absolute; top: 0; bottom: 0; width: 35%;
      border-radius: 2px; background: #3d8bfd; animation: slide 1.1s ease-in-out infinite; }
    @keyframes slide { from { left: -35%; } to { left: 100%; } }
  </style><div class="name">IE2</div><div class="line">${escape(line)}</div><div class="track"></div>`
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

/** Bring it forward: someone clicked IE2 again while it was starting. */
export function focusSplash(): boolean {
  if (!splash || splash.isDestroyed()) return false
  splash.focus()
  return true
}

export function closeSplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy()
  splash = null
}
