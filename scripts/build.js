// One command that cannot lie about whether it worked.
//
// electron-builder reports some failures by printing a line beginning with "⨯"
// while still exiting zero, and npm happily passes that on. So this wrapper
// checks three things itself: nothing is holding the output directory, every
// step exited cleanly, and the artifacts on disk were actually rewritten just
// now. Anything less prints BUILD FAILED and exits non-zero.
const { spawnSync, execSync } = require('node:child_process')
const { existsSync, readdirSync, statSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const dist = join(root, 'dist')
const APP = 'IE2'

/** What this run should produce, taken from package.json. */
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const red = (s) => `\x1b[31m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

function fail(message, hint) {
  console.error('')
  console.error(red('  BUILD FAILED'))
  console.error(`  ${message}`)
  if (hint) console.error(dim(`  ${hint}`))
  console.error('')
  process.exit(1)
}

/** Running instances hold win-unpacked open, and the build cannot replace it. */
function runningInstances() {
  if (process.platform !== 'win32') return 0

  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${APP}.exe" /NH`, { encoding: 'utf8' })
    return out.split('\n').filter((line) => line.includes(`${APP}.exe`)).length
  } catch {
    return 0
  }
}

function run(label, command, args) {
  console.log(dim(`  → ${label}`))
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}.`)
}

// --- 1. nothing may be holding the output ----------------------------------

const running = runningInstances()
if (running > 0) {
  fail(
    // One window is several processes, so this is a process count, not a
    // window count — saying "11 copies" would send you hunting for ten
    // windows that do not exist.
    `${APP} is still running (${running} processes).`,
    'Close every window (including installed web apps) and run this again.'
  )
}

// --- 2. build ---------------------------------------------------------------

const startedAt = Date.now()

run('Type checking', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.node.json'])
run('Type checking (renderer)', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.web.json'])
// Type checking cannot see across IPC: a channel with no handler compiles
// perfectly and then rejects at runtime, which blanks whatever page awaited it.
run('Checking IPC channels', 'node', ['scripts/check-ipc.js'])
run('Compiling', 'npx', ['electron-vite', 'build'])

// A stale temp directory from an interrupted run makes the next one fail with
// EPERM, so clear it before starting.
const staleTemp = join(dist, 'win-unpacked.tmp')
if (existsSync(staleTemp)) rmSync(staleTemp, { recursive: true, force: true })

// `--publish` uploads the installers and latest.yml to a GitHub release, which
// is where the updater looks. Without latest.yml an installed copy has nothing
// to compare against and will never see the release.
const publishing = process.argv.includes('--publish')

if (publishing && !process.env.GH_TOKEN) {
  fail(
    'Publishing needs a GitHub token in GH_TOKEN.',
    'Create one with `repo` scope, then: $env:GH_TOKEN = "…"  (PowerShell)'
  )
}

// Create the release first, so the two target publishers cannot each create
// their own and split the assets between them. See scripts/ensure-release.js.
if (publishing) run('Preparing the release', 'node', ['scripts/ensure-release.js'])

run(
  publishing ? 'Packaging and publishing' : 'Packaging',
  'npx',
  publishing
    ? ['electron-builder', '--win', '--publish', 'always']
    : ['electron-builder', '--win']
)

// --- 3. prove the artifacts are new ----------------------------------------

if (!existsSync(dist)) fail('No dist directory was produced.')

const exes = readdirSync(dist).filter(
  (name) => name.endsWith('.exe') && !name.includes('__uninstaller')
)

/**
 * Exactly what this run should have written, taken from the same config
 * electron-builder reads.
 *
 * Matching on a prefix and a version instead was wrong twice: once when older
 * builds of the same version were still in dist, and again when the artifacts
 * were renamed and the previous names still matched. Naming the expected files
 * outright makes leftovers — of any vintage or naming scheme — irrelevant.
 */
function expectedArtifacts() {
  const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const productName = (config.match(/^productName:\s*(.+)$/m) || [])[1]?.trim() ?? APP

  const patterns = [...config.matchAll(/^\s*artifactName:\s*(.+)$/gm)].map((m) => m[1].trim())

  return patterns.map((pattern) =>
    pattern.replace(/\$\{productName\}/g, productName).replace(/\$\{version\}/g, version).replace(/\$\{ext\}/g, 'exe')
  )
}

const expected = expectedArtifacts()
const missing = expected.filter((name) => !existsSync(join(dist, name)))

if (missing.length > 0) {
  fail(
    `These were not produced: ${missing.join(', ')}.`,
    exes.length > 0
      ? `dist contains: ${exes.join(', ')}. Scroll up for a line starting with ⨯.`
      : 'Scroll up for a line starting with ⨯.'
  )
}

const artifacts = expected.map((name) => ({
  name,
  mtime: statSync(join(dist, name)).mtimeMs
}))

const stale = artifacts.filter((a) => a.mtime < startedAt)
if (stale.length > 0) {
  fail(
    `These were not rebuilt: ${stale.map((a) => a.name).join(', ')}.`,
    'electron-builder reported success but left the old files in place. Scroll up for a line starting with ⨯.'
  )
}

const leftovers = exes.filter((name) => !expected.includes(name))

console.log('')
console.log(green(`  BUILD OK  v${version}`))
for (const artifact of artifacts) {
  const mb = (statSync(join(dist, artifact.name)).size / 1024 / 1024).toFixed(1)
  console.log(`  ${artifact.name}  ${dim(`${mb} MB`)}`)
}
console.log(dim(`  in ${Math.round((Date.now() - startedAt) / 1000)}s`))

if (leftovers.length > 0) {
  console.log('')
  console.log(dim(`  Older builds still in dist: ${leftovers.join(', ')}`))
  console.log(dim('  Left alone on purpose — delete them when you no longer want them.'))
}

console.log('')
