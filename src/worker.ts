// Tube worker: answers the panel. Lists come from yt-dlp (JSON only); images and video bytes are
// fetched here and handed over as base64, because the panel's frame may only load data:/blob:.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as https from 'node:https'
import type { OrcaWorkerApi } from 'orca/worker'
import * as auth from './auth'
import { chatPoll, chatStart } from './chat'
import { channel, channelAvatar, comments, downloadState, playlistVideos, startDownload, type Caption, parseJson3, pickCaptions, type ChannelTab, feed, type Feed, pickFormats, search, type SearchOpts, type Track, type Watch, ytdlp, YTDLP, thumbOf } from './yt'

/** Panel answers are capped at 1 MiB of JSON: 720 KB of bytes is 960 KB of base64. */
const CHUNK = 720_000
const IMG_BATCH_BYTES = 600_000

type Stream = { url: string; size: number; headers: Record<string, string>; expires: number }
const streams = new Map<string, Stream>()
const watchCache = new Map<string, { at: number; value: Watch }>()
const listCache = new Map<string, { at: number; value: unknown }>()
const imgCache = new Map<string, string>()
let imgBytes = 0
const captionUrls = new Map<string, { url: string; headers: Record<string, string> }>()
const cueCache = new Map<string, unknown[]>()
/** Live: key → master playlist + the headers yt-dlp used; recent segments, sliced to the panel. */
const liveSources = new Map<string, { url: string; headers: Record<string, string> }>()
const segCache = new Map<string, { at: number; buf: Buffer }>()
const LIVE_HOST = /^https:\/\/([\w-]+\.)*googlevideo\.com\//

/**
 * YouTube's live media playlists list the whole DVR window (an hour, ~700 lines). The panel only
 * plays near the live edge, so keep the last `keep` segments and move the sequence numbers along.
 */
export function trimPlaylist(text: string, keep = 30): string {
  const lines = text.split('\n')
  const segTag = /^#(EXTINF|EXT-X-PROGRAM-DATE-TIME|EXT-X-DISCONTINUITY$|EXT-X-BYTERANGE)/
  const first = lines.findIndex((l) => segTag.test(l))
  if (first < 0) return text
  const head = lines.slice(0, first)
  const blocks: string[][] = []
  let cur: string[] = []
  for (const l of lines.slice(first)) {
    if (!l.trim()) continue
    cur.push(l)
    if (!l.startsWith('#')) (blocks.push(cur), (cur = []))
  }
  const tail = cur // e.g. #EXT-X-ENDLIST
  const drop = Math.max(0, blocks.length - keep)
  if (!drop) return text
  const discs = blocks.slice(0, drop).filter((b) => b.includes('#EXT-X-DISCONTINUITY')).length
  const out = head.map((l) =>
    l.startsWith('#EXT-X-MEDIA-SEQUENCE:') ? `#EXT-X-MEDIA-SEQUENCE:${Number(l.split(':')[1]) + drop}` :
    l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:') ? `#EXT-X-DISCONTINUITY-SEQUENCE:${Number(l.split(':')[1]) + discs}` : l
  )
  return [...out, ...blocks.slice(drop).flat(), ...tail].join('\n') + '\n'
}
const LIST_TTL = 10 * 60_000

/** One yt-dlp run per key at a time: callers asking while it runs share its answer. */
const inflight = new Map<string, Promise<unknown>>()
function shared<T>(key: string, make: () => Promise<T>): Promise<T> {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const p = make().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function cached<T>(key: string, ttl: number, make: () => Promise<T>): Promise<T> {
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value as T
  const value = await shared(`c:${key}`, make)
  listCache.set(key, { at: Date.now(), value })
  if (listCache.size > 200) listCache.delete(listCache.keys().next().value!)
  return value
}

function sizeOf(f: any): number {
  if (f.filesize) return f.filesize
  const clen = /[?&]clen=(\d+)/.exec(f.url)?.[1]
  return clen ? Number(clen) : 0
}

function track(f: any, mime: string): Track | null {
  if (!f) return null
  const size = sizeOf(f)
  if (!size) return null
  const key = `${f.format_id}:${Math.random().toString(36).slice(2)}`
  const expires = Number(/[?&]expire=(\d+)/.exec(f.url)?.[1] ?? 0) * 1000 || Date.now() + 5 * 3600_000
  streams.set(key, { url: f.url, size, headers: f.http_headers ?? {}, expires })
  return { key, mime: `${mime}; codecs="${(mime.startsWith('video') ? f.vcodec : f.acodec) as string}"`, size }
}

async function watch(id: string, maxHeight: number, fresh = false): Promise<Watch> {
  const ck = `${id}@${maxHeight}`
  const hit = watchCache.get(ck)
  if (hit && !fresh && Date.now() - hit.at < 3 * 3600_000) return hit.value
  // a hover prefetch may already be resolving this video: wait for it instead of a second yt-dlp
  return shared(`w:${ck}:${fresh ? 'f' : ''}`, () => resolveWatch(id, maxHeight, ck))
}
async function resolveWatch(id: string, maxHeight: number, ck: string): Promise<Watch> {
  // Which stream URLs googlevideo accepts depends on the client yt-dlp asked: visionOS URLs play,
  // TV (TVHTML5) and signed-in web ones answer 403 (they want PO tokens). yt-dlp's default mix
  // returns either at random, so ask visionOS first, anonymously; then the default clients; then
  // cookies, for videos YouTube only shows signed in (age gate, members).
  const url = `https://www.youtube.com/watch?v=${id}`
  const attempts: [string[], boolean][] = [
    [['--extractor-args', 'youtube:player_client=visionos'], false],
    [[], false],
    [['--ignore-no-formats-error'], true]
  ]
  let j: any = null
  let firstError: unknown = null
  for (const [extra, cookies] of attempts) {
    if (cookies && !auth.signedIn()) break
    try {
      j = await ytdlp(['--no-playlist', ...extra, url], { cookies })
      if (pickFormats(j.formats ?? [], maxHeight).video || j.live_status === 'is_live') break
    } catch (e) {
      firstError ??= e
    }
  }
  if (!j) throw firstError ?? new Error('Could not read this video')
  const live = j.live_status === 'is_live' || j.is_live === true
  let hls: string | null = null
  if (live) {
    const f = (j.formats ?? []).find((x: any) => x.manifest_url && /m3u8/.test(x.protocol ?? ''))
    if (f) {
      hls = `live:${id}:${Math.random().toString(36).slice(2)}`
      liveSources.set(hls, { url: f.manifest_url, headers: f.http_headers ?? {} })
    }
  }
  const { video, audio } = live ? { video: null, audio: null } : pickFormats(j.formats ?? [], maxHeight)
  const value: Watch = {
    id,
    title: j.title ?? '',
    description: j.description ?? '',
    channel: j.channel ?? j.uploader ?? '',
    channelId: j.channel_id ?? '',
    avatar: '',
    subs: j.channel_follower_count ?? null,
    views: j.view_count ?? null,
    likes: j.like_count ?? null,
    duration: j.duration ?? 0,
    uploaded: j.upload_date ?? '',
    thumb: thumbOf(id),
    live,
    height: video?.height ?? 0,
    video: track(video, 'video/mp4'),
    audio: track(audio, 'audio/mp4'),
    hls,
    captions: pickCaptions(j).map(({ url, ...c }): Caption => {
      const key = `${id}:${c.lang}:${c.auto ? 'a' : 'u'}`
      captionUrls.set(key, { url, headers: j.http_headers ?? j.formats?.find((f: any) => f.http_headers)?.http_headers ?? {} })
      return { key, ...c }
    })
  }
  watchCache.set(ck, { at: Date.now(), value })
  if (watchCache.size > 40) watchCache.delete(watchCache.keys().next().value!)
  // stream keys of videos no longer cached go too
  if (streams.size > 120) for (const k of [...streams.keys()].slice(0, streams.size - 120)) streams.delete(k)
  if (liveSources.size > 20) for (const k of [...liveSources.keys()].slice(0, liveSources.size - 20)) liveSources.delete(k)
  if (captionUrls.size > 200) for (const k of [...captionUrls.keys()].slice(0, captionUrls.size - 200)) captionUrls.delete(k)
  return value
}

async function fetchImage(url: string): Promise<string> {
  const hit = imgCache.get(url)
  if (hit) return hit
  const r = await fetch(url)
  if (!r.ok) throw new Error(`image ${r.status}`)
  const type = r.headers.get('content-type') ?? 'image/jpeg'
  const data = `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`
  imgCache.set(url, data)
  imgBytes += data.length
  // bounded by size (≈12 MB of base64), oldest first
  while (imgBytes > 12_000_000 && imgCache.size) {
    const [k, v] = imgCache.entries().next().value!
    imgBytes -= v.length
    imgCache.delete(k)
  }
  return data
}

/**
 * GET with exactly the headers yt-dlp gives. Not fetch(): it forces `Sec-Fetch-Mode: cors`, and
 * googlevideo answers 403 to that for TV-client stream URLs (yt-dlp sends `navigate`).
 */
const agent = new https.Agent({ keepAlive: true, maxSockets: 6 })
function getRange(url: string, headers: Record<string, string>, redirects = 3): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, agent, timeout: 20_000 }, (res) => {
      const code = res.statusCode ?? 0
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume()
        return resolve(getRange(new URL(res.headers.location, url).toString(), headers, redirects - 1))
      }
      if (code !== 206 && code !== 200) {
        res.resume()
        return reject(new Error(`stream ${code}`))
      }
      const parts: Buffer[] = []
      res.on('data', (d: Buffer) => parts.push(d))
      res.on('end', () => resolve(Buffer.concat(parts)))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('stream timeout')))
    req.on('error', reject)
  })
}

const fail = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })

export default function activate(orca: OrcaWorkerApi): void {
  const handle = orca.panels.handle as (name: string, fn: (input: any) => unknown) => void

  handle('tube.status', async () => ({ ytdlp: YTDLP ?? null, signedIn: auth.signedIn() }))

  /* ---- account ---- */
  const forget = () => {
    listCache.clear()
    watchCache.clear()
  }
  const accountResult = async (p: Promise<auth.Account>) => {
    try {
      const account = await p
      forget()
      return { account }
    } catch (e) {
      return fail(e)
    }
  }
  const importer = (args: string[]) => ytdlp(args, { cookies: false, timeoutMs: 90_000 })
  /** The browser keeps rotating its cookies; when our copy goes stale, read them again once. */
  handle('auth.account', async () => {
    if (!auth.signedIn()) return { account: null }
    try {
      return { account: await auth.account() }
    } catch (e) {
      const src = auth.lastSource()
      if (!src || !/sign in again|refused/i.test((e as Error).message)) return fail(e)
      orca.log(`session stale, re-reading ${src.browser}:${src.profile ?? ''}`)
      return accountResult(auth.importFromBrowser(importer, src))
    }
  })
  handle('auth.profiles', async () => ({
    profiles: auth.browserProfiles().map(({ active, ...p }) => p),
    current: auth.lastSource()
  }))
  handle('auth.openProfile', async (src: auth.Source) => {
    try {
      auth.openInProfile(src)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })
  /** Resolves when the sign-in window finished (up to 10 minutes): call with a long timeout. */
  handle('auth.login', async () => accountResult(auth.beginLogin((m) => orca.log(m))))
  handle('auth.cancel', async () => (auth.cancelLogin(), null))
  handle('auth.import', async (src: auth.Source) => accountResult(auth.importFromBrowser(importer, src)))
  handle('auth.logout', async () => {
    auth.signOut()
    forget()
    return null
  })
  handle('yt.subscriptions', async ({ fresh }: { fresh?: boolean }) => {
    try {
      if (fresh) listCache.delete('subs')
      return { items: await cached('subs', LIST_TTL, () => auth.subscriptions()) }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.subscribe', async ({ id, on }: { id: string; on: boolean }) => {
    try {
      await auth.subscribe(id, on)
      listCache.delete('subs')
      listCache.delete('feed:subscriptions')
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.like', async ({ id, rating }: { id: string; rating: auth.Rating }) => {
    try {
      await auth.rate(id, rating)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.feed', async ({ kind, fresh }: { kind: Feed; fresh?: boolean }) => {
    try {
      if (fresh) listCache.delete('feed:' + kind)
      return { items: await cached('feed:' + kind, kind === 'history' ? 60_000 : LIST_TTL, () => (kind === 'recommended' ? auth.recommended() : feed(kind))) }
    } catch (e) {
      return fail(e)
    }
  })
  handle('tube.suggest', async ({ q }: { q: string }) => {
    try {
      return { items: await auth.suggest(q) }
    } catch (e) {
      return fail(e)
    }
  })

  /** Opens a video in every open Tube panel (also handy from `orca plugin dev request`). */
  handle('tube.remote', async (input: { id?: string; t?: number; status?: boolean; view?: string; channel?: string; q?: string; ui?: string; text?: string }) => {
    orca.panels.post('tube.open' as never, input as never)
    return { ok: true }
  })
  handle('tube.log', async ({ msg }: { msg: string }) => {
    orca.log(String(msg).slice(0, 500))
    return null
  })

  handle('tube.search', async ({ q, ...opts }: { q: string } & SearchOpts) => {
    try {
      return { items: await cached(`s:${JSON.stringify(opts)}:${q}`, LIST_TTL, () => search(q, opts)) }
    } catch (e) {
      return fail(e)
    }
  })

  handle('tube.channel', async ({ id, tab }: { id: string; tab?: ChannelTab }) => {
    try {
      return { channel: await cached(`c:${id}:${tab}`, LIST_TTL, () => channel(id, tab ?? 'videos')) }
    } catch (e) {
      return fail(e)
    }
  })

  /** Latest uploads of every followed channel, interleaved so one busy channel does not fill it. */
  handle('tube.feed', async ({ ids }: { ids: string[] }) => {
    const lists: any[][] = []
    const queue = [...ids]
    const lane = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const page = await cached(`c:${id}:videos`, LIST_TTL, () => channel(id!, 'videos'))
          lists.push(page.videos.slice(0, 8))
        } catch (e) {
          orca.log(`feed ${id}: ${(e as Error).message}`)
        }
      }
    }
    await Promise.all([lane(), lane(), lane(), lane()])
    const items: any[] = []
    for (let i = 0; i < 8; i++) for (const l of lists) if (l[i]) items.push(l[i])
    return { items }
  })

  handle('tube.watch', async ({ id, maxHeight, fresh }: { id: string; maxHeight?: number; fresh?: boolean }) => {
    try {
      const w = { ...(await watch(id, maxHeight ?? 720, fresh)) }
      // The watch JSON has no avatar; use the channel page only if it is already cached, and let
      // the panel fill it in later otherwise (it loads that page for "more videos" anyway).
      const page = listCache.get(`c:${w.channelId}:videos`)?.value as { avatar: string; subs: number | null } | undefined
      if (page) Object.assign(w, { avatar: page.avatar, subs: w.subs ?? page.subs })
      return { watch: w }
    } catch (e) {
      return fail(e)
    }
  })

  /** One slice of a stream: `len` bytes from `start` (capped at CHUNK). */
  handle('tube.chunk', async ({ key, start, len }: { key: string; start: number; len?: number }) => {
    const s = streams.get(key)
    if (!s) return { error: 'expired' }
    if (Date.now() > s.expires - 60_000) return { error: 'expired' }
    const end = Math.min(s.size, start + Math.min(len ?? CHUNK, CHUNK)) - 1
    if (start > end) return { b64: '', eof: true }
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const buf = await getRange(s.url, { ...s.headers, Range: `bytes=${start}-${end}` })
        return { b64: buf.toString('base64'), eof: start + buf.length >= s.size }
      } catch (e) {
        lastErr = e
      }
    }
    return fail(lastErr)
  })

  handle('tube.comments', async ({ id }: { id: string }) => {
    try {
      return await cached(`cm:${id}`, LIST_TTL, () => comments(id))
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * Live HLS for hls.js in the panel: playlists come back as text (media playlists trimmed to the
   * live edge), segments as base64 slices of at most CHUNK bytes (`start` asks for the next one).
   */
  handle('tube.hls', async ({ key, url, start }: { key: string; url?: string; start?: number }) => {
    const src = liveSources.get(key)
    if (!src) return { error: 'expired' }
    const target = url ?? src.url
    if (!LIVE_HOST.test(target)) return { error: 'not a YouTube stream URL' }
    try {
      if (/\/api\/manifest\//.test(target)) {
        const text = (await getRange(target, src.headers)).toString('utf8')
        return { text: /hls_playlist/.test(target) ? trimPlaylist(text) : text }
      }
      let hit = segCache.get(target)
      if (!hit) {
        hit = { at: Date.now(), buf: await getRange(target, src.headers) }
        segCache.set(target, hit)
        for (const [k, v] of segCache) if (Date.now() - v.at > 60_000 || segCache.size > 24) segCache.delete(k)
      }
      const from = start ?? 0
      const part = hit.buf.subarray(from, from + CHUNK)
      return { b64: part.toString('base64'), total: hit.buf.length }
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * Live chat: without `key` it opens the chat (newest messages); with it, returns what arrived
   * since the last call. The panel polls every few seconds while the chat is open.
   */
  const chats = new Map<string, { cont: string; version: string; at: number }>()
  handle('tube.chat', async ({ id, key }: { id: string; key?: string }) => {
    try {
      const st = key ? chats.get(key) : undefined
      if (!st) {
        const first = await chatStart(id)
        if (!first.cont) return { error: 'Live chat is off for this stream' }
        const k = `${id}:${Math.random().toString(36).slice(2)}`
        chats.set(k, { cont: first.cont, version: first.version, at: Date.now() })
        for (const [kk, v] of chats) if (Date.now() - v.at > 10 * 60_000) chats.delete(kk)
        return { key: k, items: first.items.slice(-60) }
      }
      const page = await chatPoll(st.cont, st.version)
      if (page.cont) st.cont = page.cont
      st.at = Date.now()
      return { key, items: page.items.slice(-150) }
    } catch (e) {
      return fail(e)
    }
  })

  handle('tube.download', async ({ id, maxHeight }: { id: string; maxHeight?: number }) => {
    try {
      return { download: startDownload(id, maxHeight ?? 1080) }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.playlistsFor', async ({ id }: { id: string }) => {
    try {
      return { playlists: await auth.playlistsFor(id) }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.playlistEdit', async ({ playlistId, id, add }: { playlistId: string; id: string; add: boolean }) => {
    try {
      await auth.playlistEdit(playlistId, id, add)
      listCache.delete('pl:mine')
      listCache.delete(`pl:${playlistId}`)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.playlistCreate', async ({ title, privacy, id }: { title: string; privacy?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'; id?: string }) => {
    try {
      const playlistId = await auth.playlistCreate(title, privacy ?? 'PRIVATE', id)
      listCache.delete('pl:mine')
      return { playlistId }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.playlists', async ({ fresh }: { fresh?: boolean }) => {
    try {
      if (!auth.signedIn()) return { error: 'Sign in first' }
      if (fresh) listCache.delete('pl:mine')
      return { playlists: await cached('pl:mine', LIST_TTL, () => auth.myPlaylists()) }
    } catch (e) {
      return fail(e)
    }
  })
  handle('yt.playlist', async ({ id, fresh }: { id: string; fresh?: boolean }) => {
    try {
      if (fresh) listCache.delete(`pl:${id}`)
      // signed in: youtubei (private playlists too); otherwise yt-dlp reads public ones
      return await cached(`pl:${id}`, LIST_TTL, () => (auth.signedIn() ? auth.playlistPage(id) : playlistVideos(id)))
    } catch (e) {
      return fail(e)
    }
  })
  /** Avatars for channels the lists name but do not picture (recommendations, search). */
  const avatarOf = new Map<string, string>()
  handle('tube.channelAvatars', async ({ ids }: { ids: string[] }) => {
    const want = [...new Set(ids)].filter((id) => /^UC[\w-]{22}$/.test(id)).slice(0, 16)
    const out: Record<string, string> = {}
    let next = 0
    const lane = async () => {
      while (next < want.length) {
        const id = want[next++]
        try {
          const url = avatarOf.get(id) ?? (await shared(`av:${id}`, () => channelAvatar(id)))
          avatarOf.set(id, url)
          if (avatarOf.size > 2000) avatarOf.delete(avatarOf.keys().next().value!)
          out[id] = url
        } catch {
          out[id] = ''
        }
      }
    }
    await Promise.all([lane(), lane(), lane(), lane()])
    return { avatars: out }
  })
  handle('tube.downloadState', async ({ id }: { id: string }) => ({ download: downloadState(id) }))
  /** Shows a downloaded file in Finder. */
  handle('tube.reveal', async ({ file }: { file: string }) => {
    if (!file.startsWith(join(homedir(), 'Downloads'))) return { error: 'not a Tube download' }
    spawn('open', ['-R', file], { stdio: 'ignore' }).on('error', () => {})
    return { ok: true }
  })

  /** Copies text to the clipboard (the panel frame may not be allowed to). */
  handle('tube.copy', async ({ text }: { text: string }) => {
    try {
      await new Promise<void>((ok, no) => {
        const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
        p.on('error', no)
        p.on('close', (code) => (code === 0 ? ok() : no(new Error(`pbcopy ${code}`))))
        p.stdin.end(String(text))
      })
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })

  /** One caption track as cues ([start, end, text] in seconds). */
  handle('tube.captions', async ({ key }: { key: string }) => {
    const src = captionUrls.get(key)
    if (!src) return { error: 'expired' }
    const hit = cueCache.get(key)
    if (hit) return { cues: hit }
    try {
      // not fetch(): YouTube answers Node's fetch with a 429 "unusual traffic" page. timedtext also
      // answers 429 for a few seconds after a burst (right after yt-dlp read the video), so back off.
      let body: Buffer | null = null
      for (const wait of [0, 1500, 4000, 8000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait))
        try {
          body = await getRange(src.url, src.headers)
          break
        } catch (e) {
          if (!/429/.test(String(e)) || wait === 8000) throw e
        }
      }
      const cues = parseJson3(JSON.parse(body!.toString('utf8')))
      // stay under the 1 MiB answer cap; a very long auto track is cut rather than refused
      let size = 0
      const fit = cues.filter((c) => (size += c[2].length * 3 + 24) < 900_000)
      cueCache.set(key, fit)
      if (cueCache.size > 30) cueCache.delete(cueCache.keys().next().value!)
      return { cues: fit }
    } catch (e) {
      return fail(e)
    }
  })

  /** Several small images per request, as data: URLs. */
  handle('tube.images', async ({ urls }: { urls: string[] }) => {
    const got = await Promise.all(urls.slice(0, 12).map((u) => fetchImage(u).catch(() => '')))
    const out: Record<string, string> = {}
    let total = 0
    got.forEach((d, i) => {
      // Whatever does not fit is left out; the panel asks for it again.
      if (total + d.length > IMG_BATCH_BYTES && total > 0) return
      out[urls[i]] = d
      total += d.length
    })
    return { images: out }
  })
}
