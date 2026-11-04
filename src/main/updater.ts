import { app } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { IS_DEV_COPY } from './profile'
import { getSettings } from './settings'
import type { UpdateState } from '../shared/types'

/**
 * Updates, from the project's own GitHub releases.
 *
 * The browser asks GitHub for the latest release, compares it with the running
 * version, and — if the user says so — downloads the installer and runs it on
 * restart, or at the next launch. Everything is reported back to the interface so the whole thing is one
 * button rather than a manual download.
 *
 * Nothing about the user is sent: the request asks for a public release file
 * and the only comparison is between two version numbers. It is still a setting,
 * because an app that reaches the network on start-up should be something you
 * can switch off, and because the check is just as useful on a button.
 */

let state: UpdateState = { status: 'idle', version: '', notes: '', progress: 0 }

/** Told about every change, so the UI never has to poll. */
const listeners: ((state: UpdateState) => void)[] = []

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener(state)
}

export function onUpdateState(listener: (state: UpdateState) => void): void {
  listeners.push(listener)
}

export function updateState(): UpdateState {
  return state
}

/**
 * A portable build is a single executable with nothing to install over, so
 * electron-updater cannot replace it. Saying so plainly beats a button that
 * fails for reasons the user cannot see.
 */
export function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false
  return process.env['PORTABLE_EXECUTABLE_FILE'] === undefined
}

export function initUpdater(): void {
  // Downloading is a decision, not a default: a browser that quietly pulls
  // 120 MB down someone's connection has made that choice for them.
  autoUpdater.autoDownload = false
  // Not on quit: the installer then runs with nothing on screen, and opening
  // IE2 again meanwhile got that copy killed by it. A downloaded update is
  // applied at the next launch instead, in view — see applyPendingUpdate.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    set({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      progress: 0
    })

    // Pressing "Check for updates" is asking for the update, so it comes down
    // straight away. The check made quietly at startup only reports — unless
    // the user asked for updates to install themselves.
    if (downloadWhenFound) {
      downloadWhenFound = false
      void download()
    } else if (startupCheck && getSettings().autoInstallUpdates) {
      installWhenReady = true
      void download()
    }
    startupCheck = false
  })

  autoUpdater.on('update-not-available', () => {
    startupCheck = false
    set({ status: 'current', progress: 0 })
  })

  autoUpdater.on('download-progress', (progress) => {
    set({ status: 'downloading', progress: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version, progress: 100 })
    // Installing on its own: restart into it now. The session is saved on the
    // way out, so the tabs come back.
    if (installWhenReady) {
      installWhenReady = false
      setTimeout(installNow, 1500)
    }
  })

  autoUpdater.on('error', (error) => {
    // Offline, rate-limited, or no release yet. None of it is worth a dialog.
    set({ status: 'error', message: String(error?.message ?? error).slice(0, 200) })
  })

  if (!canSelfUpdate()) {
    set({ status: 'unsupported' })
    return
  }

  // A little after start, so it never competes with restoring the session.
  if (getSettings().autoUpdate) {
    setTimeout(() => {
      if (busy()) return
      startupCheck = true
      void check()
    }, 8000)
  }
}

/**
 * Downloading, or downloaded and waiting for a restart. Checking again then
 * would only set the state back to "available" and fetch the same file twice.
 */
function busy(): boolean {
  return state.status === 'downloading' || state.status === 'ready'
}

/** Set by a check the user asked for, so a found update downloads at once. */
let downloadWhenFound = false

/** The quiet check made at startup is the one in flight. */
let startupCheck = false

/** Install as soon as the download finishes: the automatic-install path. */
let installWhenReady = false

/**
 * Ask GitHub what the latest release is. Safe to call when it cannot work.
 *
 * `manual` is a check the user pressed the button for: an update it finds is
 * downloaded straight away rather than waiting for a second press.
 */
export async function check(manual = false): Promise<UpdateState> {
  if (!canSelfUpdate()) {
    set({ status: 'unsupported' })
    return state
  }
  if (busy()) return state

  downloadWhenFound = manual

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    set({ status: 'error', message: String(error).slice(0, 200) })
  }

  return state
}

export async function download(): Promise<void> {
  if (state.status !== 'available') return

  try {
    set({ status: 'downloading', progress: 0 })
    await autoUpdater.downloadUpdate()
  } catch (error) {
    set({ status: 'error', message: String(error).slice(0, 200) })
  }
}

/**
 * Close every window, install, and start again.
 *
 * Silent, and relaunching afterwards. Left to its defaults this runs the full
 * installer wizard — the same pages as a first install, asking where to put a
 * browser that is already installed — and then leaves you at the desktop.
 * An update should look like the browser blinking, not like setting it up again.
 */
export function installNow(): void {
  if (state.status !== 'ready') return
  const pending = pendingInstaller()
  if (!pending) {
    autoUpdater.quitAndInstall(true, true)
    return
  }
  // quit, not exit: the session is saved on the way out.
  void runInstaller(pending).then(() => app.quit())
}

// --- applying an update ------------------------------------------------------
//
// The installer cannot run while IE2 does — it replaces IE2's own files — and
// it shows nothing when run silently. So a small window of its own, drawn by
// PowerShell rather than by IE2, says the update is being applied: from the
// moment IE2 closes until the new version's window is up. A marker file in the
// profile says an update is under way, so a launch in the middle of it stays
// out of the installer's way instead of being killed by it.

interface Applying {
  version: string
  at: number
  /** The installer's file name, to find it among running processes. */
  installer?: string
}

const markerPath = (): string => join(app.getPath('userData'), 'update-applying.json')

function readMarker(): Applying | null {
  try {
    const value = JSON.parse(readFileSync(markerPath(), 'utf8')) as Applying
    return typeof value.version === 'string' && typeof value.at === 'number' ? value : null
  } catch {
    return null
  }
}

function removeMarker(): void {
  rmSync(markerPath(), { force: true })
}

/**
 * A version not to apply by itself at launch, until when: its last attempt
 * failed. Restart to update in Settings still tries it — that is someone
 * asking — but a launch must never walk into the same failure again.
 */
const skipPath = (): string => join(app.getPath('userData'), 'update-skip.json')
const RETRY_AFTER_MS = 6 * 60 * 60_000

function skipping(version: string): boolean {
  try {
    const value = JSON.parse(readFileSync(skipPath(), 'utf8')) as { version?: string; until?: number }
    return value.version === version && typeof value.until === 'number' && value.until > Date.now()
  } catch {
    return false
  }
}

function skip(version: string): void {
  try {
    writeFileSync(skipPath(), JSON.stringify({ version, until: Date.now() + RETRY_AFTER_MS }))
  } catch {
    // Then it is simply tried again.
  }
}

/**
 * How long the last update took to install here, which is the best guess at
 * how long the next one will: the "Updating" window counts it down. It
 * depends on the disk and on how long Windows looks at a new installer, so it
 * is measured rather than assumed — 45 seconds until there is a measurement.
 */
const timingPath = (): string => join(app.getPath('userData'), 'update-timing.json')

function installEstimate(): number {
  try {
    const { seconds } = JSON.parse(readFileSync(timingPath(), 'utf8')) as { seconds?: number }
    if (typeof seconds === 'number' && seconds > 0) return Math.round(Math.min(300, Math.max(15, seconds)))
  } catch {
    // No measurement yet.
  }
  return 45
}

/** Whether a process with this file name is running right now. */
function running(name: string): boolean {
  try {
    const out = execFileSync('tasklist', ['/fi', `IMAGENAME eq ${name}`, '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000
    })
    return out.toLowerCase().includes(`"${name.toLowerCase()}"`)
  } catch {
    return false
  }
}

/** a is a later version than b. */
function newer(a: string, b: string): boolean {
  const parts = (v: string): number[] => v.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** Where electron-updater keeps a downloaded installer, named in app-update.yml. */
function pendingDir(): string {
  let name = 'internet-explorer-2-updater'
  try {
    const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
    name = yml.match(/^updaterCacheDirName:\s*(.+)$/m)?.[1].trim() || name
  } catch {
    // The default name, then.
  }
  return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), name, 'pending')
}

/** A downloaded installer for a later version than this one, intact. */
function pendingInstaller(): { file: string; version: string } | null {
  try {
    const dir = pendingDir()
    const info = JSON.parse(readFileSync(join(dir, 'update-info.json'), 'utf8')) as {
      fileName?: string
      sha512?: string
      isAdminRightsRequired?: boolean
    }
    if (!info.fileName || !info.sha512 || info.isAdminRightsRequired) return null
    const version = /-(\d+\.\d+\.\d+)\.exe$/i.exec(info.fileName)?.[1]
    if (!version || !newer(version, app.getVersion())) return null
    const file = join(dir, basename(info.fileName))
    const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64')
    return sha512 === info.sha512 ? { file, version } : null
  } catch {
    return null
  }
}

/** A PowerShell string literal: single quotes, with any inside doubled. */
const ps = (text: string): string => `'${text.replace(/'/g, "''")}'`

/** Resolves once the helper is running on its own, and IE2 may go. */
function runInstaller(pending: { file: string; version: string }): Promise<void> {
  writeFileSync(
    markerPath(),
    JSON.stringify({ version: pending.version, at: Date.now(), installer: basename(pending.file) } satisfies Applying)
  )

  const exe = process.execPath
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$installer = ${ps(pending.file)}
$exe = ${ps(exe)}
$marker = ${ps(markerPath())}
$skip = ${ps(skipPath())}
$skipJson = ${ps(JSON.stringify({ version: pending.version, until: Date.now() + RETRY_AFTER_MS }))}
$timing = ${ps(timingPath())}
$estimate = ${installEstimate()}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'IE2'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size(380, 150)
$form.BackColor = [Drawing.Color]::FromArgb(28, 28, 32)
# Started from the background, Windows would not bring it to the front.
$form.TopMost = $true
$form.Icon = [Drawing.Icon]::ExtractAssociatedIcon($exe)
$title = New-Object Windows.Forms.Label
$title.Text = ${ps(`Updating IE2 to ${pending.version}`)}
$title.ForeColor = [Drawing.Color]::White
$title.Font = New-Object Drawing.Font('Segoe UI', 15)
$title.AutoSize = $true
$title.Location = New-Object Drawing.Point(24, 30)
$line = New-Object Windows.Forms.Label
$line.Text = 'Waiting for IE2 to close…'
$line.ForeColor = [Drawing.Color]::FromArgb(160, 160, 166)
$line.Font = New-Object Drawing.Font('Segoe UI', 10)
$line.AutoSize = $true
$line.Location = New-Object Drawing.Point(26, 66)
$bar = New-Object Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 25
$bar.Location = New-Object Drawing.Point(28, 106)
$bar.Size = New-Object Drawing.Size(324, 6)
$form.Controls.AddRange(@($title, $line, $bar))
# Started hidden (no console flash), and Windows applies that to the first
# window this process shows. Let a throwaway one take it.
$first = New-Object Windows.Forms.Form
$first.ShowInTaskbar = $false
$first.Show()
$first.Close()
$state = @{ proc = $null; started = Get-Date; exited = $null; cpu = -1; still = $null }
$name = ${ps(basename(exe, '.exe'))}
# Whatever happens to the update, IE2 has to open again: the new version if it
# got installed, the old one if not.
$reopen = {
  $open = Get-Process -Name $name | Where-Object { $_.Path -eq $exe }
  if (-not $open) { Start-Process -FilePath $exe }
}
$giveUp = {
  [IO.File]::WriteAllText($skip, $skipJson)
  Remove-Item -LiteralPath $marker -Force
  & $reopen
  $timer.Stop(); $form.Close()
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  $now = Get-Date
  if (-not $state.proc) {
    # The browser first finishes closing, so the installer never has to kill it.
    $open = Get-Process -Name $name | Where-Object { $_.Path -eq $exe }
    if ($open -and ($now - $state.started).TotalSeconds -lt 20) { return }
    $state.proc = Start-Process -FilePath $installer -ArgumentList '--updated', '/S', '--force-run' -PassThru
    $state.still = $now
    if (-not $state.proc) { & $giveUp; return }
    # From here the bar fills against how long the last install took.
    $bar.Style = 'Continuous'
    $bar.Maximum = 1000
    $bar.Value = 0
    return
  }
  # The new version removes the marker once its window is up.
  if (-not (Test-Path -LiteralPath $marker)) { $timer.Stop(); $form.Close(); return }
  if ($state.proc.HasExited) {
    if (-not $state.exited) {
      $state.exited = $now
      $bar.Value = 1000
      $line.Text = 'Starting IE2…'
      # How long this one took, for the next update's estimate.
      $took = [Math]::Round(($now - $state.proc.StartTime).TotalSeconds)
      if ($state.proc.ExitCode -eq 0) { [IO.File]::WriteAllText($timing, "{""seconds"":$took}") }
    }
    # Installed, but nothing opened: open it.
    if (($now - $state.exited).TotalSeconds -gt 45) { & $giveUp }
    return
  }
  # The installer reports nothing, so the time left is an estimate: the last
  # install's length, counted down, and never below "almost done".
  $elapsed = ($now - $state.proc.StartTime).TotalSeconds
  $left = [Math]::Ceiling($estimate - $elapsed)
  $line.Text = if ($left -gt 3) { "Installing — about $left seconds left" } else { 'Almost done…' }
  $bar.Value = [Math]::Min(950, [Math]::Max(0, [int]($elapsed / $estimate * 1000)))
  # An installer using no processor time at all for a minute is frozen — held
  # by something outside it — and has not started on IE2's files. Stop it and
  # give the current version back rather than wait for ever.
  $state.proc.Refresh()
  $cpu = $state.proc.TotalProcessorTime.TotalMilliseconds
  if ($cpu -ne $state.cpu) { $state.cpu = $cpu; $state.still = $now; return }
  if (($now - $state.still).TotalSeconds -gt 60) {
    Stop-Process -Id $state.proc.Id -Force
    & $giveUp
  }
})
# Not tied to the window being shown: the update goes ahead even if it is not.
$timer.Start()
[Windows.Forms.Application]::Run($form)
`
  // With a byte-order mark, or Windows PowerShell reads a path with an accent
  // in it as the wrong characters.
  const helper = join(app.getPath('userData'), 'update-helper.ps1')
  writeFileSync(helper, `﻿${script}`, 'utf8')

  // A first PowerShell starts the helper and exits. Started directly, the
  // helper would end with IE2 — Node keeps its child processes in a job that
  // closes with it — and started "detached" it has no console, which makes
  // PowerShell quit at once. A process the first one starts is free of both.
  const launch = `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ${ps(`"${helper}"`)}`
  return new Promise((resolve) => {
    const starter = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', launch], {
      stdio: 'ignore',
      windowsHide: true
    })
    starter.on('exit', () => resolve())
    starter.on('error', () => resolve())
    // Never hold IE2 open on it.
    setTimeout(resolve, 15_000)
  })
}

/**
 * This launch landed while an update is being installed — IE2 clicked again
 * while the "Updating" window is up. It must not run: it would hold the files
 * the installer is replacing. The installer opens the new version itself.
 */
export function updateInProgress(): boolean {
  if (IS_DEV_COPY || !canSelfUpdate()) return false
  const marker = readMarker()
  if (!marker || !newer(marker.version, app.getVersion())) return false

  // The first seconds the "Updating" window spends waiting for IE2 to close,
  // before it starts the installer; after that, only while the installer is
  // really running. A marker on its own is not enough — trusting one left
  // behind by a stuck installer kept IE2 from opening at all.
  const age = Date.now() - marker.at
  const installer = marker.installer ?? `IE2-Setup-${marker.version}.exe`
  if (age < 30_000 || (age < 15 * 60_000 && running(installer))) return true

  // That install went nowhere. Forget it, and do not walk into it again at
  // every launch; Restart to update can still try it.
  removeMarker()
  skip(marker.version)
  return false
}

/**
 * An update downloaded earlier and not yet installed — "Later", then IE2 was
 * closed. Apply it now, in view, and let the installer open the new version.
 * Returns, when this launch is handing over to the installer, a promise that
 * settles once IE2 may exit.
 */
export function applyPendingUpdate(): Promise<void> | null {
  if (IS_DEV_COPY || !canSelfUpdate()) return null
  const pending = pendingInstaller()
  return pending && !skipping(pending.version) ? runInstaller(pending) : null
}

/**
 * The version an update just installed, once, for the start-up window to say
 * so. The marker is removed when the window is up, which closes the
 * "Updating" window — see finishUpdate.
 */
export function justUpdatedTo(): string | null {
  const marker = readMarker()
  return marker && !newer(marker.version, app.getVersion()) ? marker.version : null
}

export function finishUpdate(): void {
  if (justUpdatedTo()) removeMarker()
}

/**
 * The newest section of CHANGELOG.md, for the "what's new" card.
 *
 * Read from the file that shipped with this build rather than from the network,
 * so it works offline and says what is actually installed — release notes
 * fetched from GitHub would describe whatever is newest there instead.
 */
export function latestChanges(): { version: string; lines: string[] } {
  const candidates = [
    join(process.resourcesPath ?? '', 'CHANGELOG.md'),
    join(app.getAppPath(), 'CHANGELOG.md'),
    join(app.getAppPath(), '..', 'CHANGELOG.md')
  ]

  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8')
      const match = text.match(/^## (\S+)\s*\n([\s\S]*?)(?=\n## |\s*$)/m)
      if (!match) continue

      const lines = match[2]
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).trim())

      return { version: match[1], lines }
    } catch {
      // Try the next location.
    }
  }

  return { version: '', lines: [] }
}
