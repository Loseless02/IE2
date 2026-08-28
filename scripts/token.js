// Where the GitHub token comes from.
//
// The environment first, so CI and a one-off `$env:GH_TOKEN = "…"` both still
// work. Failing that, a `.env` file next to package.json — which is the point
// of this file: a token typed into a terminal lives only as long as that
// terminal, and retyping it before every release is how tokens end up pasted
// somewhere they shouldn't be.
//
// The file is gitignored, and this refuses to read it if git is tracking it
// anyway, because a token in a public repo is a token that has to be revoked.
const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const ENV_FILE = join(root, '.env')

/**
 * KEY=value, one per line. Blank lines and # comments are skipped, surrounding
 * quotes are dropped, and everything after the first = is the value — a token
 * has no = in it, but this is the rule every other .env reader follows and
 * being surprising here would be worse than being simple.
 */
function parseEnv(text) {
  const out = {}

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key) out[key] = value
  }

  return out
}

/** True if git has this file under version control, ignore rules aside. */
function tracked(path) {
  try {
    const out = execFileSync('git', ['ls-files', '--error-unmatch', path], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    })
    return out.trim() !== ''
  } catch {
    // Not tracked, or not a git checkout at all. Either way, nothing to warn
    // about.
    return false
  }
}

/**
 * The token, or null. Never logged, never printed — the callers report only
 * whether one was found.
 */
function githubToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (fromEnv) return fromEnv.trim()

  if (!existsSync(ENV_FILE)) return null

  if (tracked('.env')) {
    console.error('')
    console.error('  .env is tracked by git, so its token would be published with the repo.')
    console.error('  Run: git rm --cached .env   — then revoke that token and issue a new one.')
    console.error('')
    process.exit(1)
  }

  const values = parseEnv(readFileSync(ENV_FILE, 'utf8'))
  const token = (values['GH_TOKEN'] || values['GITHUB_TOKEN'] || '').trim()

  return token || null
}

/** Where the token was found, for a one-line note in the build output. */
function tokenSource() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return 'environment'
  return existsSync(ENV_FILE) ? '.env' : 'nowhere'
}

module.exports = { githubToken, tokenSource, ENV_FILE }
