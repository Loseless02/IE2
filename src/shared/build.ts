/**
 * Values replaced at compile time by electron-vite (see electron.vite.config).
 * They exist so the app can state which build it is instead of leaving you to
 * infer it from behaviour.
 */
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
declare const __BUILD_COMMIT__: string

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
export const BUILD_TIME = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev'

/** "0.2.0 · 17 Aug 18:04 · a1b2c3d" */
export function buildLabel(): string {
  const when = BUILD_TIME
    ? new Date(BUILD_TIME).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'unknown time'

  return `${APP_VERSION} · built ${when} · ${BUILD_COMMIT}`
}
