// yt-dlp wrapper and the shapes the panel sees. Everything here runs in the worker (Node).
import { innertubeAnon } from './chat'
import type { Caption, Channel, ChannelPage, Cue, Item, Track, Video, Watch } from './shapes'
export type { Caption, Channel, ChannelPage, Cue, Item, Track, Video, Watch }
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cookieCopy } from './auth'





/**
 * The caption tracks worth offering: every uploaded one, plus YouTube's automatic captions in the
 * spoken language and as Japanese / English translations (the full list is ~150 languages).
 */
/** A channel's avatar URL, from youtubei browse (≈35 KB, anonymous). */
export async function channelAvatar(id: string): Promise<string> {
  const j = JSON.parse(await innertubeAnon('browse', { context: { client: { clientName: 'WEB', clientVersion: '2.20261123.00.00', hl: 'en' } }, browseId: id }))
  return avatarUrl(j.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url, 88)
}

export function pickCaptions(j: any): { lang: string; name: string; auto: boolean; orig?: boolean; url: string }[] {
  const json3 = (list: any[] | undefined) => list?.find((f) => f.ext === 'json3')?.url as string | undefined
  const out: { lang: string; name: string; auto: boolean; orig?: boolean; url: string }[] = []
  for (const [lang, list] of Object.entries<any[]>(j.subtitles ?? {})) {
    if (lang === 'live_chat') continue
    const url = json3(list)
    if (url) out.push({ lang, name: list[0]?.name ?? lang, auto: false, url })
  }
  const spoken = j.language as string | undefined
  const autos = j.automatic_captions ?? {}
  for (const [lang, list] of Object.entries<any[]>(autos)) {
    const base = lang.replace(/-orig$/, '')
    const wanted = lang.endsWith('-orig') || base === spoken || base === 'ja' || base === 'en'
    if (!wanted || out.some((c) => c.lang === base)) continue
    if (!lang.endsWith('-orig') && autos[`${lang}-orig`]) continue // the -orig one is the same track
    const url = json3(list)
    const orig = lang.endsWith('-orig') || base === spoken
    if (url) out.push({ lang: base, name: `${(list[0]?.name ?? base).replace(/\s*\(Original\)$/, '')} (${orig ? 'auto' : 'auto-translated'})`, auto: true, orig, url })
  }
  // uploaded first, then the spoken language, then machine translations (YouTube often refuses those)
  return out.sort((a, b) => Number(a.auto) - Number(b.auto) || Number(!!b.orig) - Number(!!a.orig))
}

/** YouTube json3 captions → cues in seconds. Empty and newline-only events are dropped. */
export function parseJson3(data: any): Cue[] {
  const cues: Cue[] = []
  for (const e of data?.events ?? []) {
    if (!e.segs) continue
    const text = e.segs.map((g: any) => g.utf8 ?? '').join('').trim()
    if (!text) continue
    const start = (e.tStartMs ?? 0) / 1000
    cues.push([start, start + (e.dDurationMs ?? 2000) / 1000, text])
  }
  return cues
}

const HOME = homedir()
const BIN_DIRS = [
  join(HOME, '.local/bin'),
  join(HOME, '.nix-profile/bin'),
  '/etc/profiles/per-user/' + (process.env.USER ?? '') + '/bin',
  '/run/current-system/sw/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin'
]
const PATH = [...BIN_DIRS, process.env.PATH ?? ''].join(':')
const which = (name: string) => BIN_DIRS.map((d) => join(d, name)).find((p) => existsSync(p))

export const YTDLP = which('yt-dlp')
/** yt-dlp needs a JS runtime to solve YouTube's signatures; Orca's own Node is not a plain `node`. */
const JS = which('deno') ? [] : which('node') ? ['--js-runtimes', 'node:' + which('node')] : []

/** Runs yt-dlp with `-J`; signed in, it gets a private copy of the account cookies. */
export function ytdlp(args: string[], { timeoutMs = 40_000, cookies = true } = {}): Promise<any> {
  if (!YTDLP) return Promise.reject(new Error('yt-dlp not found. Install it (e.g. `pipx install yt-dlp`).'))
  const jar = cookies ? cookieCopy() : null
  return new Promise<any>((resolve, reject) => {
    const p = spawn(YTDLP, ['--no-update', '--no-warnings', '-J', ...JS, ...(jar ? ['--cookies', jar.path] : []), ...args], {
      env: { ...process.env, PATH },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (d: Buffer) => out.push(d))
    p.stderr.on('data', (d: Buffer) => (err += d))
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.on('error', (e) => (clearTimeout(timer), reject(e)))
    p.on('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(out).toString('utf8')
      if (code === 0 && text) {
        try {
          return resolve(JSON.parse(text))
        } catch (e) {
          return reject(e)
        }
      }
      const last = err.trim().split('\n').filter((l) => l.startsWith('ERROR')).pop()
      reject(new Error((last ?? err.trim().split('\n').pop() ?? 'yt-dlp failed').replace(/^ERROR:\s*/, '')))
    })
  }).then(
    (v) => (jar?.commit(), v),
    (e) => (jar?.drop(), Promise.reject(e))
  )
}

/** Account feeds (need cookies): recommendations, subscriptions, history, watch later, likes. */
export type Feed = 'recommended' | 'subscriptions' | 'history' | 'watchlater' | 'liked'
const FEEDS: Record<Feed, string> = {
  recommended: ':ytrec',
  subscriptions: ':ytsubs',
  history: ':ythis',
  watchlater: ':ytwatchlater',
  liked: 'https://www.youtube.com/playlist?list=LL'
}
export async function feed(kind: Feed, limit = 30): Promise<Video[]> {
  const j = await ytdlp(['--flat-playlist', '--playlist-end', String(limit), FEEDS[kind]])
  return (j.entries ?? []).map((e: any) => toItem(e)).filter((x: Item | null): x is Video => x?.kind === 'video')
}

export const thumbOf = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
/** Shorts: the original (vertical) aspect ratio */
export const shortThumb = (id: string) => `https://i.ytimg.com/vi/${id}/oar2.jpg`

/** yt3 avatar URLs carry their size after `=`; ask for a small square one. */
export function avatarUrl(url: string | undefined, size = 176): string {
  if (!url) return ''
  const u = url.startsWith('//') ? 'https:' + url : url
  return u.includes('=') ? u.replace(/=[^=/]*$/, `=s${size}-c-k-c0x00ffffff-no-rj`) : u
}

function pickAvatar(thumbs: any[] | undefined): string {
  if (!thumbs?.length) return ''
  const t = thumbs.find((x) => x.id === 'avatar_uncropped') ?? thumbs.find((x) => x.width && x.width === x.height) ?? thumbs[0]
  return avatarUrl(t?.url)
}

function pickBanner(thumbs: any[] | undefined): string {
  const wide = (thumbs ?? []).filter((x) => x.width && x.height && x.width / x.height > 3)
  wide.sort((a, b) => Math.abs(a.width - 1060) - Math.abs(b.width - 1060))
  return wide[0]?.url ?? ''
}

export function toItem(e: any, fallback?: { channel?: string; channelId?: string }): Item | null {
  if (!e?.id) return null
  if (e.ie_key === 'YoutubeTab' || /^UC[\w-]{22}$/.test(e.id)) {
    return {
      kind: 'channel',
      id: e.channel_id ?? e.id,
      name: e.channel ?? e.title ?? '',
      handle: e.uploader_id ?? '',
      subs: e.channel_follower_count ?? null,
      avatar: pickAvatar(e.thumbnails)
    }
  }
  if (e.ie_key && e.ie_key !== 'Youtube') return null
  return {
    kind: 'video',
    id: e.id,
    title: e.title ?? '',
    channel: e.channel ?? e.uploader ?? fallback?.channel ?? '',
    channelId: e.channel_id ?? fallback?.channelId ?? '',
    duration: typeof e.duration === 'number' ? e.duration : null,
    views: e.view_count ?? e.concurrent_view_count ?? null,
    live: e.live_status === 'is_live' || (e.duration == null && e.concurrent_view_count != null),
    thumb: thumbOf(e.id)
  }
}

export type SearchSort = 'relevance' | 'date' | 'views'
export type SearchType = 'video' | 'channel' | 'short'
export type SearchDate = '' | 'hour' | 'today' | 'week' | 'month' | 'year'
export type SearchLength = '' | 'short' | 'medium' | 'long'
export type SearchOpts = { sort?: SearchSort; type?: SearchType; date?: SearchDate; length?: SearchLength; limit?: number }

/**
 * YouTube's search filter (`sp`): a protobuf with the sort order in field 1 and, in field 2, upload
 * date (1), type (2) and length (3). Returned as plain base64 (URL-encode it for /results).
 */
export function searchParams(o: SearchOpts): string {
  const sort = { relevance: 0, date: 2, views: 3 }[o.sort ?? 'relevance'] ?? 0
  const type = { video: 1, channel: 2, short: 9 }[o.type ?? 'video'] ?? 1
  // YouTube offers neither filter for channels, nor (in practice) for Shorts
  const date = o.type && o.type !== 'video' ? 0 : ({ '': 0, hour: 1, today: 2, week: 3, month: 4, year: 5 }[o.date ?? ''] ?? 0)
  // current length buckets: under 3 min = 4, 3–20 min = 5, over 20 min = 2
  const length = o.type && o.type !== 'video' ? 0 : ({ '': 0, short: 4, medium: 5, long: 2 }[o.length ?? ''] ?? 0)
  const inner = [...(date ? [0x08, date] : []), 0x10, type, ...(length ? [0x18, length] : [])]
  const bytes = [...(sort ? [0x08, sort] : []), 0x12, inner.length, ...inner]
  return Buffer.from(bytes).toString('base64')
}

export async function search(q: string, opts: SearchOpts = {}) {
  const sp = searchParams(opts)
  if (opts.type === 'short') return searchShorts(q, sp)
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${encodeURIComponent(sp)}`
  const j = await ytdlp(['--flat-playlist', '--playlist-end', String(opts.limit ?? 20), url])
  return (j.entries ?? [])
    .map((e: any) => toItem(e))
    .filter((x: Item | null): x is Item => !!x && (opts.type ? x.kind === opts.type : true))
}

/**
 * Shorts results come as a grid yt-dlp does not read (it finds one), so ask youtubei/v1/search
 * directly, anonymously, and pick out the shorts lockups.
 */
async function searchShorts(q: string, sp: string): Promise<Video[]> {
  const j = JSON.parse(
    await innertubeAnon('search', { context: { client: { clientName: 'WEB', clientVersion: '2.20261123.00.00', hl: 'ja', gl: 'JP' } }, query: q, params: sp })
  )
  const out: Video[] = []
  const seen = new Set<string>()
  const walk = (o: any): void => {
    if (!o || typeof o !== 'object') return
    const s = o.shortsLockupViewModel
    const id = s?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push({
        kind: 'video',
        id,
        title: s.overlayMetadata?.primaryText?.content ?? '',
        channel: '',
        channelId: '',
        duration: null,
        views: null,
        viewsText: s.overlayMetadata?.secondaryText?.content ?? '',
        live: false,
        short: true,
        thumb: shortThumb(id)
      })
      return
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v)
  }
  walk(j)
  return out
}

export type ChannelTab = 'videos' | 'shorts' | 'streams'
export async function channel(id: string, tab: ChannelTab = 'videos', limit = 24): Promise<ChannelPage> {
  const base = id.startsWith('@') ? `https://www.youtube.com/${id}` : `https://www.youtube.com/channel/${id}`
  let j: any
  try {
    j = await ytdlp(['--flat-playlist', '--playlist-end', String(limit), `${base}/${tab}`])
  } catch (e) {
    // a channel without Shorts / Live has no such tab: show the channel with an empty list
    if (tab === 'videos' || !/does not have a \w+ tab/i.test(String(e))) throw e
    j = { ...(await ytdlp(['--flat-playlist', '--playlist-end', '1', `${base}/videos`])), entries: [] }
  }
  const fallback = { channel: j.channel, channelId: j.channel_id }
  return {
    kind: 'channel',
    id: j.channel_id ?? id,
    name: j.channel ?? j.uploader ?? '',
    handle: j.uploader_id ?? '',
    subs: j.channel_follower_count ?? null,
    avatar: pickAvatar(j.thumbnails),
    banner: pickBanner(j.thumbnails),
    description: j.description ?? '',
    videos: (j.entries ?? [])
      .map((e: any) => toItem(e, fallback))
      .filter((x: Item | null): x is Video => x?.kind === 'video')
      .map((v: Video) => (tab === 'shorts' ? { ...v, short: true, thumb: shortThumb(v.id) } : v))
  }
}

/** Best fragmented-MP4 pair: H.264 video no taller than `maxHeight`, AAC audio. */
export function pickFormats(formats: any[], maxHeight: number) {
  const dash = formats.filter((f) => f.protocol === 'https' && f.url)
  const videos = dash
    .filter((f) => f.vcodec?.startsWith('avc1') && f.acodec === 'none' && f.ext === 'mp4' && f.height)
    .sort((a, b) => b.height - a.height || (b.fps ?? 0) - (a.fps ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))
  const video = videos.find((f) => f.height <= maxHeight) ?? videos[videos.length - 1] ?? null
  const audios = dash
    .filter((f) => f.vcodec === 'none' && f.acodec?.startsWith('mp4a') && f.ext === 'm4a' && !String(f.format_id).includes('drc'))
    // Stereo first (itag 140); 5.1 tracks cost 3x the bytes for a sidebar.
    .sort((a, b) => +((a.audio_channels ?? 2) > 2) - +((b.audio_channels ?? 2) > 2) || (b.abr ?? 0) - (a.abr ?? 0))
  // Prefer the original-language track over dubbed ones.
  const audio = audios.find((f) => f.format_note?.includes('original') || f.language_preference > 0) ?? audios[0] ?? null
  return { video, audio }
}

export type Comment = { id: string; author: string; avatar: string; text: string; likes: number; time: string; pinned: boolean; uploader: boolean; hearted: boolean }

/** Top comments (no replies). Anonymous: yt-dlp reads them from the watch page. */
export async function comments(id: string, limit = 30): Promise<{ count: number | null; items: Comment[] }> {
  const j = await ytdlp(
    ['--no-playlist', '--write-comments', '--extractor-args', `youtube:max_comments=${limit},${limit},0,0;comment_sort=top;player_client=visionos`, `https://www.youtube.com/watch?v=${id}`],
    { cookies: false, timeoutMs: 60_000 }
  )
  const items: Comment[] = (j.comments ?? [])
    .filter((c: any) => (c.parent ?? 'root') === 'root')
    .slice(0, limit)
    .map((c: any) => ({
      id: String(c.id ?? ''),
      author: String(c.author ?? ''),
      avatar: avatarUrl(c.author_thumbnail, 88),
      text: String(c.text ?? '').slice(0, 2000),
      likes: Number(c.like_count ?? 0),
      time: String(c._time_text ?? ''),
      pinned: !!c.is_pinned,
      uploader: !!c.author_is_uploader,
      hearted: !!c.is_favorited
    }))
  return { count: j.comment_count ?? null, items }
}

/* ---------------- downloads ---------------- */
export type Download = { pct: number; done: boolean; file: string; error: string }
const downloads = new Map<string, Download>()
export const downloadState = (id: string): Download | null => downloads.get(id) ?? null

/** Saves the video (H.264 + AAC, merged to MP4 by ffmpeg) to ~/Downloads; progress via downloadState. */
export function startDownload(id: string, maxHeight: number): Download {
  const cur = downloads.get(id)
  if (cur && !cur.done && !cur.error) return cur
  if (!YTDLP) throw new Error('yt-dlp not found')
  const st: Download = { pct: 0, done: false, file: '', error: '' }
  downloads.set(id, st)
  const h = Math.max(144, Math.min(2160, maxHeight | 0))
  const p = spawn(
    YTDLP,
    [
      '--no-update', '--no-warnings', '--newline', '--no-playlist', ...JS,
      '--extractor-args', 'youtube:player_client=visionos,default',
      '-f', `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}]/b`,
      '--merge-output-format', 'mp4',
      '-o', join(HOME, 'Downloads', '%(title).150B [%(id)s].%(ext)s'),
      '--progress-template', 'download:PCT %(progress._percent_str)s',
      '--print', 'after_move:FILE %(filepath)s',
      `https://www.youtube.com/watch?v=${id}`
    ],
    { env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let parts = 0 // video and audio download one after the other: 0–50% then 50–100%
  let last = 0
  let err = ''
  p.stdout.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      const pct = /^PCT\s*([\d.]+)%/.exec(line.trim())
      if (pct) {
        const v = Number(pct[1])
        if (v < last - 50) parts++
        last = v
        st.pct = Math.min(99, Math.round((Math.min(parts, 1) * 100 + v) / 2))
      }
      const f = /^FILE (.+)$/.exec(line.trim())
      if (f) st.file = f[1]
    }
  })
  p.stderr.on('data', (d: Buffer) => (err += d.toString()))
  p.on('error', (e) => (st.error = e.message))
  p.on('close', (code) => {
    if (code === 0) Object.assign(st, { done: true, pct: 100 })
    else st.error ||= (err.trim().split('\n').filter((l) => l.startsWith('ERROR')).pop() ?? `yt-dlp exited ${code}`).replace(/^ERROR:\s*/, '')
  })
  return st
}

/* ---------------- the account's playlists (read with the account cookies) ---------------- */
export type PlaylistItem = { id: string; title: string; count: number | null; thumb: string }
export async function myPlaylists(limit = 60): Promise<PlaylistItem[]> {
  const j = await ytdlp(['--flat-playlist', '--playlist-end', String(limit), 'https://www.youtube.com/feed/playlists'])
  return (j.entries ?? [])
    .filter((e: any) => /list=/.test(e.url ?? '') || e.ie_key === 'YoutubeTab')
    .map((e: any) => {
      const id = /list=([\w-]+)/.exec(e.url ?? '')?.[1] ?? e.id
      const t = (e.thumbnails ?? []).slice(-1)[0]?.url ?? ''
      return { id, title: e.title ?? '', count: e.playlist_count ?? null, thumb: t.startsWith('//') ? 'https:' + t : t }
    })
}
export async function playlistVideos(id: string, limit = 100): Promise<{ title: string; videos: Video[] }> {
  const j = await ytdlp(['--flat-playlist', '--playlist-end', String(limit), `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`])
  return { title: j.title ?? '', videos: (j.entries ?? []).map((e: any) => toItem(e)).filter((x: Item | null): x is Video => x?.kind === 'video') }
}
