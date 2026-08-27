import { app, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Being the browser Windows hands things to.
 *
 * Two halves. The installer registers IE2 as *capable* of handling web links
 * and the file types below — that is `protocols` and `fileAssociations` in
 * electron-builder.yml, and it is what puts the browser in Windows' list at
 * all. This file is the other half: reporting whether it is currently the
 * chosen one, and taking the user to where they can choose it.
 *
 * It cannot simply be set. Windows 10 and 11 deliberately refuse to let a
 * program make itself the default — the choice is stored with a hash tied to
 * the user, and only the Settings app can write it. Anything claiming
 * otherwise on Windows 11 is either lying or about to be broken by an update.
 * So the button registers what it can and then opens the right Settings page,
 * which is the honest version of that feature.
 */

/** Everything a browser should be offered for. */
const PROTOCOLS = ['http', 'https']

/**
 * File types this browser can actually display. HTML and SVG render directly;
 * PDF needs Chromium's viewer, which is why tabs are created with `plugins`
 * enabled — without it a PDF downloads instead of opening.
 */
export const FILE_TYPES = ['html', 'htm', 'pdf', 'svg', 'xml', 'txt', 'json', 'webp']

export function isDefaultBrowser(): boolean {
  return PROTOCOLS.every((scheme) => app.isDefaultProtocolClient(scheme))
}

/**
 * Register for what we can, then hand the user to the Settings page where the
 * actual choice is made. Returns whether registration succeeded — not whether
 * IE2 became the default, which cannot be known until they choose.
 */
export async function requestDefaultBrowser(): Promise<boolean> {
  let registered = true
  for (const scheme of PROTOCOLS) {
    if (!app.setAsDefaultProtocolClient(scheme)) registered = false
  }

  if (process.platform === 'win32') {
    // Windows 11 shows IE2 in this list because the installer registered it.
    await shell.openExternal('ms-settings:defaultapps').catch(() => undefined)
  }

  return registered
}

/**
 * A URL or file path passed on the command line — what Windows sends when IE2
 * is the default browser and something is opened.
 *
 * Local files become `file://` URLs. Anything that is not a URL we recognise or
 * a file that exists is ignored, so a stray flag never navigates a tab.
 */
export function openableFromArgv(argv: string[]): string | null {
  // argv[0] is the executable; in development argv[1] is the app directory.
  const args = argv.slice(app.isPackaged ? 1 : 2)

  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue

    if (/^https?:\/\//i.test(arg)) return arg

    try {
      if (existsSync(arg) && statSync(arg).isFile()) return pathToFileURL(arg).toString()
    } catch {
      // Not a path we can use.
    }
  }

  return null
}
