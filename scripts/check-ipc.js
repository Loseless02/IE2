/**
 * Every channel the preload can call must have a handler in the main process.
 *
 * TypeScript cannot see across an IPC boundary: the preload declares a method,
 * the page calls it, and if no handler was ever registered the call simply
 * rejects at runtime. When that happens inside a page's start-up the page
 * renders nothing at all, which is exactly how the Settings page shipped blank.
 *
 * Run by scripts/build.js before packaging.
 */

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

/** Channels the renderer side can reach. */
function invoked(source) {
  return new Set([
    ...[...source.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/ipcRenderer\.sendSync\(\s*'([^']+)'/g)].map((m) => m[1])
  ])
}

/** Channels the main process answers, whether by handle() or on(). */
function handled(source) {
  return new Set([
    ...[...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map((m) => m[1])
  ])
}

const preloads = ['src/preload/index.ts', 'src/preload/internal.ts', 'src/preload/adblock.ts']

const wanted = new Set()
for (const file of preloads) for (const channel of invoked(read(file))) wanted.add(channel)

// Handlers live in the main entry point and in the modules it pulls in.
const mainFiles = [
  'src/main/index.ts',
  'src/main/adblock.ts',
  'src/main/downloads.ts',
  'src/main/tabs.ts'
]

const answered = new Set()
for (const file of mainFiles) {
  try {
    for (const channel of handled(read(file))) answered.add(channel)
  } catch {
    // A module that does not exist simply contributes nothing.
  }
}

const missing = [...wanted].filter((channel) => !answered.has(channel)).sort()

if (missing.length > 0) {
  console.error('These channels are called from a preload but nothing handles them:')
  for (const channel of missing) console.error(`  ${channel}`)
  process.exit(1)
}

console.log(`ipc ok — ${wanted.size} channels, all handled`)
