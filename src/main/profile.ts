import { app } from 'electron'
import { join } from 'node:path'

/**
 * Which profile this copy of the browser uses.
 *
 * The installed browser is the one you live in. `npm run dev` and the build in
 * dist/win-unpacked are the ones you test. If they share a profile, two things
 * go wrong: the single-instance lock is keyed on the profile folder, so
 * launching a test build while the installed one is open just opens a window in
 * the installed one — the new code never runs — and a test build with a broken
 * migration can damage the history you actually care about.
 *
 * So anything that is not an installed copy gets its own folder, next to the
 * real one. Imported first in index.ts: the path has to be set before anything
 * asks for it, and before the instance lock is taken.
 */
export const IS_DEV_COPY =
  !app.isPackaged || /[\\/]dist[\\/]win-unpacked[\\/]/i.test(process.execPath)

if (IS_DEV_COPY) {
  app.setPath('userData', join(app.getPath('appData'), 'internet-explorer-2-dev'))
}

/**
 * Windows groups taskbar buttons by this id, so the test copy needs its own or
 * its windows stack up under the installed browser's button.
 */
export const APP_USER_MODEL_ID = IS_DEV_COPY
  ? 'com.internetexplorer2.browser.dev'
  : 'com.internetexplorer2.browser'
