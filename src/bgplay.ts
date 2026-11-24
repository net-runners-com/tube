// Background playback. Orca drops a plugin panel (and its <video>) when another panel or view is
// shown, so the panel sends a heartbeat while it plays; when the beats stop, the worker carries on
// in a small always-on-top player window (mpv, else ffplay from ffmpeg). When the panel comes back
// it takes the position and the window closes.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIRS = [join(homedir(), '.local/bin'), join(homedir(), '.nix-profile/bin'), `/etc/profiles/per-user/${process.env.USER ?? ''}/bin`, '/run/current-system/sw/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const find = (n: string) => DIRS.map((d) => join(d, n)).find((p) => existsSync(p))
const MPV = find('mpv') ?? (existsSync('/Applications/mpv.app/Contents/MacOS/mpv') ? '/Applications/mpv.app/Contents/MacOS/mpv' : undefined)
const FFPLAY = find('ffplay')
const FFMPEG = find('ffmpeg')
export const player = (): string | null => (MPV ? 'mpv' : FFPLAY && FFMPEG ? 'ffplay' : null)

export type Source = { video?: string; audio?: string; hls?: string; headers: Record<string, string> }
export type Beat = { id: string; t: number; playing: boolean; on: boolean; volume: number; title: string; meta: unknown }

// screen size (macOS Finder desktop bounds), read once, to put the window bottom-right
let screen = { w: 1440, h: 900 }
if (process.platform === 'darwin') {
  const p = spawn('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { stdio: ['ignore', 'pipe', 'ignore'] })
  p.stdout.on('data', (d: Buffer) => {
    const n = d.toString().split(',').map((x) => Number(x.trim()))
    if (n.length === 4 && n[2] > 0) screen = { w: n[2], h: n[3] }
  })
  p.on('error', () => {})
}

let last: (Beat & { at: number }) | null = null
let run: { procs: ChildProcess[]; id: string; start: number; clock: number; meta: unknown; spawnedAt: number } | null = null
let timer: NodeJS.Timeout | null = null

function hdr(h: Record<string, string>) {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`)
}

function launch(b: Beat, src: Source, log: (m: string) => void) {
  const w = 400
  const h = 225
  const procs: ChildProcess[] = []
  const at = { id: b.id, start: b.t, clock: 0, meta: b.meta, spawnedAt: Date.now() }
  const vol = Math.round(Math.max(0, Math.min(1, b.volume)) * 100)
  if (MPV) {
    const args = [
      '--ontop', '--no-border', `--geometry=${w}x${h}-24-24`, '--force-window=immediate', '--keep-open=no',
      `--volume=${vol}`, `--title=${b.title || 'Tube'}`, '--term-status-msg=CLOCK ${=time-pos}', '--no-terminal=no',
      ...(Object.keys(src.headers).length ? [`--http-header-fields=${hdr(src.headers).join(',')}`] : []), `--start=${Math.floor(b.t)}`
    ]
    if (src.hls) args.push(src.hls)
    else args.push(src.video!, `--audio-file=${src.audio}`)
    const p = spawn(MPV, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const read = (d: Buffer) => {
      const m = /CLOCK ([\d.]+)/.exec(d.toString())
      if (m) at.clock = Number(m[1]) - at.start
    }
    p.stdout?.on('data', read)
    p.stderr?.on('data', read)
    procs.push(p)
  } else if (FFPLAY && FFMPEG) {
    const H = hdr(src.headers).map((l) => l + '\r\n').join('')
    const hd = (x: string) => (H ? ['-headers', H, ...(x ? [] : [])] : [])
    const inputs = src.hls
      ? [...hd(''), '-i', src.hls]
      : [...hd(''), '-ss', String(b.t), '-i', src.video!, ...hd(''), '-ss', String(b.t), '-i', src.audio!, '-map', '0:v:0', '-map', '1:a:0']
    const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...inputs, '-c', 'copy', '-f', src.hls ? 'mpegts' : 'matroska', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const fp = spawn(FFPLAY, ['-hide_banner', '-alwaysontop', '-noborder', '-x', String(w), '-y', String(h), '-left', String(screen.w - w - 24), '-top', String(screen.h - h - 90), '-volume', String(vol), '-window_title', b.title || 'Tube', '-autoexit', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    ff.stdout!.pipe(fp.stdin!)
    fp.stdin!.on('error', () => {})
    // ffplay's status line starts with the clock: "  12.34 A-V: ..."
    fp.stderr!.on('data', (d: Buffer) => {
      const m = /(?:^|\r)\s*(-?\d+\.\d+)\s+(?:A-V|M-A|M-V)/.exec(d.toString())
      if (m) at.clock = Math.max(0, Number(m[1]))
    })
    procs.push(ff, fp)
  }
  if (!procs.length) return
  let errText = ''
  for (const p of procs) p.stderr?.on('data', (d: Buffer) => (errText = (errText + d.toString()).slice(-600)))
  for (const p of procs)
    p.on('exit', (code, sig) => {
      if (code && run?.procs === procs) log(`background player exited ${code}${sig ? ' ' + sig : ''}: ${errText.replace(/\s+/g, ' ').slice(-300)}`)
      if (run?.procs === procs) {
        for (const q of procs) q.kill()
        run = null
      }
    })
  run = { procs, ...at }
  log(`background playback: ${b.id} at ${b.t.toFixed(1)}s with ${MPV ? 'mpv' : 'ffplay'}`)
}

/** Called for every heartbeat from the panel. */
export function beat(b: Beat, resolve: (id: string) => Source | null, log: (m: string) => void) {
  last = { ...b, at: Date.now() }
  if (!b.playing || !b.on) return stopTimer()
  if (timer) return
  // the beats come every second; three missed ones mean the panel is gone
  timer = setInterval(() => {
    if (!last || !last.playing || !last.on) return stopTimer()
    if (Date.now() - last.at < 3000 || run) return
    stopTimer()
    const src = resolve(last.id)
    if (!src || !player()) return log('background playback: no stream or no player')
    // carry on from where it got to, counting the missed beats
    launch({ ...last, t: last.t + (Date.now() - last.at) / 1000 }, src, log)
  }, 1000)
}
function stopTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

/** The panel is back: close the window, hand over the position. */
export function take(): { id: string; t: number; meta: unknown } | null {
  if (!run) return null
  const r = run
  run = null
  for (const p of r.procs) p.kill()
  const t = r.start + (r.clock || (Date.now() - r.spawnedAt) / 1000 - 1.5)
  return { id: r.id, t: Math.max(0, t), meta: r.meta }
}
export function stopAll() {
  stopTimer()
  if (run) for (const p of run.procs) p.kill()
  run = null
}
