// Signing in to YouTube. Cookies (youtube.com / google.com only) live in a 0600 Netscape cookie
// file that yt-dlp reads with --cookies; InnerTube calls (account, subscribe, like) sign requests
// with SAPISIDHASH the way youtube.com does.
//
// "Sign in with Google" opens a separate Chrome profile with the DevTools port on, waits for the
// login cookies to appear, reads them over CDP (no keychain prompt) and closes that window.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = join(homedir(), 'Library/Application Support/orca-tube')
export const COOKIES = join(DATA_DIR, 'cookies.txt')
const PROFILE = join(DATA_DIR, 'chrome-profile')
const ORIGIN = 'https://www.youtube.com'
const CLIENT_VERSION = '2.20251120.01.00'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'
]

export type Account = { name: string; handle: string; avatar: string; channelId: string }

const keep = (domain: string) => /(^|\.)(youtube\.com|google\.com)$/.test(domain.replace(/^#HttpOnly_/, '').replace(/^\./, ''))

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
}

export const signedIn = () => existsSync(COOKIES)

/** Keeps only YouTube/Google lines of a Netscape cookie file and stores it as ours. */
export function saveCookieFile(text: string) {
  const lines = text.split('\n').filter((l) => !l.trim() || l.startsWith('# ') || (l.split('\t').length >= 7 && keep(l.split('\t')[0])))
  if (!lines.some((l) => /\t(SAPISID|__Secure-3PAPISID)\t/.test(l))) throw new Error('Not signed in to YouTube in that browser')
  ensureDir()
  const tmp = COOKIES + '.tmp'
  writeFileSync(tmp, ['# Netscape HTTP Cookie File', ...lines.filter((l) => !l.startsWith('# Netscape'))].join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, COOKIES)
  chmodSync(COOKIES, 0o600)
}

/** A private copy for one yt-dlp run (it rewrites the file at exit); `commit` keeps its refreshed cookies. */
export function cookieCopy(): { path: string; commit(): void; drop(): void } | null {
  if (!signedIn()) return null
  const path = join(tmpdir(), `orca-tube-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(path, readFileSync(COOKIES), { mode: 0o600 })
  return {
    path,
    commit() {
      try {
        const text = readFileSync(path, 'utf8')
        if (signedIn() && /\t(SAPISID|__Secure-3PAPISID)\t/.test(text)) saveCookieFile(text)
      } catch {}
      this.drop()
    },
    drop() {
      rmSync(path, { force: true })
    }
  }
}

function youtubeCookies(): { header: string; sapisid: string } {
  const jar = new Map<string, string>()
  for (const line of readFileSync(COOKIES, 'utf8').split('\n')) {
    const f = line.split('\t')
    if (f.length < 7 || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
    const domain = f[0].replace(/^#HttpOnly_/, '')
    if (!/(^|\.)youtube\.com$/.test(domain.replace(/^\./, ''))) continue
    jar.set(f[5], f[6].trim())
  }
  const sapisid = jar.get('SAPISID') ?? jar.get('__Secure-3PAPISID') ?? ''
  return { header: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), sapisid }
}

/** POST to youtubei/v1 as the signed-in user. */
export async function innertube(endpoint: string, body: Record<string, unknown> = {}): Promise<any> {
  if (!signedIn()) throw new Error('Sign in first')
  const { header, sapisid } = youtubeCookies()
  if (!sapisid) throw new Error('Session cookies are missing; sign in again')
  const ts = Math.floor(Date.now() / 1000)
  const hash = (id: string) => `${ts}_${createHash('sha1').update(`${ts} ${id} ${ORIGIN}`).digest('hex')}`
  const r = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      Cookie: header,
      Authorization: `SAPISIDHASH ${hash(sapisid)} SAPISID1PHASH ${hash(sapisid)} SAPISID3PHASH ${hash(sapisid)}`,
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': '0',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': CLIENT_VERSION,
      'User-Agent': UA
    },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'JP' } }, ...body })
  })
  if (r.status === 401 || r.status === 403) throw new Error('YouTube refused the session; sign in again')
  if (!r.ok) throw new Error(`YouTube ${endpoint}: HTTP ${r.status}`)
  return r.json()
}

/** Depth-first search for every object stored under `key`. */
function* findAll(node: any, key: string): Generator<any> {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const x of node) yield* findAll(x, key)
    return
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) yield v
    else yield* findAll(v, key)
  }
}
const text = (t: any): string => t?.simpleText ?? t?.runs?.map((r: any) => r.text).join('') ?? t?.content ?? ''
const bigThumb = (thumbs: any[] | undefined) => {
  const t = thumbs?.[thumbs.length - 1]?.url ?? ''
  return t.startsWith('//') ? 'https:' + t : t
}

export async function account(): Promise<Account> {
  const j = await innertube('account/account_menu')
  const h = findAll(j, 'activeAccountHeaderRenderer').next().value
  if (!h) throw new Error('YouTube did not return an account; sign in again')
  const channelId = findAll(h, 'browseId').next().value ?? findAll(j, 'browseId').next().value ?? ''
  return { name: text(h.accountName), handle: text(h.channelHandle), avatar: bigThumb(h.accountPhoto?.thumbnails), channelId: String(channelId).startsWith('UC') ? channelId : '' }
}

export type SubChannel = { kind: 'channel'; id: string; name: string; handle: string; subs: number | null; avatar: string }

function parseCount(s: string): number | null {
  const m = /([\d.,]+)\s*([KMB万億]?)/i.exec(s)
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ''))
  const mul = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 億: 1e8 }[m[2].toLowerCase() as 'k'] ?? 1
  return Math.round(n * mul)
}

/** Every channel the account subscribes to (FEchannels, following continuations). */
export async function subscriptions(): Promise<SubChannel[]> {
  const out = new Map<string, SubChannel>()
  let page = await innertube('browse', { browseId: 'FEchannels' })
  for (let i = 0; i < 20; i++) {
    for (const c of findAll(page, 'channelRenderer')) {
      if (!c?.channelId || out.has(c.channelId)) continue
      // In this list subscriberCountText holds the @handle and videoCountText the subscriber count.
      const a = text(c.subscriberCountText)
      const b = text(c.videoCountText)
      const handle = a.startsWith('@') ? a : b.startsWith('@') ? b : ''
      const subs = parseCount(a.startsWith('@') ? b : a)
      out.set(c.channelId, { kind: 'channel', id: c.channelId, name: text(c.title), handle, subs, avatar: bigThumb(c.thumbnail?.thumbnails) })
    }
    const token = findAll(page, 'continuationCommand').next().value?.token
    if (!token) break
    page = await innertube('browse', { continuation: token })
  }
  return [...out.values()]
}

export async function subscribe(channelId: string, on: boolean) {
  await innertube(on ? 'subscription/subscribe' : 'subscription/unsubscribe', { channelIds: [channelId] })
}

/* ---------------- playlists (the account's own, read and written through youtubei) ---------------- */
export type PlaylistOption = { id: string; title: string; has: boolean; privacy: string }
/** Your playlists, each marked with whether it already holds `videoId`. */
export async function playlistsFor(videoId: string): Promise<PlaylistOption[]> {
  const j = await innertube('playlist/get_add_to_playlist', { videoIds: [videoId], excludeWatchLater: false })
  const out: PlaylistOption[] = []
  for (const r of findAll(j, 'playlistAddToOptionRenderer'))
    out.push({ id: r.playlistId, title: text(r.title), has: r.containsSelectedVideos === 'ALL', privacy: String(r.privacy ?? '') })
  return out
}
export async function playlistEdit(playlistId: string, videoId: string, add: boolean) {
  const action = add ? { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId } : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }
  const j = await innertube('browse/edit_playlist', { playlistId, actions: [action] })
  if (j.status && j.status !== 'STATUS_SUCCEEDED') throw new Error(`YouTube: ${j.status}`)
}
export async function playlistCreate(title: string, privacy: 'PRIVATE' | 'UNLISTED' | 'PUBLIC', videoId?: string): Promise<string> {
  const j = await innertube('playlist/create', { title, privacyStatus: privacy, ...(videoId ? { videoIds: [videoId] } : {}) })
  if (!j.playlistId) throw new Error('YouTube did not create the playlist')
  return j.playlistId
}

/** Your playlists (Library ▸ Playlists), read with the session like YouTube's own page. */
export async function myPlaylists(): Promise<{ id: string; title: string; count: number | null; thumb: string }[]> {
  const j = await innertube('browse', { browseId: 'FEplaylist_aggregation' })
  const out: { id: string; title: string; count: number | null; thumb: string }[] = []
  for (const l of findAll(j, 'lockupViewModel')) {
    let id = l.contentId as string | undefined
    if (!id) {
      const be = [...findAll(l, 'browseEndpoint')][0]
      id = be?.browseId?.replace(/^VL/, '')
    }
    if (!id) continue
    const badge = [...findAll(l, 'thumbnailBadgeViewModel')][0]?.text ?? ''
    const src = [...findAll(l, 'thumbnailViewModel')][0]?.image?.sources?.[0]?.url ?? ''
    out.push({ id, title: text(l.metadata?.lockupMetadataViewModel?.title), count: /\d/.test(badge) ? Number(badge.replace(/[^\d]/g, '')) : null, thumb: src })
  }
  return out
}
/** One playlist's videos (private ones too), first page (about 100). */
export async function playlistPage(id: string) {
  const j = await innertube('browse', { browseId: `VL${id}` })
  const meta = [...findAll(j, 'playlistMetadataRenderer')][0]
  const videos = [...findAll(j, 'playlistVideoRenderer')]
    .filter((r) => r.videoId)
    .map((r) => {
      const by = r.shortBylineText?.runs?.[0]
      return {
        kind: 'video' as const,
        id: String(r.videoId),
        title: text(r.title),
        channel: by?.text ?? '',
        channelId: by?.navigationEndpoint?.browseEndpoint?.browseId ?? '',
        duration: r.lengthSeconds ? Number(r.lengthSeconds) : null,
        views: null,
        live: !r.lengthSeconds && !!r.isPlayable,
        thumb: `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`
      }
    })
  return { title: meta?.title ?? '', videos }
}

/** Home recommendations for the signed-in account (yt-dlp's :ytrec comes back empty). */
export async function recommended() {
  const j = await innertube('browse', { browseId: 'FEwhat_to_watch' })
  const out: { kind: 'video'; id: string; title: string; channel: string; channelId: string; duration: number | null; views: number | null; live: boolean; thumb: string }[] = []
  const seen = new Set<string>()
  for (const l of findAll(j, 'lockupViewModel')) {
    if (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue
    const id = l.contentId as string
    if (!id || seen.has(id) || id.length !== 11) continue
    seen.add(id)
    const meta = l.metadata?.lockupMetadataViewModel
    const rows = [...findAll(meta, 'metadataParts')].flat()
    const parts = rows.map((p: any) => text(p.text))
    const ch = [...findAll(meta, 'browseEndpoint')].find((b: any) => /^UC/.test(b.browseId ?? ''))
    const badge = [...findAll(l, 'thumbnailBadgeViewModel')].map((b: any) => b.text ?? '').find((t: string) => /\d:\d/.test(t) || /LIVE|ライブ/i.test(t)) ?? ''
    const dur = /^(\d+:)?\d+:\d+$/.test(badge) ? badge.split(':').reduce((a: number, x: string) => a * 60 + Number(x), 0) : null
    const viewsText = parts.find((p: string) => /view|視聴/i.test(p)) ?? ''
    const vm = /([\d.,]+)\s*([KMB万億]?)/i.exec(viewsText)
    const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, '万': 1e4, '億': 1e8 }
    out.push({
      kind: 'video',
      id,
      title: text(meta?.title),
      channel: parts[0] ?? '',
      channelId: ch?.browseId ?? '',
      duration: dur,
      views: vm ? Math.round(Number(vm[1].replace(/,/g, '')) * (mult[vm[2]?.toUpperCase()] ?? mult[vm[2]] ?? 1)) : null,
      live: /LIVE|ライブ/i.test(badge),
      thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
    })
  }
  return out
}

export type Rating = 'like' | 'dislike' | 'none'
export async function rate(videoId: string, rating: Rating) {
  await innertube(rating === 'like' ? 'like/like' : rating === 'dislike' ? 'like/dislike' : 'like/removelike', { target: { videoId } })
}

/* ---------------- sign-in window ---------------- */

let login: { proc: ChildProcess; done: Promise<Account> } | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdp(wsUrl: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const WS = (globalThis as any).WebSocket
  if (!WS) throw new Error('This Orca has no WebSocket in workers')
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl)
    const timer = setTimeout(() => (ws.close(), reject(new Error('DevTools timeout'))), 8000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onerror = () => (clearTimeout(timer), reject(new Error('DevTools connection failed')))
    ws.onmessage = (ev: any) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
}

async function browserWs(): Promise<string | null> {
  try {
    const [port] = readFileSync(join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')
    const r = await fetch(`http://127.0.0.1:${port.trim()}/json/version`)
    return (await r.json()).webSocketDebuggerUrl ?? null
  } catch {
    return null
  }
}

function toNetscape(cookies: any[]): string {
  return cookies
    .filter((c) => keep(c.domain))
    .map((c) =>
      [
        (c.httpOnly ? '#HttpOnly_' : '') + c.domain,
        c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
        c.path,
        c.secure ? 'TRUE' : 'FALSE',
        c.session || c.expires < 0 ? '0' : String(Math.floor(c.expires)),
        c.name,
        c.value
      ].join('\t')
    )
    .join('\n')
}

/** Cookie names in the profile's cookie DB (names are plain text; values stay encrypted). */
function cookieNames(): Set<string> {
  const db = [join(PROFILE, 'Default/Cookies'), join(PROFILE, 'Default/Network/Cookies')].find((p) => existsSync(p))
  if (!db) return new Set()
  // Chrome keeps the DB open; read a copy.
  const copy = join(tmpdir(), `orca-tube-cookies-${process.pid}.db`)
  try {
    copyFileSync(db, copy)
    const out = execFileSync('/usr/bin/sqlite3', [copy, "SELECT name FROM cookies WHERE host_key LIKE '%youtube.com'"], { encoding: 'utf8', timeout: 5000 })
    return new Set(out.split('\n').filter(Boolean))
  } catch {
    return new Set()
  } finally {
    rmSync(copy, { force: true })
  }
}
const loggedInNames = (n: Set<string>) => (n.has('SAPISID') || n.has('__Secure-3PAPISID')) && n.has('LOGIN_INFO')

function waitExit(proc: ChildProcess, ms: number) {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    const t = setTimeout(() => (proc.kill('SIGKILL'), resolve()), ms)
    proc.once('exit', () => (clearTimeout(t), resolve()))
  })
}

/** A sign-in window left behind by an earlier worker (a reload drops our handle to it). */
function closeStale() {
  try {
    execFileSync('/usr/bin/pkill', ['-TERM', '-f', `user-data-dir=${PROFILE}`])
    execFileSync('/bin/sleep', ['1.5'])
  } catch {} // pkill exits 1 when nothing matched
}

/** Starts the profile headless with DevTools on and reads its cookies (Chrome decrypts them itself). */
async function readProfileCookies(chrome: string): Promise<any[]> {
  rmSync(join(PROFILE, 'DevToolsActivePort'), { force: true })
  const proc = spawn(chrome, [`--user-data-dir=${PROFILE}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      const ws = await browserWs()
      if (!ws) continue
      const { cookies } = await cdp(ws, 'Storage.getCookies')
      await cdp(ws, 'Browser.close').catch(() => {})
      return cookies
    }
    throw new Error('Could not read the sign-in profile')
  } finally {
    await waitExit(proc, 5000)
  }
}

/**
 * Opens a plain Chrome window on our own profile (no DevTools port: Google refuses sign-in when
 * one is open). Once the profile holds YouTube login cookies, or the person closes the window,
 * Chrome is asked to quit, then the profile is reopened headless to read the cookies over CDP.
 */
export function beginLogin(log?: (m: string) => void): Promise<Account> {
  if (login) return login.done
  const chrome = CHROMES.find((p) => existsSync(p))
  if (!chrome) return Promise.reject(new Error('Chrome, Brave, Edge or Vivaldi is needed for the sign-in window'))
  if (!(globalThis as any).WebSocket) return Promise.reject(new Error('This Orca has no WebSocket in workers; use a browser sign-in below'))
  ensureDir()
  closeStale()
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=520,760',
      'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F'
    ],
    { stdio: 'ignore' }
  )
  let exited = false
  proc.on('exit', () => (exited = true))
  const done = (async () => {
    try {
      const deadline = Date.now() + 15 * 60_000
      // Chrome writes cookies to disk every ~30 s, so detection can lag a little.
      while (!exited && Date.now() < deadline && !loggedInNames(cookieNames())) await sleep(2000)
      if (!exited) {
        log?.('sign-in detected; closing the window')
        proc.kill('SIGTERM') // a normal quit: Chrome flushes its cookie store
        await waitExit(proc, 8000)
      }
      if (!loggedInNames(cookieNames())) throw new Error(Date.now() >= deadline ? 'Sign-in timed out' : 'The sign-in window was closed before signing in')
      const cookies = await readProfileCookies(chrome)
      log?.(`read ${cookies.length} cookies from the sign-in profile`)
      saveCookieFile(toNetscape(cookies))
      return await account()
    } catch (e) {
      if (!exited) proc.kill()
      throw e
    } finally {
      login = null
    }
  })()
  login = { proc, done }
  return done
}

export function cancelLogin() {
  login?.proc.kill()
  login = null
  closeStale()
}

/* ---------------- existing browser profiles ---------------- */

const SUPPORT = join(homedir(), 'Library/Application Support')
const CHROMIUMS: [id: string, label: string, dir: string, app: string][] = [
  ['chrome', 'Chrome', 'Google/Chrome', 'Google Chrome'],
  ['brave', 'Brave', 'BraveSoftware/Brave-Browser', 'Brave Browser'],
  ['edge', 'Edge', 'Microsoft Edge', 'Microsoft Edge'],
  ['vivaldi', 'Vivaldi', 'Vivaldi', 'Vivaldi']
]
export type BrowserProfile = { browser: string; label: string; profile: string; name: string; email: string; picture: string; active: number }

/** Profiles of installed Chromium browsers, most recently used first (from each Local State). */
export function browserProfiles(): BrowserProfile[] {
  const out: BrowserProfile[] = []
  for (const [browser, label, dir] of CHROMIUMS) {
    let state: any
    try {
      state = JSON.parse(readFileSync(join(SUPPORT, dir, 'Local State'), 'utf8'))
    } catch {
      continue
    }
    for (const [profile, info] of Object.entries<any>(state?.profile?.info_cache ?? {})) {
      out.push({
        browser,
        label,
        profile,
        name: info.gaia_name || info.name || profile,
        email: info.user_name || '',
        picture: info.last_downloaded_gaia_picture_url_with_size || '',
        active: Number(info.active_time) || 0
      })
    }
  }
  return out.sort((a, b) => +!!b.email - +!!a.email || b.active - a.active)
}

const SOURCE = join(DATA_DIR, 'source.json')
export type Source = { browser: string; profile?: string }
export const lastSource = (): Source | null => {
  try {
    return JSON.parse(readFileSync(SOURCE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Copies a browser profile's YouTube login through yt-dlp. Chromium browsers keep cookies
 * encrypted with a keychain key, so macOS asks once (choose "Always Allow").
 */
export async function importFromBrowser(run: (args: string[]) => Promise<any>, source: Source) {
  ensureDir()
  const tmp = join(tmpdir(), `orca-tube-import-${Math.random().toString(36).slice(2)}.txt`)
  const spec = source.profile ? `${source.browser}:${source.profile}` : source.browser
  try {
    try {
      await run(['--cookies-from-browser', spec, '--cookies', tmp, '--flat-playlist', '--playlist-end', '1', ':ytsubs'])
    } catch (e) {
      // A profile not signed in to YouTube still writes its cookies before yt-dlp gives up.
      if (!existsSync(tmp)) throw e
    }
    saveCookieFile(readFileSync(tmp, 'utf8'))
  } finally {
    rmSync(tmp, { force: true })
  }
  writeFileSync(SOURCE, JSON.stringify(source), { mode: 0o600 })
  return account()
}

/** Opens youtube.com in that browser profile, for a profile that is not signed in to YouTube yet. */
export function openInProfile(source: Source) {
  const app = CHROMIUMS.find(([id]) => id === source.browser)?.[3]
  if (!app) throw new Error('Unknown browser')
  spawn('/usr/bin/open', ['-na', app, '--args', ...(source.profile ? [`--profile-directory=${source.profile}`] : []), 'https://www.youtube.com/'], {
    stdio: 'ignore',
    detached: true
  }).unref()
}

export function signOut() {
  cancelLogin()
  rmSync(COOKIES, { force: true })
  rmSync(SOURCE, { force: true })
  rmSync(PROFILE, { recursive: true, force: true })
}

export async function suggest(q: string): Promise<string[]> {
  const r = await fetch(`https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=ja&q=${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': UA }
  })
  const body = await r.text()
  const json = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')')))
  return (json[1] ?? []).map((x: any) => String(x[0])).slice(0, 10)
}
