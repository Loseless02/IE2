// Make sure the GitHub release exists before electron-builder starts uploading.
//
// electron-builder runs one publisher per target. With two targets — the
// installer and the portable build — both start at roughly the same moment,
// both ask GitHub whether the release exists, both are told no, and both create
// one. The result is two draft releases with the assets split between them, and
// whichever one you publish is missing files.
//
// It cannot recover on its own either: GitHub's "get release by tag" endpoint
// only returns *published* releases, so a draft is invisible to the very check
// that would have prevented the second create. Listing releases (which does
// include drafts, when authenticated) and creating it up front removes the race
// entirely — by the time the publishers look, there is something to find.

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const owner = (config.match(/^\s*owner:\s*(.+)$/m) || [])[1]?.trim()
const repo = (config.match(/^\s*repo:\s*(.+)$/m) || [])[1]?.trim()

// Matches electron-builder's own default. Set `releaseType: release` in the
// config to have releases go live as they finish uploading instead.
const releaseType = (config.match(/^\s*releaseType:\s*(.+)$/m) || [])[1]?.trim() ?? 'draft'

const { githubToken } = require('./token')

const token = githubToken()
const tag = `v${version}`

function fail(message) {
  console.error(`  ensure-release: ${message}`)
  process.exit(1)
}

if (!token) fail('No GitHub token. Put GH_TOKEN=... in .env, or set $env:GH_TOKEN.')
if (!owner || !repo) fail('Could not read owner/repo from electron-builder.yml.')

const api = `https://api.github.com/repos/${owner}/${repo}`
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': `${repo}-release-script`
}

async function main() {
  const listed = await fetch(`${api}/releases?per_page=100`, { headers })
  if (!listed.ok) fail(`GitHub said ${listed.status} listing releases.`)

  const releases = await listed.json()
  const existing = releases.filter((release) => release.tag_name === tag)

  if (existing.length > 1) {
    fail(
      `there are already ${existing.length} releases tagged ${tag}. ` +
        'Delete the extras on GitHub, then run this again.'
    )
  }

  if (existing.length === 1) {
    const state = existing[0].draft ? 'draft' : 'published'
    console.log(`  release ${tag} already exists (${state}) — uploading into it`)
    return
  }

  const created = await fetch(`${api}/releases`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: version,
      draft: releaseType === 'draft',
      prerelease: releaseType === 'prerelease'
    })
  })

  if (!created.ok) {
    fail(`GitHub said ${created.status} creating the release: ${await created.text()}`)
  }

  console.log(`  created ${releaseType} release ${tag}`)
}

main().catch((error) => fail(String(error)))
