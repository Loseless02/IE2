import { session, type WebContents } from 'electron'
import type { PermissionKind, PermissionRequest } from '../shared/types'
import { AMNESIA_PARTITION, PARTITION } from './partitions'
import { setSitePermission, sitePermission } from './db'
import { getSettings } from './settings'
import { extensionAllows } from './extensions'

/**
 * Site permissions: a site asks once, the user answers, and the answer is kept
 * per site. Until this existed every request was refused without a word, which
 * made video calls and maps simply not work.
 *
 * Fullscreen and writing to the clipboard are granted without asking — every
 * browser does, and refusing fullscreen broke the button on every video player.
 * Anything not listed here is still refused.
 */

const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])

/** Answers from amnesia tabs: kept only until the browser closes. */
const amnesiaAnswers = new Map<string, boolean>()

interface Pending {
  request: PermissionRequest
  resolve: (allow: boolean) => void
}

const pending = new Map<number, Pending>()
let nextId = 1

/** Finds the window a page belongs to and shows it the question. */
let showPrompt: (contents: WebContents, request: PermissionRequest) => boolean = () => false

function originOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** Which of our kinds an Electron permission name stands for. */
function kindsFor(permission: string, details: { mediaTypes?: string[] }): PermissionKind[] | null {
  switch (permission) {
    case 'media': {
      const types = details.mediaTypes ?? []
      const kinds: PermissionKind[] = []
      if (types.includes('video')) kinds.push('camera')
      if (types.includes('audio')) kinds.push('microphone')
      return kinds.length > 0 ? kinds : null
    }
    case 'geolocation':
      return ['location']
    case 'notifications':
      return ['notifications']
    case 'clipboard-read':
      return ['clipboard']
    default:
      return null
  }
}

function remembered(origin: string, kind: PermissionKind, amnesia: boolean): boolean | null {
  if (amnesia) return amnesiaAnswers.get(`${origin} ${kind}`) ?? null
  return sitePermission(origin, kind)
}

/** Every kind must be allowed for the request to be: one refusal refuses. */
function decided(origin: string, kinds: PermissionKind[], amnesia: boolean): boolean | null {
  const answers = kinds.map((kind) => remembered(origin, kind, amnesia))
  if (answers.some((answer) => answer === false)) return false
  if (answers.every((answer) => answer === true)) return true
  return null
}

export function answerPermission(id: number, allow: boolean, remember: boolean): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)

  const { origin, kinds, amnesia } = entry.request
  if (remember) {
    for (const kind of kinds) {
      if (amnesia) amnesiaAnswers.set(`${origin} ${kind}`, allow)
      else setSitePermission(origin, kind, allow)
    }
  }
  entry.resolve(allow)
}

/** The questions still waiting, for a window that has just loaded. */
export function pendingPermissions(): PermissionRequest[] {
  return [...pending.values()].map((entry) => entry.request)
}

export function initPermissions(prompt: typeof showPrompt): void {
  showPrompt = prompt

  for (const partition of [PARTITION, AMNESIA_PARTITION]) {
    const amnesia = partition === AMNESIA_PARTITION
    const ses = session.fromPartition(partition)

    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (ALWAYS_ALLOWED.has(permission)) return callback(true)
      // An extension's own pages get what its manifest declared, without asking.
      const forExtension = extensionAllows(details.requestingUrl ?? contents.getURL(), permission)
      if (forExtension !== null) return callback(forExtension)

      const origin = originOf(details.requestingUrl ?? contents.getURL())
      const kinds = kindsFor(permission, details as { mediaTypes?: string[] })
      if (!origin || !kinds || getSettings().denyPermissions) return callback(false)

      const known = decided(origin, kinds, amnesia)
      if (known !== null) return callback(known)

      const request: PermissionRequest = { id: nextId++, origin, kinds, amnesia }
      let settled = false

      // A page that goes away before it is answered gets a no. Moving within
      // the same document — a single-page app changing its route — does not
      // count as going away.
      const left = (event: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (event.isMainFrame && !event.isSameDocument) resolve(false)
      }
      const closed = (): void => resolve(false)

      const resolve = (allow: boolean): void => {
        if (settled) return
        settled = true
        pending.delete(request.id)
        if (!contents.isDestroyed()) {
          contents.off('did-start-navigation', left)
          contents.off('destroyed', closed)
        }
        callback(allow)
      }
      pending.set(request.id, { request, resolve })

      contents.on('did-start-navigation', left)
      contents.once('destroyed', closed)

      if (!showPrompt(contents, request)) resolve(false)
    })

    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      if (ALWAYS_ALLOWED.has(permission)) return true
      const forExtension = extensionAllows(requestingOrigin, permission)
      if (forExtension !== null) return forExtension
      const origin = originOf(requestingOrigin)
      const kinds = kindsFor(permission, {
        mediaTypes: (details as { mediaType?: string }).mediaType
          ? [(details as { mediaType?: string }).mediaType as string]
          : []
      })
      if (!origin || !kinds || getSettings().denyPermissions) return false
      return decided(origin, kinds, amnesia) === true
    })
  }
}
