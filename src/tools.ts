// The programs Tube runs — yt-dlp, Deno (yt-dlp's JavaScript runtime) and ffmpeg — installed into
// Tube's own folder on first start, all from one place: the latest net-runners-com/tube-tools
// release, whose manifest.json gives each file's SHA-256 for every OS/arch. Nothing to install by
// hand; a copy already on the system is only a fallback. Tools update from there every few days.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as https from 'node:https'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { ARCH, DATA_DIR, exe, findTool, isMac, isWin, OS } from './platform'

const TOOLS = join(DATA_DIR, 'tools')
const STATE = join(TOOLS, 'tools.json')
const UA = 'orca-tube'

type ToolState = { path: string; version: string; checked?: number }
type State = { ytdlp?: ToolState; ffmpeg?: ToolState; node?: ToolState; deno?: ToolState; release?: string }
let state: State = {}
try {
  state = JSON.parse(readFileSync(STATE, 'utf8'))
} catch {}
const save = () => (mkdirSync(TOOLS, { recursive: true }), writeFileSync(STATE, JSON.stringify(state, null, 2)))

/** What the panel shows while Tube sets itself up. */
export type Setup = { stage: 'ready' | 'working' | 'error'; step: string; pct: number; error: string }
export const setup: Setup = { stage: 'working', step: '', pct: 0, error: '' }

/* ---------------- downloads ---------------- */

/** GET following redirects; resolves to the final URL and the response. */
function get(url: string, redirects = 6): Promise<{ url: string; res: import('node:http').IncomingMessage }> {
  return new Promise((ok, no) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      const code = res.statusCode ?? 0
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume()
        return ok(get(new URL(res.headers.location, url).toString(), redirects - 1))
      }
      if (code !== 200) {
        res.resume()
        return no(new Error(`HTTP ${code} for ${url}`))
      }
      ok({ url, res })
    })
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${url}`)))
    req.on('error', no)
  })
}
async function getText(url: string) {
  const { res } = await get(url)
  const parts: Buffer[] = []
  for await (const c of res) parts.push(c as Buffer)
  return Buffer.concat(parts).toString('utf8')
}
/** Downloads into memory with progress; returns bytes, their SHA-256 and the final URL. */
async function download(url: string, onPct: (p: number) => void) {
  const { url: final, res } = await get(url)
  const total = Number(res.headers['content-length'] ?? 0)
  const hash = createHash('sha256')
  const parts: Buffer[] = []
  let got = 0
  for await (const c of res) {
    const b = c as Buffer
    parts.push(b)
    hash.update(b)
    got += b.length
    if (total) onPct(got / total)
  }
  return { bytes: Buffer.concat(parts), sha256: hash.digest('hex'), url: final }
}
/* ---------------- archives ---------------- */

/** Extracts a zip (stored or deflated entries, zip64 sizes) into `dir`, keeping Unix file modes. */
export function unzip(zip: Buffer, dir: string) {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('not a zip file')
  let count = zip.readUInt16LE(eocd + 10)
  let cd = zip.readUInt32LE(eocd + 16)
  const z64 = zip.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]), Math.max(0, eocd - 100))
  if (z64 >= 0 && z64 < eocd) {
    count = Number(zip.readBigUInt64LE(z64 + 32))
    cd = Number(zip.readBigUInt64LE(z64 + 48))
  }
  for (let n = 0, p = cd; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory')
    const madeBy = zip.readUInt16LE(p + 4) >> 8
    const method = zip.readUInt16LE(p + 10)
    let csize = zip.readUInt32LE(p + 20)
    let usize = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const attrs = zip.readUInt32LE(p + 38)
    let local = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    // zip64 extra field: the 0xFFFFFFFF sizes/offset are in it, in this order
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = zip.readUInt16LE(e)
      const len = zip.readUInt16LE(e + 2)
      if (id === 1) {
        let q = e + 4
        if (usize === 0xffffffff) (usize = Number(zip.readBigUInt64LE(q)), (q += 8))
        if (csize === 0xffffffff) (csize = Number(zip.readBigUInt64LE(q)), (q += 8))
        if (local === 0xffffffff) local = Number(zip.readBigUInt64LE(q))
      }
      e += 4 + len
    }
    p += 46 + nameLen + extraLen + commentLen
    // never write outside `dir`
    const rel = name.replace(/\\/g, '/')
    if (rel.split('/').includes('..') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) continue
    const out = join(dir, ...rel.split('/'))
    if (rel.endsWith('/')) {
      mkdirSync(out, { recursive: true })
      continue
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + csize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`unsupported zip method ${method} for ${name}`)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, data)
    const mode = madeBy === 3 ? (attrs >>> 16) & 0o777 : 0
    if (mode && !isWin) chmodSync(out, mode)
  }
}
/** The first file called `name` under `dir`. */
function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (entry === name) return p
  }
}
/** Installs into a fresh folder, then swaps it in, so a failed download never breaks a working one. */
function fresh(name: string) {
  const dir = join(TOOLS, `${name}.new`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    commit(path: string) {
      const final = join(TOOLS, name)
      rmSync(join(TOOLS, `${name}.old`), { recursive: true, force: true })
      if (existsSync(final)) renameSync(final, join(TOOLS, `${name}.old`))
      renameSync(dir, final)
      rmSync(join(TOOLS, `${name}.old`), { recursive: true, force: true })
      return path.replace(dir, final)
    }
  }
}
const run = (file: string, args: string[], extraEnv: Record<string, string> = {}) =>
  new Promise<string>((ok) =>
    execFile(file, args, { timeout: 60_000, windowsHide: true, env: { ...process.env, ...extraEnv } }, (_e, out, err) => ok(`${out}${err}`))
  )

/* ---------------- one source: net-runners-com/tube-tools ---------------- */

/**
 * Every program comes from one tube-tools release, whose manifest lists each file's SHA-256 per
 * OS/arch. The release is pinned here: tools change only when Tube itself is updated.
 */
export const TOOLS_RELEASE = 'tools-20261124-0623'
const SOURCE = `https://github.com/net-runners-com/tube-tools/releases/download/${TOOLS_RELEASE}/`
type Tool = 'yt-dlp' | 'node' | 'ffmpeg'
type Manifest = { built: string; tools: Record<Tool, { version: string; assets: Record<string, { file: string; sha256: string }> }> }
const PLATFORM = `${OS}-${ARCH === 'arm64' ? 'arm64' : 'x64'}`
/** The program inside each tool's zip. */
const PROGRAM: Record<Tool, string> = { 'yt-dlp': isMac ? 'yt-dlp_macos' : isWin ? 'yt-dlp.exe' : ARCH === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux', node: exe('node'), ffmpeg: exe('ffmpeg') }
const KEY: Record<Tool, 'ytdlp' | 'node' | 'ffmpeg'> = { 'yt-dlp': 'ytdlp', node: 'node', ffmpeg: 'ffmpeg' }

let manifestCache: Manifest | null = null
async function manifest(): Promise<Manifest> {
  manifestCache ??= JSON.parse(await getText(SOURCE + 'manifest.json')) as Manifest
  return manifestCache
}

async function install(tool: Tool, onPct: (p: number) => void) {
  const m = await manifest()
  const t = m.tools[tool]
  const asset = t?.assets[PLATFORM]
  if (!asset) throw new Error(`${tool} is not available for ${PLATFORM}`)
  const { bytes, sha256 } = await download(SOURCE + asset.file, onPct)
  if (sha256 !== asset.sha256) throw new Error(`${tool} download failed its checksum`)
  const f = fresh(tool)
  unzip(bytes, f.dir)
  const bin = findFile(f.dir, PROGRAM[tool])
  if (!bin) throw new Error(`${tool} archive is missing its program`)
  if (!isWin) chmodSync(bin, 0o755)
  await run(bin, [tool === 'ffmpeg' ? '-version' : '--version']) // the OS scans a new program on its first run: do it now
  state[KEY[tool]] = { path: f.commit(bin), version: t.version, checked: Date.now() }
  save()
}

/* ---------------- what callers use ---------------- */

const usable = (t?: ToolState) => !!t && existsSync(t.path)

/** yt-dlp's path: Tube's own copy, else one already on the system. */
export const ytdlpPath = () => (usable(state.ytdlp) ? state.ytdlp!.path : findTool('yt-dlp'))
export const ffmpegPath = () => (usable(state.ffmpeg) ? state.ffmpeg!.path : findTool('ffmpeg'))
/** Arguments that give yt-dlp its JS runtime (Tube's Node.js, else one on the system). */
export function jsRuntime(): { args: string[]; env: Record<string, string> } {
  if (usable(state.node)) return { args: ['--js-runtimes', `node:${state.node!.path}`], env: {} }
  const node = findTool('node')
  if (node) return { args: ['--js-runtimes', `node:${node}`], env: {} }
  const deno = findTool('deno')
  return deno ? { args: ['--js-runtimes', `deno:${deno}`], env: {} } : { args: [], env: {} }
}
export const toolInfo = () => ({
  ytdlp: ytdlpPath() ?? null,
  ytdlpVersion: state.ytdlp?.version ?? null,
  ffmpeg: ffmpegPath() ?? null,
  ffmpegVersion: state.ffmpeg?.version ?? null,
  node: state.node?.version ?? null,
  os: PLATFORM
})

// Deno was the runtime before 1.1 (its development ends in 2027): drop a copy left from then
if (state.deno) {
  rmSync(join(TOOLS, 'deno'), { recursive: true, force: true })
  delete state.deno
  save()
}

let running: Promise<void> | null = null
/**
 * Installs what is missing (all of it on first start) and anything that differs from the pinned
 * release — which happens right after Tube itself was updated to a version pinning newer tools.
 */
export function ensureTools(log: (m: string) => void): Promise<void> {
  running ??= (async () => {
    try {
      const need = (state.release === TOOLS_RELEASE && usable(state.ytdlp) && usable(state.node) && usable(state.ffmpeg))
        ? []
        : await (async () => {
            const m = await manifest()
            return (['yt-dlp', 'node', 'ffmpeg'] as Tool[]).filter((t) => !usable(state[KEY[t]]) || state[KEY[t]]!.version !== m.tools[t]?.version)
          })()
      const weight: Record<Tool, number> = { 'yt-dlp': 0.45, node: 0.3, ffmpeg: 0.25 }
      const total = need.reduce((a, t) => a + weight[t], 0) || 1
      let done = 0
      for (const tool of need) {
        setup.step = tool
        log(`setup: installing ${tool} (${TOOLS_RELEASE})`)
        await install(tool, (x) => (setup.pct = Math.round(((done + x * weight[tool]) / total) * 100)))
        done += weight[tool]
      }
      state.release = TOOLS_RELEASE
      save()
      setup.stage = 'ready'
      setup.pct = 100
      setup.step = ''
    } catch (e) {
      setup.stage = ytdlpPath() ? 'ready' : 'error' // a working copy (or a system yt-dlp) still lets Tube run
      setup.error = e instanceof Error ? e.message : String(e)
      log(`setup failed: ${setup.error}`)
    }
  })().finally(() => (running = null))
  return running
}

/* ---------------- Settings ▸ Updates (Tube itself) ---------------- */

export const cmpVer = (a: string, b: string) => {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(Number)
  const pb = b.replace(/^v/, '').split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}
/** The newest Tube version (its vX.Y.Z tags on GitHub). */
export async function latestTube(): Promise<string> {
  const tags = (JSON.parse(await getText('https://api.github.com/repos/net-runners-com/tube/tags?per_page=30')) as { name: string }[])
    .map((x) => x.name)
    .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
  return tags.sort((a, b) => cmpVer(b, a))[0] ?? ''
}

/** Waits for setup before the first yt-dlp run (instant once ready). */
export async function ready() {
  if (setup.stage !== 'ready' && running) await running
  const p = ytdlpPath()
  if (!p) throw new Error(setup.error ? `Tube could not install yt-dlp: ${setup.error}` : 'yt-dlp is not installed yet')
  return p
}

/** Spawns a tool hidden (no console window on Windows). */
export const spawnTool = (file: string, args: string[], extraEnv: Record<string, string> = {}) =>
  spawn(file, args, { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
