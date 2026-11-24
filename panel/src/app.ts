// Tube panel: a small YouTube client. Views render into fixed <section>s; the worker does the
import { LANGS, orcaLang, setLang, startI18n, t } from './i18n/i18n'
import { svg, I, NAV_ICONS } from './icons'
// network work (src/worker.ts) and the player streams through it (player.js).
import { Player } from './player'
import type { Item, State } from './types'
import { CSS_TEMPLATE, SCRIPT_TEMPLATE } from './templates'

// Elements are typed loosely on purpose: the panel reads .value / .checked / .dataset off whatever it queried.
type El = HTMLInputElement
const $ = (s: string, r: ParentNode = document) => r.querySelector(s) as El
const $$ = (s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as El[]
/** An event's target as an element (handlers here only listen on elements). */
const tg = (e: Event) => e.target as El
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- worker bridge ---------------- */
async function call(method: string, input: any = {}, timeoutMs = 60_000): Promise<any> {
  const r = await callRaw(method, input, timeoutMs)
  if (r?.error && method !== 'tube.ping' && NET_DOWN.test(r.error)) void checkOnline()
  return r
}
async function callRaw(method: string, input: any = {}, timeoutMs = 60_000): Promise<any> {
  input = JSON.parse(JSON.stringify(input)) // drop undefined fields: the bridge only takes JSON
  for (let attempt = 0; ; attempt++) {
    try {
      return await orca.plugin.request(method, input, { timeoutMs })
    } catch (e) {
      if (e?.code === 'rate_limited' && attempt < 200) {
        await sleep(Math.max(30, e.retryAfterMs ?? 250))
        continue
      }
      return { error: e?.message || String(e), code: e?.code }
    }
  }
}
// network failures reported by the worker (DNS, refused, reset, timeouts)
const NET_DOWN = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|getaddrinfo|network is unreachable|Unable to download|timed out|fetch failed/i

/* ---------------- storage ---------------- */
const store = {
  async get(key, fallback) {
    try {
      return (await orca.storage.get(key)) ?? fallback
    } catch {
      return fallback
    }
  },
  set(key, value) {
    orca.storage.set(key, value).catch(() => {})
  }
}

/* ---------------- formatting ---------------- */
function count(n) {
  if (n == null) return ''
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)} B`
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)} M`
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)} K`
  return String(n)
}
function clock(s) {
  if (!isFinite(s) || s < 0) s = 0
  s = Math.floor(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
function day(ymd) {
  if (!/^\d{8}$/.test(ymd ?? '')) return ''
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' }).toLowerCase()} ${d.getFullYear()}`
}
const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase())

/* ---------------- images (bytes from the worker, shown as blob: URLs) ---------------- */
// A bounded LRU of object URLs: the base64 the worker sends is decoded once into a Blob, so the
// page holds compact bytes, not a long string per <img>. Avatars also keep their data: form in
// `avatarData` so they can be stored across reloads.
const IMG_MAX = 300
const imgCache = {
  map: new Map(),
  has: (u) => imgCache.map.has(u),
  get(u) {
    const v = imgCache.map.get(u)
    if (v !== undefined) (imgCache.map.delete(u), imgCache.map.set(u, v)) // most recent last
    return v
  },
  set(u, dataUrl) {
    let v = ''
    if (dataUrl) {
      try {
        const [head, b64] = dataUrl.split(',', 2)
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        v = URL.createObjectURL(new Blob([bytes], { type: /data:([^;,]+)/.exec(head)?.[1] ?? 'image/jpeg' }))
      } catch {
        v = dataUrl
      }
    }
    const old = imgCache.map.get(u)
    if (old?.startsWith('blob:')) URL.revokeObjectURL(old)
    imgCache.map.delete(u)
    imgCache.map.set(u, v)
    while (imgCache.map.size > IMG_MAX) {
      const [k, ov] = imgCache.map.entries().next().value
      if (ov?.startsWith('blob:')) URL.revokeObjectURL(ov)
      imgCache.map.delete(k)
    }
  }
}
const avatarData = new Map() // avatar url → data: URL, for storage
const imgWant = new Set<string>()
let imgRunning = false
/* channel avatars the lists don't carry: asked for once, kept across reloads */
const chAvatars = new Map() // channel id → avatar URL ('' = none)
const chWant = new Set()
let chRunning = false
let chSave = 0
function channelAvatar(id, known, name, cls) {
  const url = known || chAvatars.get(id)
  if (url || !id || chAvatars.has(id)) return avatar(url, name, cls)
  return `<span data-ch-av="${esc(id)}" data-cls="${esc(cls)}" data-name="${esc(name ?? '')}" class="${cls} grid shrink-0 place-items-center rounded-full bg-[#333] text-[12px] font-medium">${initial(name)}</span>`
}
async function pumpChannelAvatars() {
  chRunning = true
  while (chWant.size) {
    const ids = [...chWant].slice(0, 16)
    for (const id of ids) chWant.delete(id)
    const r = await call('tube.channelAvatars', { ids })
    for (const [id, url] of Object.entries(r.avatars ?? {})) chAvatars.set(id, url)
    for (const el of $$('[data-ch-av]')) {
      const id = el.dataset.chAv
      if (!chAvatars.has(id)) continue
      const tmp = document.createElement('div')
      tmp.innerHTML = avatar(chAvatars.get(id), el.dataset.name, el.dataset.cls)
      const fresh = tmp.firstElementChild
      el.replaceWith(fresh)
      hydrate(fresh.parentElement)
    }
    clearTimeout(chSave)
    chSave = setTimeout(() => store.set('chAvatars', Object.fromEntries([...chAvatars].slice(-600))), 2000)
  }
  chRunning = false
}
function hydrate(root: ParentNode = document) {
  for (const el of $$('[data-ch-av]', root)) if (!chAvatars.has(el.dataset.chAv)) chWant.add(el.dataset.chAv)
  if (!chRunning && chWant.size) void pumpChannelAvatars()
  for (const el of $$('img[data-img]', root)) {
    const url = el.dataset.img
    if (!url) continue
    if (imgCache.has(url)) {
      if (imgCache.get(url)) el.src = imgCache.get(url)
      el.removeAttribute('data-img')
    } else imgWant.add(url)
  }
  if (!imgRunning && imgWant.size) void pumpImages()
}
// Avatars (yt3/yt4.ggpht) come back on every page and every reload: keep the last ones in storage.
const AVATAR = /^https:\/\/yt\d\.(ggpht|googleusercontent)\.com\//
let avatarSave = 0
function rememberAvatar(url, data) {
  if (!AVATAR.test(url) || !data || data.length > 40_000) return
  avatarData.delete(url)
  avatarData.set(url, data)
  while (avatarData.size > 120) avatarData.delete(avatarData.keys().next().value)
  clearTimeout(avatarSave)
  avatarSave = setTimeout(() => store.set('avatars', Object.fromEntries(avatarData)), 2000)
}
async function pumpImages() {
  imgRunning = true
  // up to three batches in flight: the worker fetches each batch's images in parallel too
  const lane = async () => {
    while (imgWant.size) {
      const batch = [...imgWant].slice(0, 10)
      for (const u of batch) imgWant.delete(u)
      const r = await call('tube.images', { urls: batch })
      const got: Record<string, string> = r.images ?? {}
      for (const url of batch) {
        if (url in got) {
          imgCache.set(url, got[url])
          rememberAvatar(url, got[url])
        } else if (!r.error) imgWant.add(url) // not sent this time (size cap): ask again
      }
      for (const el of $$('img[data-img]')) {
        const d = imgCache.get(el.dataset.img)
        if (d !== undefined) {
          if (d) el.src = d
          el.removeAttribute('data-img')
        }
      }
    }
  }
  await Promise.all([lane(), lane(), lane()])
  imgRunning = false
}
// cached → drawn with its picture right away; otherwise hydrate() fetches it
const img = (url, cls, alt = '') => {
  const have = url ? imgCache.get(url) : undefined
  const src = have ? `src="${have}"` : have === undefined && url ? `data-img="${esc(url)}"` : ''
  return `<img ${src} class="${cls} bg-surface" alt="${esc(alt)}" decoding="async">`
}
const avatar = (url, name, cls) =>
  url ? img(url, `${cls} rounded-full object-cover`) : `<span class="${cls} grid shrink-0 place-items-center rounded-full bg-[#333] text-[12px] font-medium">${initial(name)}</span>`

/* ---------------- state ---------------- */
const S: State = {
  view: 'home',
  stack: [],
  subs: [], // [{id, name, avatar, subs}]
  history: [], // [video]
  saved: [], // [video]
  quality: 720,
  volume: 1,
  muted: false,
  speed: 1,
  cc: '', // preferred caption language ('' = off)
  loop: false,
  autoplay: true,
  audioOpen: false,
  commentsOpen: false,
  lang: 'auto',
  lofi: false,
  lofiThumb: false, // Lofi card shows the thumbnail instead of the video
  shuffle: false,
  theme: { preset: 'default', accent: 'red', custom: {}, css: '', cssOn: false, layout: { zoom: 100, corners: 'round', hide: {} } },
  script: { code: '', auto: false },
  drafts: {}, // unsaved CSS / script text, so re-rendering Settings keeps it
  chatOpen: true,
  boost: 1, // gain after the element volume (1 = 100%)
  semis: 0, // transpose, semitones
  hz: 440, // reference pitch
  chip: 'All',
  explore: { q: '', cat: 'Trend', sort: 'relevance', type: 'video', date: '', length: '' },
  channelsQuery: '',
  channel: null, // {id, tab}
  watch: null, // Watch from the worker
  playing: false,
  account: null, // {name, handle, avatar} when signed in
  login: null, // 'waiting' | 'importing' while signing in
  loginError: '',
  recent: [], // recent searches
  profiles: null, // browser profiles for sign-in (loaded when the sheet opens)
  failedSource: null
}
const isSub = (id) => S.subs.some((c) => c.id === id)
const subsKey = () => (S.account ? 'subsAccount' : 'subs')
async function toggleSub(ch) {
  const on = !isSub(ch.id)
  const before = S.subs
  S.subs = on ? [{ kind: 'channel', id: ch.id, name: ch.name, avatar: ch.avatar, subs: ch.subs ?? null }, ...S.subs] : S.subs.filter((c) => c.id !== ch.id)
  feedCache = null
  if (S.account) {
    const r = await call('yt.subscribe', { id: ch.id, on })
    if (r.error) {
      S.subs = before
      toast(r.error)
      return false
    }
  }
  store.set(subsKey(), S.subs)
  return true
}
const isSaved = (id) => S.saved.some((v) => v.id === id)
function remember(list, video, max = 200) {
  const v = { kind: 'video', id: video.id, title: video.title, channel: video.channel, channelId: video.channelId, duration: video.duration ?? null, views: video.views ?? null, live: !!video.live, thumb: video.thumb }
  return [v, ...list.filter((x) => x.id !== v.id)].slice(0, max)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  const r = await call('tube.copy', { text })
  return !r.error
}
/** A notice in the top right: closes itself after a few seconds (paused while hovered), or with ×. */
function toast(text: string, kind: 'info' | 'success' | 'error' = 'info') {
  const box = $('#toasts')
  const el = document.createElement('div')
  el.className = 'toast pointer-events-auto flex w-full items-start gap-2.5 rounded-[14px] border border-white/10 bg-[#2a2a2a]/95 py-2.5 pl-3.5 pr-2 text-[12.5px] leading-snug shadow-[0_10px_30px_rgba(0,0,0,.45)] backdrop-blur'
  const icon =
    kind === 'success'
      ? '<span class="mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[#22a35a] text-white"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>'
      : kind === 'error'
        ? '<span class="mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-brand text-[12px] font-bold text-white">!</span>'
        : ''
  el.innerHTML = `${icon}<span class="min-w-0 flex-1 break-words pt-[1px]"></span><button class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[#aaa] hover:bg-white/10 hover:text-white" aria-label="Close">${I.close(13)}</button>`
  el.querySelector('span.flex-1')!.textContent = text
  const close = () => {
    el.classList.add('out')
    setTimeout(() => el.remove(), 200)
  }
  ;(el.querySelector('button') as HTMLButtonElement).onclick = (e) => (e.stopPropagation(), close())
  let timer = setTimeout(close, 4500)
  el.onmouseenter = () => clearTimeout(timer)
  el.onmouseleave = () => (timer = setTimeout(close, 2500))
  box.prepend(el)
  while (box.childElementCount > 4) box.lastElementChild!.remove()
}

/* ---------------- shared pieces ---------------- */
const spinner = () => `<div class="grid place-items-center py-16"><div class="spinner"></div></div>`
// A sign-in error (expired session, or yt-dlp asking for login) offers Sign in instead of Retry.
const SIGNED_OUT = /sign in again|Sign in first|Login details are needed|cookies-from-browser/i
const errorBox = (msg, retry) => {
  const out = SIGNED_OUT.test(msg)
  const text = out ? 'YouTube signed you out. Sign in again to see this.' : msg
  const act = out ? 'relogin' : retry
  return `<div class="mx-5 my-10 rounded-2xl bg-panel p-5 text-center text-[12.5px] text-[#ccc]"><p>${esc(text)}</p>${act ? `<button data-act="${act}" class="mt-4 rounded-xl bg-brand px-4 py-2 text-[12px] font-bold text-white">${out ? 'Sign in' : 'Retry'}</button>` : ''}</div>`
}
/* Skeletons: grey blocks shaped like what is loading (the .sk shimmer lives in tailwind.css). */
const SK = {
  big: (n = 3) => Array.from({ length: n }, () => `<div><div class="sk aspect-video w-full rounded-[18px]"></div><div class="mt-3 flex gap-2.5"><div class="sk h-6 w-6 shrink-0 rounded-full"></div><div class="flex-1 space-y-2 pt-0.5"><div class="sk h-3 w-[85%] rounded"></div><div class="sk h-2.5 w-[45%] rounded"></div></div></div></div>`).join(''),
  rows: (n = 6) => Array.from({ length: n }, () => `<div class="flex gap-3.5"><div class="sk aspect-video w-[46%] max-w-[180px] shrink-0 rounded-[14px]"></div><div class="flex-1 space-y-2 pt-1.5"><div class="sk h-3 w-full rounded"></div><div class="sk h-3 w-[70%] rounded"></div><div class="sk h-2.5 w-[40%] rounded"></div></div></div>`).join(''),
  grid: (n = 6) => `<div class="grid grid-cols-2 gap-3">${Array.from({ length: n }, () => `<div><div class="sk aspect-[9/16] w-full rounded-[14px]"></div><div class="sk mt-2 h-3 w-[80%] rounded"></div></div>`).join('')}</div>`,
  people: (n = 6) => Array.from({ length: n }, () => `<div class="flex items-center gap-3"><div class="sk h-11 w-11 shrink-0 rounded-full"></div><div class="flex-1 space-y-2"><div class="sk h-3 w-[55%] rounded"></div><div class="sk h-2.5 w-[35%] rounded"></div></div><div class="sk h-8 w-[88px] rounded-[14px]"></div></div>`).join(''),
  comments: (n = 4) => Array.from({ length: n }, () => `<div class="flex gap-3 py-2.5"><div class="sk h-8 w-8 shrink-0 rounded-full"></div><div class="flex-1 space-y-2 pt-0.5"><div class="sk h-2.5 w-[35%] rounded"></div><div class="sk h-3 w-full rounded"></div><div class="sk h-3 w-[60%] rounded"></div></div></div>`).join(''),
  lines: (n = 5) => `<div class="space-y-2.5">${Array.from({ length: n }, (_, i) => `<div class="sk h-3 rounded" style="width:${[92, 78, 85, 60, 70, 50][i % 6]}%"></div>`).join('')}</div>`,
  chat: (n = 10) => `<div class="space-y-2.5 py-1">${Array.from({ length: n }, (_, i) => `<div class="flex gap-2"><div class="sk h-3 w-16 shrink-0 rounded"></div><div class="sk h-3 rounded" style="width:${[70, 45, 60, 30, 55][i % 5]}%"></div></div>`).join('')}</div>`
}
const empty = (msg) => `<p class="px-6 py-14 text-center text-[12.5px] text-mute">${msg}</p>`
const membersChip = `<span class="members-chip absolute right-2.5 top-2.5 rounded-full bg-black/75 px-2.5 py-0.5 text-[10.5px] font-medium backdrop-blur">Members only</span>`
const badge = (v) =>
  (v.members ? membersChip : '') +
  (v.live
    ? `<span class="absolute left-2.5 top-2.5 rounded-full bg-brand px-3 py-0.5 text-[10.5px]">Live</span>`
    : v.duration
      ? `<span class="absolute bottom-2 left-2.5 rounded-md bg-black/70 px-1.5 py-[1px] text-[10px] tabular-nums">${clock(v.duration)}</span>`
      : '')
const vmeta = (v) => (v.live ? [v.views != null ? t('{n} watching', { n: count(v.views) }) : '', t('live now')] : [v.views != null ? t('{n} views', { n: count(v.views) }) : v.viewsText ?? '']).filter(Boolean).join(' . ')

function bigCard(v) {
  const sub = S.subs.find((c) => c.id === v.channelId)
  return `<button data-watch="${esc(v.id)}" class="block w-full text-left">
    <div class="relative overflow-hidden rounded-[18px]"${v.members ? '' : ' data-pv'}>${img(v.thumb, 'aspect-video w-full rounded-[18px] object-cover')}${badge(v)}</div>
    <div class="mt-3 flex gap-2.5">
      ${channelAvatar(v.channelId, sub?.avatar, v.channel, 'mt-0.5 h-6 w-6 shrink-0 text-[10px]')}
      <div class="min-w-0 flex-1">
        <p class="clamp2 text-[12.5px] font-medium leading-[1.3]">${esc(v.title)}</p>
        <p class="mt-1 text-[10px] text-[#bdbdbd]">${esc([v.channel, vmeta(v)].filter(Boolean).join(' . '))}</p>
      </div>
    </div>
  </button>`
}
function shortCard(v) {
  return `<button data-watch="${esc(v.id)}" class="block min-w-0 text-left">
    <div class="relative">${img(v.thumb, 'aspect-[9/16] w-full rounded-[14px] object-cover')}</div>
    <p class="clamp2 mt-1.5 text-[11.5px] font-medium leading-[1.3]">${esc(v.title)}</p>
    <p class="mt-0.5 truncate text-[10px] text-mute">${esc(v.viewsText || vmeta(v))}</p>
  </button>`
}
const shortGrid = (items) => `<div class="grid grid-cols-2 gap-x-3 gap-y-4">${items.map(shortCard).join('')}</div>`
function rowCard(v) {
  return `<button data-watch="${esc(v.id)}" class="flex w-full items-start gap-3.5 text-left">
    <div class="relative w-[46%] max-w-[180px] shrink-0 overflow-hidden rounded-[14px]"${v.members ? '' : ' data-pv'}>${img(v.thumb, 'aspect-video w-full rounded-[14px] object-cover')}${badge(v)}</div>
    <div class="min-w-0 flex-1 pt-1">
      <p class="clamp3 text-[12px] font-medium leading-[1.3]">${esc(v.title)}</p>
      <p class="mt-1.5 truncate text-[9.5px] text-[#cfcfcf]">${esc([v.channel, vmeta(v)].filter(Boolean).join(' . '))}</p>
    </div>
  </button>`
}
function channelRow(c) {
  const on = isSub(c.id)
  return `<li class="flex items-center gap-3.5">
    <button data-channel="${esc(c.id)}" class="shrink-0">${avatar(c.avatar, c.name, 'h-12 w-12 text-[16px]')}</button>
    <button data-channel="${esc(c.id)}" class="min-w-0 flex-1 text-left">
      <p class="truncate text-[14px]">${esc(c.name)}</p>
      <p class="mt-1 truncate text-[11px] text-[#b5b5b5]">${c.subs != null ? t('{n} subscribers', { n: count(c.subs) }) : esc(c.handle || '')}</p>
    </button>
    <button data-sub="${esc(c.id)}" class="${on ? 'border-[#555]' : 'border-brand bg-brand'} w-[88px] shrink-0 rounded-[14px] border py-2 text-[11.5px]">${on ? 'Subscribed' : 'Subscribe'}</button>
  </li>`
}
const tubeLogo = () => `<button data-nav="home" class="flex items-center gap-1.5" aria-label="Home">
    <span class="grid h-[18px] w-[25px] place-items-center rounded-[5px] bg-brand text-white">${I.tube(16)}</span>
    <span class="logo text-[20px] font-bold tracking-tight">Tube</span></button>`
/** Every page's header: Tube on the left, the page title in the middle, your account on the right. */
const header = (title, { account = true, cls = '', titleCls = '' } = {}) => `<header class="sticky-head ${cls} grid h-[60px] grid-cols-[1fr_auto_1fr] items-center gap-2 px-5">
  <div class="flex min-w-0 items-center">${tubeLogo()}</div>
  <h1 class="${titleCls} max-w-[46vw] truncate text-[15px] font-medium">${title}</h1>
  <div class="flex items-center justify-end">${account ? accountButton('h-9 w-9') : ''}</div>
</header>`

/* ---------------- views ---------------- */
let feedCache = null // {key, items}
let lastChannelResults = [] // channel search hits, so Subscribe can store their name/avatar
const CHIPS = ['All', 'Music', 'Gaming', 'News', 'Live', 'Tech', 'Anime', 'Cooking', 'Podcasts']
const chips = () => (S.account ? ['All', 'Subscriptions', ...CHIPS.slice(1)] : CHIPS)
const accountButton = (size) =>
  `<button data-act="account" class="${size} grid shrink-0 place-items-center overflow-hidden rounded-full bg-surface" aria-label="Account">${
    S.account?.avatar ? img(S.account.avatar, 'h-full w-full object-cover') : I.user(20)
  }</button>`

async function renderHome() {
  const el = $('#v-home')
  const subsRow = S.subs
    .map(
      (c) => `<button data-channel="${esc(c.id)}" class="flex w-[68px] shrink-0 flex-col items-center gap-1.5">
      ${avatar(c.avatar, c.name, 'h-[56px] w-[56px] text-[18px]')}<span class="clamp2 w-full break-words text-center text-[10.5px] leading-[1.25]">${esc(c.name)}</span></button>`
    )
    .join('')
  el.innerHTML = `
  <header class="sticky-head flex h-[60px] items-center justify-between px-5">
    ${tubeLogo()}
    <div class="flex items-center gap-4">
      <button data-act="search" aria-label="Search">${I.search(22)}</button>
      ${accountButton('h-9 w-9')}
    </div>
  </header>
  ${S.subs.length ? `<div class="no-sb fade-x mt-4 flex items-start gap-2.5 overflow-x-auto px-5">${subsRow}</div>` : ''}
  <div id="homeChips" class="no-sb fade-x mt-5 flex items-center gap-1.5 overflow-x-auto px-5 text-[12px] text-[#d6d6d6]">
    ${chips().map((c) => `<button data-chip="${c}" class="${c === S.chip ? 'bg-surface font-medium text-white' : ''} shrink-0 rounded-[9px] px-3.5 py-1.5">${c}</button>`).join('')}
  </div>
  <div id="feed" class="mt-5 space-y-6 px-5">${SK.big()}</div>`
  hydrate(el)

  const chip = S.chip
  const key = S.account && (chip === 'All' || chip === 'Subscriptions') ? 'acct:' + chip : chip === 'All' ? 'all:' + S.subs.map((c) => c.id).join(',') : 'chip:' + chip
  let items = feedCache?.key === key ? feedCache.items : null
  if (!items) {
    let r
    if (S.account && chip === 'All') r = await call('yt.feed', { kind: 'recommended' }, 90_000)
    else if (S.account && chip === 'Subscriptions') r = await call('yt.feed', { kind: 'subscriptions' }, 90_000)
    else if (chip === 'All' && S.subs.length) r = await call('tube.feed', { ids: S.subs.map((c) => c.id) }, 120_000)
    else r = await call('tube.search', { q: chip === 'All' ? 'trending' : chip === 'Live' ? 'live now' : chip, sort: 'relevance' })
    if (S.chip !== chip || S.view !== 'home') return
    if (r.error) return void ($('#feed').innerHTML = errorBox(r.error, 'reload'))
    items = (r.items ?? []).filter((x) => x.kind === 'video')
    feedCache = { key, items }
  }
  const hint =
    chip === 'All' && !S.account && !S.subs.length
      ? `<button data-act="account" class="-mt-1 block text-left text-[11px] text-mute">Sign in to see your recommendations and subscriptions. <span class="text-white underline">Sign in</span></button>`
      : ''
  $('#feed').innerHTML = hint + (items.length ? items.map(bigCard).join('') : empty('Nothing here.'))
  hydrate($('#feed'))
}

const CATS = [
  ['Trend', I.fire(), 'trending'],
  ['Music', I.music(), 'music'],
  ['Gaming', I.game(), 'gaming'],
  ['Learning', I.bulb(), 'tutorial'],
  ['News', I.news(), 'news'],
  ['Sports', I.sport(), 'sports highlights']
]
const SORTS = { relevance: 'Relevance', views: 'Popular', date: 'Newest' }
const DATES = { '': 'Any time', hour: 'Last hour', today: 'Today', week: 'This week', month: 'This month', year: 'This year' }
const LENGTHS = { '': 'Any length', short: 'Under 3 min', medium: '3–20 min', long: 'Over 20 min' }
const TYPES = [['video', 'Videos'], ['channel', 'Channels'], ['short', 'Shorts']]
async function renderExplore(focus?: boolean) {
  const el = $('#v-explore')
  const E = S.explore
  // a dropdown that looks like a pill; the real <select> sits on top, invisible
  const pick = (key, labels, cur) =>
    `<label class="${cur && cur !== 'relevance' ? 'bg-white text-black' : 'bg-surface text-[#ddd]'} relative flex shrink-0 items-center gap-1 rounded-full py-1.5 pl-3 pr-2.5 text-[11.5px]">
      <span>${labels[cur]}</span>${I.down(10)}
      <select data-filter="${key}" class="absolute inset-0 cursor-pointer opacity-0" aria-label="${key}">${Object.entries(labels).map(([v, n]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`
  el.innerHTML = `
  ${header('Explore')}
  <div class="mt-5 px-5">
    <button data-act="search" class="flex w-full items-center gap-3 rounded-[15px] border border-line px-3.5 py-3 text-left text-[#d0d0d0]">${I.search(20)}
      <span class="${E.q ? 'text-white' : 'text-[#9a9a9a]'} truncate text-[12.5px]">${esc(E.q || 'Search YouTube')}</span></button>
    <div class="mt-3 grid grid-cols-3 gap-1 rounded-[13px] bg-surface p-1 text-[12px]" role="tablist">
      ${TYPES.map(([k, n]) => `<button data-type="${k}" role="tab" aria-selected="${E.type === k}" class="${E.type === k ? 'bg-ink font-medium text-white shadow' : 'text-[#aaa] hover:text-white'} rounded-[10px] py-1.5">${n}</button>`).join('')}
    </div>
  </div>
  <nav class="no-sb mt-5 flex gap-5 overflow-x-auto px-5 pb-3 text-[14px] text-[#9a9a9a]">
    ${CATS.map(([n, ic]) => `<button data-cat="${n}" class="${!E.q && E.cat === n ? 'tab-active' : ''} flex shrink-0 items-center gap-1.5">${ic}${n}</button>`).join('')}
  </nav>
  ${
    E.type === 'short'
      ? ''
      : `<div class="no-sb mt-2 flex gap-2 overflow-x-auto px-5">
          ${E.type === 'video' ? pick('sort', SORTS, E.sort) + pick('date', DATES, E.date) + pick('length', LENGTHS, E.length) : pick('sort', { relevance: 'Relevance', views: 'Popular' }, E.sort === 'date' ? 'relevance' : E.sort)}
        </div>`
  }
  <div id="exploreList" class="mt-5 space-y-4 px-5">${E.type === 'short' ? SK.grid() : E.type === 'channel' ? SK.people() : SK.rows()}</div>`

  const q = E.q || CATS.find((c) => c[0] === E.cat)[2]
  const want = JSON.stringify(E)
  const opts = E.type === 'video' ? { sort: E.sort, date: E.date, length: E.length } : E.type === 'channel' ? { sort: E.sort === 'date' ? 'relevance' : E.sort } : {}
  const r = await call('tube.search', { q, type: E.type, ...opts })
  if (JSON.stringify(S.explore) !== want || S.view !== 'explore') return
  const list = $('#exploreList')
  if (r.error) return void (list.innerHTML = errorBox(r.error, 'reload'))
  const items = r.items ?? []
  if (E.type === 'channel') lastChannelResults = items
  list.innerHTML = items.length
    ? E.type === 'channel'
      ? `<ul class="space-y-4">${items.map(channelRow).join('')}</ul>`
      : E.type === 'short'
        ? shortGrid(items)
        : items.map(rowCard).join('')
    : empty('No results.')
  hydrate(list)
}

async function renderChannels(focus?: boolean) {
  const el = $('#v-channels')
  el.innerHTML = `
  ${header('Channels')}
  <form id="channelsForm" class="mx-5 mt-6 flex items-center gap-3 rounded-[15px] border border-line px-4 py-3.5 text-[#d0d0d0]">${I.search(20)}
    <input id="channelsQ" value="${esc(S.channelsQuery)}" class="w-full bg-transparent text-[12.5px] text-white outline-none placeholder:text-[#9a9a9a]" placeholder="Search channel" enterkeyhint="search">
  </form>
  <p class="mt-5 flex items-center gap-2.5 px-5 text-[12px]"><span class="text-[#a5a5a5]">Sort by :</span><span class="text-[13px]">${S.channelsQuery ? 'Search results' : 'Your subscriptions'}</span></p>
  <ul id="channelList" class="mt-4 space-y-4 px-5"></ul>`
  if (focus) $('#channelsQ').focus()
  const list = $('#channelList')
  if (!S.channelsQuery) {
    list.innerHTML = S.subs.length ? S.subs.map(channelRow).join('') : empty('No subscriptions yet. Search for a channel above.')
    return hydrate(list)
  }
  list.innerHTML = SK.people()
  const q = S.channelsQuery
  const r = await call('tube.search', { q, type: 'channel' })
  if (S.channelsQuery !== q || S.view !== 'channels') return
  if (r.error) return void (list.innerHTML = errorBox(r.error, 'reload'))
  lastChannelResults = r.items ?? []
  list.innerHTML = (r.items ?? []).length ? r.items.map(channelRow).join('') : empty('No channels found.')
  hydrate(list)
}

const TABS = [
  ['videos', 'Videos'],
  ['shorts', 'Shorts'],
  ['streams', 'Live'],
  ['about', 'About']
]
let channelData = null
async function renderChannel() {
  const el = $('#v-channel')
  const { id, tab } = S.channel
  const known = S.subs.find((c) => c.id === id)
  const head = (c) => {
    const on = isSub(c.id)
    return `
    ${header(esc(c.name), { cls: 'clear -mb-[60px]', titleCls: 'head-title' })}
    <div class="relative h-[190px]">
      ${c.banner ? img(c.banner, 'absolute inset-0 h-full w-full object-cover') : '<div class="absolute inset-0 bg-gradient-to-br from-surface to-ink"></div>'}
      <div class="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-ink"></div>
      <div class="absolute -bottom-[8px] right-5 rounded-full ring-4 ring-ink">${avatar(c.avatar, c.name, 'h-[68px] w-[68px] text-[24px]')}</div>
      <div class="absolute bottom-0 left-5 flex items-center gap-2.5">
        <button data-sub="${esc(c.id)}" class="${on ? 'bg-surface' : 'bg-brand'} rounded-[14px] px-5 py-2.5 text-[13.5px] font-bold">${on ? 'Subscribed' : 'Subscribe'}</button>
      </div>
    </div>
    <p class="mt-6 px-5 text-[17px] font-medium">${esc(c.name)}</p>
    <div class="mt-1.5 flex items-center gap-4 px-5 text-[12px] text-[#cfcfcf]">
      <button data-tab="${tab === 'about' ? 'videos' : 'about'}" class="flex items-center gap-1.5">Biography <span class="inline-block transition-transform ${tab === 'about' ? 'rotate-180' : ''}">${I.down(9)}</span></button>
      <span class="truncate">${esc([c.handle, c.subs != null ? t('{n} subscribers', { n: count(c.subs) }) : ''].filter(Boolean).join(' . '))}</span>
    </div>
    <nav class="no-sb mt-7 flex gap-5 overflow-x-auto px-5 pb-3 text-[14px] text-[#9a9a9a]">
      ${TABS.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'tab-active' : ''} shrink-0">${n}</button>`).join('')}
    </nav>`
  }
  const base = channelData?.id === id ? channelData : known ? { ...known, banner: '', description: '', handle: '' } : { id, name: '', avatar: '', banner: '', handle: '' }
  el.innerHTML = head(base) + `<div id="channelBody" class="mt-5 px-5">${tab === 'about' ? SK.lines() : tab === 'shorts' ? SK.grid() : `<div class="space-y-5">${SK.rows()}</div>`}</div>`
  hydrate(el)

  const r = await call('tube.channel', { id, tab: tab === 'about' ? 'videos' : tab })
  if (S.view !== 'channel' || S.channel.id !== id || S.channel.tab !== tab) return
  if (r.error) return void ($('#channelBody').innerHTML = errorBox(r.error, 'reload'))
  const c = r.channel
  // Keep the subscription card fresh (name/avatar/count can change).
  if (isSub(c.id)) {
    S.subs = S.subs.map((s) => (s.id === c.id ? { id: c.id, name: c.name, avatar: c.avatar, subs: c.subs } : s))
    store.set('subs', S.subs)
  }
  const first = channelData?.id !== c.id
  channelData = c
  if (first) el.innerHTML = head(c) + `<div id="channelBody" class="mt-5 px-5"></div>`
  const body = $('#channelBody')
  body.innerHTML =
    tab === 'about'
      ? `<p class="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[#d0d0d0]">${esc(c.description || 'No description.')}</p>`
      : `<p class="text-[14px]">${tab === 'shorts' ? 'Shorts' : tab === 'streams' ? 'Live' : 'News'}</p>
         <div class="mt-4 space-y-5">${c.videos.length ? (tab === 'shorts' ? shortGrid(c.videos) : c.videos.map(rowCard).join('')) : empty(tab === 'shorts' ? 'This channel has no Shorts.' : tab === 'streams' ? 'This channel has no live streams.' : 'No videos.')}</div>`
  hydrate(el)
}

/** Shown in Settings ▸ About (keep in step with orca-plugin.json). */
const ABOUT = { version: '1.1.4', author: 'net-runners-com', repo: 'https://github.com/net-runners-com/tube', coffee: 'https://buymeacoffee.com/hiroto.netrunners' }
const LIB_TABS = () =>
  S.account
    ? [['history', 'History'], ['playlists', 'Playlists'], ['watchlater', 'Watch later'], ['liked', 'Liked'], ['saved', 'Saved']]
    : [['history', 'History'], ['playlists', 'Playlists'], ['saved', 'Saved']]
/** History and Library share one renderer: History is its own view, Library holds the rest. */
async function renderLibrary(view = 'library') {
  const el = $('#v-' + view)
  const tabs = view === 'history' ? [['history', 'History']] : LIB_TABS()
  const tab = view === 'history' ? 'history' : tabs.some(([k]) => k === S.libraryTab) ? S.libraryTab : tabs[0][0]
  if (tab === 'playlists') return renderPlaylists(el, tabs)
  const local = tab === 'saved' || (tab === 'history' && !S.account)
  const list = tab === 'saved' ? S.saved : S.history
  el.innerHTML = `
  ${header(view === 'history' ? 'History' : 'Library')}
  ${tabs.length > 1 ? `<nav class="no-sb mt-6 flex gap-6 overflow-x-auto px-5 pb-3 text-[14px] text-[#9a9a9a]">
    ${tabs.map(([k, n]) => `<button data-lib="${k}" class="${tab === k ? 'tab-active' : ''} shrink-0">${n}</button>`).join('')}
  </nav>` : ''}
  ${tab === 'history' && !S.account && S.history.length ? `<div class="mt-2 flex justify-end px-5"><button data-act="clearHistory" class="text-[11px] text-mute">Clear</button></div>` : ''}
  <div id="${view}List" class="mt-5 space-y-4 px-5">${local ? (list.length ? list.map(rowCard).join('') : empty(tab === 'history' ? 'Nothing watched yet.' : 'Nothing saved yet.')) : SK.rows()}</div>`
  hydrate(el)
  if (local) return
  const r = await call('yt.feed', { kind: tab, fresh: true }, 90_000)
  if (S.view !== view || (view === 'library' && S.libraryTab && S.libraryTab !== tab)) return
  const box = $(`#${view}List`)
  if (r.error) return void (box.innerHTML = errorBox(r.error, 'reload'))
  libItems = r.items ?? []
  box.innerHTML = libItems.length ? libItems.map(rowCard).join('') : empty('Nothing here.')
  hydrate(box)
}
let libItems = []

function renderSettings() {
  const el = $('#v-settings')
  const a = S.account
  const card = (title, body) => `<section class="mt-6"><p class="px-1 text-[11px] font-medium uppercase tracking-wide text-mute">${title}</p><div class="mt-2 overflow-hidden rounded-[18px] bg-panel">${body}</div></section>`
  const line = (label, right, attrs = '') =>
    `<${attrs ? 'button' : 'div'} ${attrs} class="flex w-full items-center justify-between gap-3 border-b border-white/5 px-4 py-3.5 text-left text-[13px] last:border-0 ${attrs ? 'hover:bg-white/5' : ''}"><span>${label}</span><span class="min-w-0 truncate text-[12px] text-mute">${right}</span></${attrs ? 'button' : 'div'}>`
  el.innerHTML = `
  ${header('Settings', { account: false })}
  <div class="px-5">
    ${card(
      'Language',
      `<label class="relative flex items-center justify-between px-4 py-3.5 text-[13px]"><span>Language</span>
         <span class="flex items-center gap-1.5 text-[12.5px] text-mute"><span>${esc((LANGS.find(([k]) => k === S.lang) ?? LANGS[0])[1])}</span>${I.down(10)}</span>
         <select data-lang class="absolute inset-0 cursor-pointer opacity-0" aria-label="Language">${LANGS.map(([k, n]) => `<option value="${k}" ${S.lang === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`
    )}
    ${card(
      'Account',
      a
        ? `<div class="flex items-center gap-3.5 px-4 py-4">${avatar(a.avatar, a.name, 'h-12 w-12 text-[18px]')}
             <div class="min-w-0 flex-1"><p class="truncate text-[14px] font-medium">${esc(a.name)}</p><p class="truncate text-[11.5px] text-mute">${esc(a.handle)}</p></div>
             <button data-act="logout" class="shrink-0 rounded-[12px] border border-line px-3 py-1.5 text-[12px] text-[#ff8a8a]">Sign out</button></div>`
        : `<div class="flex items-center justify-between gap-3 px-4 py-4"><p class="text-[12.5px] text-mute">Not signed in</p>
             <button data-act="account" class="rounded-[12px] bg-brand px-4 py-2 text-[12.5px] font-bold">Sign in</button></div>`
    )}
    ${card(
      'Playback',
      `<div class="px-4 py-3.5"><p class="text-[13px]">Maximum quality</p>
         <div class="mt-3 grid grid-cols-4 gap-1 rounded-[12px] bg-black/30 p-1 text-[12px]">
           ${QUALITIES.map((q) => `<button data-quality="${q}" class="${S.quality === q ? 'bg-brand font-bold text-white' : 'text-[#bbb]'} rounded-[9px] py-1.5">${q}p</button>`).join('')}
         </div>
         <p class="mt-2.5 text-[11px] leading-relaxed text-mute">Higher quality streams more data through the worker. Applies to the next video.</p></div>`
    )}
    ${card(
      'Data',
      line('Clear search history', `${S.recent.length} searches`, 'data-act="clearRecent"') +
        line('Clear watch history (this device)', `${S.history.length} videos`, 'data-act="clearHistory"')
    )}
    ${card(
      'Theme',
      `<div class="px-4 py-3.5">
         <p class="text-[13px]">Style</p>
         <div class="mt-2.5 grid grid-cols-3 gap-1.5">${Object.entries(THEMES).map(([k, t]) => `<button data-theme-preset="${k}" class="${S.theme.preset === k && !Object.keys(S.theme.custom).length ? 'ring-2 ring-brand' : 'ring-1 ring-white/10'} flex items-center gap-2 rounded-[11px] px-2.5 py-2 text-left text-[11.5px]" style="background:#${t.panel}"><span class="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-white/20" style="background:#${t.ink}"></span>${t.name}</button>`).join('')}</div>
         <p class="mt-4 text-[13px]">Accent</p>
         <div class="mt-2.5 flex flex-wrap gap-2.5">${Object.entries(ACCENTS).map(([k, [name, hex]]) => `<button data-accent="${k}" title="${name}" aria-label="${name}" class="${S.theme.accent === k && !S.theme.custom.brand ? 'ring-2 ring-white ring-offset-2 ring-offset-panel' : ''} h-7 w-7 rounded-full" style="background:#${hex}"></button>`).join('')}</div>
         <div class="mt-4 flex items-center"><p class="text-[13px]">Custom colors</p><button data-act="resetColors" class="ml-auto rounded-full border border-line px-3 py-1 text-[11.5px] text-[#ccc] hover:bg-white/5">Reset</button></div>
         <div class="mt-2.5 grid grid-cols-3 gap-2">${COLOR_KEYS.map(([k, label]) => `<label class="flex flex-col items-center gap-1 text-[10.5px] text-mute"><input type="color" data-color="${k}" value="#${themeColors()[k]}" class="h-8 w-full cursor-pointer rounded-[9px] border border-white/10 bg-transparent p-0.5">${label}</label>`).join('')}</div>
       </div>`
    )}
    ${card(
      'Layout',
      `<div class="px-4 py-3.5">
         <p class="text-[13px]">Size</p>
         <div class="mt-2.5 grid grid-cols-4 gap-1 rounded-[12px] bg-black/30 p-1 text-[12px]">${[85, 100, 115, 130].map((z) => `<button data-zoom="${z}" class="${S.theme.layout.zoom === z ? 'bg-brand font-bold text-white' : 'text-[#bbb]'} rounded-[9px] py-1.5">${z}%</button>`).join('')}</div>
         <p class="mt-4 text-[13px]">Corners</p>
         <div class="mt-2.5 grid grid-cols-3 gap-1 rounded-[12px] bg-black/30 p-1 text-[12px]">${[['round', 'Round'], ['small', 'Small'], ['square', 'Square']].map(([k, n]) => `<button data-corners="${k}" class="${S.theme.layout.corners === k ? 'bg-brand font-bold text-white' : 'text-[#bbb]'} rounded-[9px] py-1.5">${n}</button>`).join('')}</div>
         <p class="mt-4 text-[13px]">Show</p>
         <div class="mt-1">${LAYOUT_PARTS.map(([k, n]) => `<label class="flex items-center justify-between border-b border-white/5 py-2.5 text-[12.5px] last:border-0">${n}<input type="checkbox" data-act="togglePart" data-part="${k}" ${S.theme.layout.hide[k] ? '' : 'checked'} class="h-4 w-4 accent-[rgb(var(--brand))]"></label>`).join('')}</div>
       </div>`
    )}
    ${card(
      'Custom CSS',
      `<div class="px-4 py-3.5">
         <label class="flex items-center gap-2.5 text-[13px]"><input type="checkbox" data-act="toggleCss" ${S.theme.cssOn ? 'checked' : ''} class="h-4 w-4 accent-[rgb(var(--brand))]">Apply custom CSS</label>
         <textarea id="cssCode" data-draft="css" spellcheck="false" placeholder="/* e.g. */
.clamp2 { -webkit-line-clamp: 3; }
:root { --brand: 61 107 242; }" class="mt-3 h-40 w-full resize-y rounded-[12px] border border-white/10 bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed outline-none focus:border-brand">${esc(S.drafts.css ?? S.theme.css)}</textarea>
         <div class="mt-2 flex flex-wrap gap-2"><button data-act="saveCss" class="rounded-full bg-brand px-5 py-1.5 text-[12px] font-bold">Save</button>
           <button data-act="templateCss" class="flex items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-[12px] text-[#ddd] hover:bg-white/5">${I.download(14)}<span>Download template</span></button></div>
       </div>`
    )}
    ${card(
      'Custom script',
      `<div class="px-4 py-3.5">
         <div class="flex gap-3 rounded-[12px] bg-[#b3261e] px-3.5 py-3 text-[11.5px] leading-relaxed text-white">
           <svg class="mt-0.5 shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5 1.5 21h21zM11 9h2v6h-2zm0 8h2v2h-2z"/></svg>
           <p>For security reasons, only use code you understand or code written by a developer you trust. Scripts run inside the Tube panel with its access (your YouTube session, Orca storage).</p></div>
         <textarea id="scriptCode" data-draft="script" spellcheck="false" placeholder="// runs in the Tube panel, e.g.\ndocument.querySelector('#nav').style.opacity = '.8'" class="mt-3 h-40 w-full resize-y rounded-[12px] border border-white/10 bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed outline-none focus:border-brand">${esc(S.drafts.script ?? S.script.code)}</textarea>
         <div class="mt-2 flex flex-wrap gap-2"><button data-act="saveScript" class="rounded-full bg-brand px-5 py-1.5 text-[12px] font-bold">Save</button><button data-act="runScript" class="rounded-full border border-line px-4 py-1.5 text-[12px] text-[#ddd] hover:bg-white/5">Run now</button><button data-act="templateScript" class="flex items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-[12px] text-[#ddd] hover:bg-white/5">${I.download(14)}<span>Download template</span></button></div>
         <label class="mt-3 flex items-center gap-2.5 text-[12.5px]"><input type="checkbox" data-act="toggleScriptAuto" ${S.script.auto ? 'checked' : ''} class="h-4 w-4 accent-[rgb(var(--brand))]">Run automatically when Tube opens</label>
       </div>`
    )}
    ${card(
      'Support Tube',
      `<div class="px-4 py-4">
         <p class="text-[12.5px] leading-relaxed text-mute">If Tube helps you, a star or a coffee keeps it going.</p>
         <div class="mt-3 grid grid-cols-2 gap-2">
           <button data-open-url="${esc(ABOUT.repo)}" class="flex items-center justify-center gap-2 rounded-[12px] border border-line py-2.5 text-[12.5px] font-medium hover:bg-white/5">${svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>', { size: 16, sw: 1.7 })}<span>Star on GitHub</span></button>
           <button data-open-url="${esc(ABOUT.coffee)}" class="flex items-center justify-center gap-2 rounded-[12px] bg-[#ffdd00] py-2.5 text-[12.5px] font-bold text-black hover:brightness-95">${svg('<path d="M5 8h11v6a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3v2M11 3v2M14 3v2"/>', { size: 16, sw: 1.8 })}<span>Buy me a coffee</span></button>
         </div>
       </div>`
    )}
    ${card('Updates', `<div id="updatesCard">${updatesHtml()}</div>`)}
    ${card(
      'About',
      line('Version', ABOUT.version) +
        line('Author', esc(ABOUT.author)) +
        line('GitHub', esc(ABOUT.repo.replace('https://', '')), `data-open-url="${esc(ABOUT.repo)}"`)
    )}
  </div>`
  hydrate(el)
}

/* ---------------- watch ---------------- */
const video = document.getElementById('video') as HTMLVideoElement
const player = new Player(video, call, {
  onError: (e) => {
    void call('tube.log', { msg: `player error: ${e?.message}` })
    void recover(e)
  },
  onBuffer: (t) => {
    const d = S.watch?.duration || video.duration
    if (d) $('#pBuf').style.width = `${Math.min(100, (t / d) * 100)}%`
  }
})
let loadSeq = 0
const QUALITIES = [360, 480, 720, 1080]

async function openWatch(item, { startAt = 0, fresh = false } = {}) {
  const seq = ++loadSeq
  const sameVideo = S.watch?.id === item.id && !fresh
  if (!sameVideo) {
    player.destroy()
    stopLive()
    chatSeq++
    clearCaptions()
    closeMenu()
    S.loop = false
    video.loop = false
    related = []
    $('#comments').innerHTML = ''
    S.watch = { id: item.id, title: item.title ?? '', channel: item.channel ?? '', channelId: item.channelId ?? '', thumb: item.thumb ?? `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`, duration: item.duration ?? 0, loading: true }
    $('#poster').hidden = false
    $('#poster').removeAttribute('src')
    $('#poster').dataset.img = S.watch.thumb
    renderWatchInfo()
    renderTools()
    hydrate($('#v-watch'))
  }
  go('watch')
  if (sameVideo) return
  $('#spin').hidden = false
  // the channel's other videos do not depend on the stream: start them now, in parallel
  if (item.channelId) void loadMore({ id: item.id, channelId: item.channelId })
  const r = await call('tube.watch', { id: item.id, maxHeight: S.quality, fresh }, 90_000)
  if (seq !== loadSeq) return
  if (r.error) {
    $('#spin').hidden = true
    S.watch.loading = false
    S.watch.error = r.error
    return renderWatchInfo()
  }
  S.watch = r.watch
  mediaSession(S.watch)
  void autoCaption(S.watch)
  S.history = remember(S.history, S.watch)
  store.set('history', S.history)
  renderWatchInfo()
  renderMini()
  if (!item.channelId) void loadMore(S.watch)
  if (S.watch.live) startChat(S.watch)
  else whenVisible($('#comments'), () => loadComments(S.watch))
  if (S.watch.live) {
    if (!S.watch.hls || !window.Hls?.isSupported()) {
      $('#spin').hidden = true
      S.watch.error = 'This live stream cannot be played here.'
      return renderWatchInfo()
    }
    return playLive(S.watch, seq)
  }
  if (!S.watch.video || !S.watch.audio) {
    $('#spin').hidden = true
    S.watch.error = 'No playable stream for this video.'
    return renderWatchInfo()
  }
  try {
    await player.load(S.watch, startAt)
    if (seq !== loadSeq) return
    await video.play().catch(() => {})
  } catch (e) {
    // A dead URL on the very first slice: resolve the video again once, like a mid-play failure.
    if (seq === loadSeq && /403|expired/.test(e.message)) return void recover(e)
    if (seq === loadSeq) {
      S.watch.error = e.message
      renderWatchInfo()
    }
  } finally {
    if (seq === loadSeq) $('#spin').hidden = true
  }
}

let recovering = false
let lastRefresh = { id: '', at: 0 }
/** A dead stream URL (expired, or 403 from googlevideo) is fixed by asking yt-dlp again, once. */
async function recover(e) {
  const w = S.watch
  if (recovering || !w) return
  const msg = e?.message || 'Playback error'
  const again = lastRefresh.id === w.id && Date.now() - lastRefresh.at < 60_000
  if (!/expired|403|stream 4\d\d/.test(msg) || again) {
    w.error = msg
    return renderWatchInfo()
  }
  recovering = true
  lastRefresh = { id: w.id, at: Date.now() }
  const at = video.currentTime
  try {
    toast('Refreshing stream…')
    S.watch = null
    await openWatch(w, { startAt: at, fresh: true })
  } finally {
    recovering = false
  }
}

// Downloads run in the worker (yt-dlp → ~/Downloads); the button shows progress, then opens Finder.
const dls = new Map() // video id → { pct, done, file, error }
function dlButton(w) {
  const d = dls.get(w.id)
  const label = !d ? 'Download' : d.error ? 'Retry' : d.done ? 'Show file' : `${d.pct}%`
  const icon = d?.done ? I.done() : I.download()
  return `<button data-act="download" id="dlBtn" class="flex min-w-0 flex-col items-center gap-1.5 ${d?.done ? 'text-[#2fbf71]' : ''}"><span class="${d?.done ? '' : 'text-white'}">${icon}</span><span class="tabular-nums">${label}</span></button>`
}
function syncDl(id) {
  const b = $('#dlBtn')
  if (b && S.watch?.id === id) b.outerHTML = dlButton(S.watch)
}
async function download(w) {
  const d = dls.get(w.id)
  if (d?.done && d.file) return void call('tube.reveal', { file: d.file })
  if (d && !d.done && !d.error) return
  const r = await call('tube.download', { id: w.id, maxHeight: S.quality })
  if (r.error) return toast(`Download: ${r.error}`)
  dls.set(w.id, r.download)
  toast('Downloading to ~/Downloads')
  syncDl(w.id)
  const poll = async () => {
    const s2 = (await call('tube.downloadState', { id: w.id })).download
    if (!s2) return
    dls.set(w.id, s2)
    syncDl(w.id)
    if (s2.error) return toast(`Download failed: ${s2.error}`, 'error')
    if (s2.done) return toast(`Saved: ${s2.file.split(/[\\/]/).pop()}`, 'success')
    setTimeout(poll, 1000)
  }
  setTimeout(poll, 800)
}

function renderWatchInfo() {
  const w = S.watch
  const box = $('#watchInfo')
  if (!w) return void (box.innerHTML = '')
  const on = isSub(w.channelId)
  const sv = isSaved(w.id)
  const act = (attr, icon, label) => `<button ${attr} class="flex min-w-0 flex-col items-center gap-1.5"><span class="text-white">${icon}</span><span>${label}</span></button>`
  box.innerHTML = `
    <div class="flex items-start gap-3">
      <button data-channel="${esc(w.channelId)}" class="mt-0.5 shrink-0">${avatar(w.avatar, w.channel, 'h-9 w-9 text-[14px]')}</button>
      <div class="min-w-0 flex-1">
        <p class="clamp2 text-[14px] font-medium leading-[1.3]">${esc(w.title)}</p>
        <p class="mt-1 flex items-center gap-1.5 truncate text-[11.5px] text-[#bdbdbd]">${w.channel ? I.check() : ''}<span class="truncate">${esc([w.channel, w.subs != null ? t('{n} subscribers', { n: count(w.subs) }) : '', w.live ? (w.views != null ? t('{n} watching', { n: count(w.views) }) : t('Live now')) : w.views != null ? t('{n} views', { n: count(w.views) }) : ''].filter(Boolean).join(' .  '))}</span></p>
      </div>
      <button data-act="desc" class="mt-1 text-[#ccc] transition-transform" aria-label="Description">${I.down(14)}</button>
    </div>
    ${w.error ? `<p class="mt-4 rounded-xl bg-[#2a1515] px-3 py-2 text-[12px] text-[#ffb4b4]">${esc(w.error)}</p>` : ''}
    <div id="desc" data-no-i18n class="mt-3 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[#c8c8c8]" hidden>${esc([w.views != null ? `${count(w.views)} views` : '', day(w.uploaded)].filter(Boolean).join(' . '))}\n\n${esc(w.description ?? '')}</div>
    <div id="watchActions" class="no-sb mt-5 flex items-center justify-between gap-3 overflow-x-auto text-center text-[11px] text-[#cfcfcf] [&>*]:shrink-0">
      <div class="flex shrink-0 items-center rounded-[18px] bg-surface text-[12px] font-medium text-white">
        <button data-act="like" class="flex flex-col items-center gap-1 rounded-l-[18px] py-2 pl-3.5 pr-3 hover:bg-white/10" aria-label="Like">${w.liked ? I.liked(18) : I.like(18)}<span class="text-[10.5px] font-normal tabular-nums text-[#cfcfcf]">${w.likes != null ? count(w.likes + (w.liked ? 1 : 0)) : 'Like'}</span></button>
        <span class="h-8 w-px bg-white/15"></span>
        <button data-act="dislike" class="flex flex-col items-center gap-1 rounded-r-[18px] py-2 pl-3 pr-3.5 hover:bg-white/10" aria-label="Dislike"><span class="inline-block -scale-y-100">${w.disliked ? I.liked(18) : I.like(18)}</span><span class="text-[10.5px] font-normal text-[#cfcfcf]">Dislike</span></button>
      </div>
      ${act('data-act="copyLink"', I.link(), 'Copy link')}
      ${act('data-act="save"', sv ? I.saved() : I.save(), sv ? 'Saved' : 'Save')}
      ${act('data-act="playlist"', I.listPlus(), 'Playlist')}
      ${dlButton(w)}
      ${w.channelId ? `<button data-sub="${esc(w.channelId)}" class="${on ? 'bg-surface' : 'bg-brand'} shrink-0 whitespace-nowrap rounded-[14px] px-4 py-2.5 text-[12.5px] font-bold">${on ? 'Subscribed' : 'Subscribe'}</button>` : ''}
    </div>`
  $('#qualityBtn').innerHTML = `${w.height ? `<span>${w.height}p</span>` : ''}${I.gear()}`
  hydrate(box)
  renderLofi()
}

async function loadMore(w) {
  const box = $('#watchMore')
  if (!w.channelId) return void (box.innerHTML = '')
  box.innerHTML = `<p class="mt-6 text-[11px] font-medium">Mybe you like that</p><div class="mt-4 space-y-4">${SK.rows(4)}</div>`
  const r = await call('tube.channel', { id: w.channelId, tab: 'videos' })
  if (S.watch?.id !== w.id) return
  if (r.channel && S.watch && !S.watch.avatar) {
    S.watch.avatar = r.channel.avatar
    S.watch.subs ??= r.channel.subs
    renderWatchInfo()
  }
  const items = (r.channel?.videos ?? []).filter((v) => v.id !== w.id).slice(0, 12)
  related = items
  if (upNextOpen) renderUpNext()
  box.innerHTML = items.length ? `<p class="mt-6 text-[11px] font-medium">Mybe you like that</p><div class="mt-4 space-y-4">${items.map(rowCard).join('')}</div>` : ''
  hydrate(box)
}

// In the watch view the mini player appears once the video scrolls out of sight.
let stageAway = false
new IntersectionObserver(([e]) => {
  const away = e.intersectionRatio < 0.25
  if (away === stageAway) return
  stageAway = away
  renderMini()
}, { threshold: 0.25 }).observe(document.getElementById('stage'))

function renderMini() {
  const w = S.watch
  const mini = $('#mini')
  const show = !!w && (S.view !== 'watch' || (stageAway && !S.lofi))
  placeVideo(false) // first, so replacing the mini's HTML never leaves the <video> detached
  mini.hidden = !show
  $('#nav').classList.toggle('rounded-t-[26px]', !show)
  $('#nav').classList.toggle('pt-1', show)
  $('#app').style.paddingBottom = show ? '188px' : '96px'
  if (!show) return
  const playable = !!(w.video || w.hls)
  mini.innerHTML = `<div class="flex items-center gap-3">
    <div data-act="openWatch" id="miniVideo" class="relative h-[60px] w-[106px] shrink-0 cursor-pointer overflow-hidden rounded-[12px] bg-black">${playable ? '' : img(w.thumb, 'absolute inset-0 h-full w-full object-cover')}</div>
    <button data-act="openWatch" class="min-w-0 flex-1 text-left">
      <p class="clamp2 text-[12px] font-medium leading-[1.25]">${esc(w.title)}</p>
      <p class="mt-1 flex items-center gap-1.5 truncate text-[11px] text-[#cfcfcf]">${I.check()}<span class="truncate">${esc(w.channel)}</span></p>
    </button>
    <div class="group/mv flex shrink-0 items-center">
      <input type="range" min="0" max="1" step="0.05" data-vol aria-label="Volume" class="vol-slider w-0 opacity-0 transition-all duration-200 group-hover/mv:w-[56px] group-hover/mv:opacity-100 focus:w-[56px] focus:opacity-100">
      <button data-act="mute" data-vol-icon class="grid h-7 w-7 place-items-center text-[#ddd]" aria-label="Mute"></button>
    </div>
    <button data-act="pip" class="w-6 text-[#ddd]" aria-label="Picture in picture">${I.pip(17)}</button>
    <button data-act="toggle" class="w-6" aria-label="Play">${S.playing ? I.pause(18) : I.play(18)}</button>
    <button data-act="closeMini" aria-label="Close">${I.close()}</button>
  </div>
  ${w.live ? '' : `<input type="range" id="miniSeek" min="0" max="1000" value="0" class="mini-seek mt-2.5 block" aria-label="Seek">`}`
  hydrate(mini)
  syncVolume()
  syncMiniSeek()
  placeVideo(true)
}
/** The one <video> moves between the player and the mini player (the PiP window owns it while open). */
function placeVideo(toMini) {
  if (pipWin) return
  const playable = S.watch && (S.watch.video || S.watch.hls)
  const slot = (toMini && playable && $('#miniVideo')) || (S.lofi && S.view === 'watch' && $('#lofiVideo')) || $('#stage')
  if (!slot) return
  video.classList.toggle('object-cover', slot.id !== 'stage')
  if (video.parentElement !== slot) slot.prepend(video)
  const ctl = [$('#shade'), $('#controls'), $('#pmenu')]
  if (slot.id === 'lofiVideo') {
    if (ctl[1].parentElement !== slot) slot.append(...ctl)
  } else if (ctl[1].parentElement !== $('#stage')) $('#pipNote').before(...ctl)
}
let miniSeeking = false
function syncMiniSeek() {
  const el = $('#miniSeek')
  if (!el || miniSeeking) return
  const d = S.watch?.duration || video.duration || 0
  const v = d ? (video.currentTime / d) * 1000 : 0
  el.value = String(v)
  el.style.background = `linear-gradient(to right, rgb(var(--brand)) ${v / 10}%, rgb(var(--line)) ${v / 10}%)`
}
video.addEventListener('timeupdate', syncMiniSeek)
document.addEventListener('input', (e) => {
  if (tg(e).id === 'miniSeek') {
    miniSeeking = true
    const d = S.watch?.duration || video.duration || 0
    const v = +tg(e).value
    tg(e).style.background = `linear-gradient(to right, rgb(var(--brand)) ${v / 10}%, rgb(var(--line)) ${v / 10}%)`
    if (d) video.currentTime = Math.min(d - 0.5, (v / 1000) * d)
  }
  if (tg(e).matches?.('[data-vol]')) {
    video.volume = +tg(e).value
    video.muted = +tg(e).value === 0
  }
})
document.addEventListener('change', (e) => {
  if (tg(e).id === 'miniSeek') miniSeeking = false
})

function syncPlayButtons() {
  S.playing = !video.paused && !video.ended
  $('#bigPlay').innerHTML = S.playing ? I.pause(30) : I.play(30)
  const m = $('#mini [data-act="toggle"]')
  if (m) m.innerHTML = S.playing ? I.pause(18) : I.play(18)
  const lp = $('#lofiPlay')
  if (lp) lp.innerHTML = S.playing ? I.pause(30) : I.play(30)
  for (const e of $$('#lofiUpNext .eq')) e.parentElement.classList.toggle('paused', !S.playing)
  $('#stage').classList.toggle('playing', S.playing)
  if (pipWin) pipWin.document.querySelector('[data-pip="toggle"]').innerHTML = S.playing ? I.pause(26) : I.play(26)
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused'
}
video.addEventListener('play', syncPlayButtons)
video.addEventListener('pause', syncPlayButtons)
video.addEventListener('ended', syncPlayButtons)
video.addEventListener('playing', () => {
  $('#poster').hidden = true
  $('#spin').hidden = true
})
video.addEventListener('waiting', () => ($('#spin').hidden = false))
const log = (msg) => void call('tube.log', { msg })
video.addEventListener('playing', () => log(`playing ${S.watch?.id} at ${video.currentTime.toFixed(1)}s`))
video.addEventListener('seeked', () => log(`seeked to ${video.currentTime.toFixed(1)}s`))
video.addEventListener('error', () => log(`video error ${video.error?.code} ${video.error?.message}`))
video.addEventListener('timeupdate', () => {
  if (S.watch?.live && !scrubbing) {
    const edge = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.currentTime
    const behind = edge - video.currentTime
    $('#tCur').innerHTML = `<span class="mr-1 inline-block h-1.5 w-1.5 rounded-full ${behind < 20 ? 'bg-brand' : 'bg-white/50'} align-middle"></span>LIVE`
    $('#tDur').textContent = behind >= 20 ? `-${clock(behind)}` : ''
    const [a, b] = liveRange()
    const pct = b > a ? `${Math.min(100, ((video.currentTime - a) / (b - a)) * 100)}%` : '100%'
    $('#pCur').style.width = pct
    placeKnob(pct)
    return
  }
  if (scrubbing) return
  const d = S.watch?.duration || video.duration || 0
  $('#tCur').textContent = clock(video.currentTime)
  $('#tDur').textContent = clock(d)
  const pct = d ? `${(video.currentTime / d) * 100}%` : '0'
  $('#pCur').style.width = pct
  placeKnob(pct)
  if (heatFor !== S.watch?.id) drawHeat()
})
// keep the knob whole at either end of the bar
const placeKnob = (pct) => ($('#pKnob').style.left = `clamp(7px, ${pct}, calc(100% - 7px))`)
/** A live stream's seekable window: what can be rewound to, and the live edge. */
function liveRange(): [number, number] {
  const s = video.seekable
  return s.length ? [s.start(0), s.end(s.length - 1)] : [video.currentTime, video.currentTime]
}
/* Most replayed: YouTube's per-slice watch counts as a soft curve over the seek bar. */
let heatFor = ''
function drawHeat() {
  heatFor = S.watch?.id ?? ''
  const v = S.watch?.heat ?? []
  const path = $('#heat path')
  if (v.length < 2) return path.setAttribute('d', '')
  const x = (i) => (i / (v.length - 1)) * 1000
  const y = (i) => 100 - v[i] * 92
  let d = `M0 100 L0 ${y(0)}`
  for (let i = 1; i < v.length; i++) {
    const cx = (x(i - 1) + x(i)) / 2
    d += ` C${cx} ${y(i - 1)} ${cx} ${y(i)} ${x(i)} ${y(i)}`
  }
  path.setAttribute('d', d + ' L1000 100 Z')
}

/* ---------------- live (HLS through the worker) ---------------- */
// hls.js does the playlists and TS→MP4; every request goes through this loader to the worker,
// because the panel frame cannot reach googlevideo itself.
let hls = null
let liveKey = null
const LIVE_MASTER = 'https://manifest.googlevideo.com/tube-live-master' // stands for the worker's master URL
const liveRetries = new Map() // video id → re-resolves after fatal errors
const newStats = () => ({ aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } })
async function liveFetch(url, binary, key = liveKey) {
  if (!binary) {
    const r = await call('tube.hls', url === LIVE_MASTER ? { key } : { key, url }, 30_000)
    if (r.error) throw new Error(r.error)
    return r.text
  }
  const parts = []
  let got = 0
  let total = Infinity
  while (got < total) {
    const r = await call('tube.hls', { key, url, start: got }, 30_000)
    if (r.error) throw new Error(r.error)
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0))
    if (!bytes.length) break
    parts.push(bytes)
    got += bytes.length
    total = r.total
  }
  const out = new Uint8Array(got)
  let at = 0
  for (const p of parts) (out.set(p, at), (at += p.length))
  return out.buffer
}
class WorkerLoader {
  stats: ReturnType<typeof newStats>
  context: any
  aborted: boolean
  key: string | null
  // hls.js hands its config to each loader: a preview's player carries its own stream key
  constructor(config?: { tubeKey?: string }) {
    this.key = config?.tubeKey ?? null
    this.stats = newStats()
    this.context = null
    this.aborted = false
  }
  destroy() {
    this.aborted = true
  }
  abort() {
    this.aborted = true
    this.stats.aborted = true
  }
  getCacheAge() {
    return null
  }
  getResponseHeader() {
    return null
  }
  load(context, config, callbacks) {
    this.context = context
    const st = (this.stats = newStats())
    st.loading.start = performance.now()
    liveFetch(context.url, context.responseType === 'arraybuffer', this.key ?? liveKey).then(
      (data) => {
        if (this.aborted) return
        st.loading.first = st.loading.end = performance.now()
        st.loaded = st.total = typeof data === 'string' ? data.length : data.byteLength
        callbacks.onSuccess({ url: context.url, data, code: 200 }, st, context, null)
      },
      (e) => {
        if (this.aborted) return
        st.loading.end = performance.now()
        callbacks.onError({ code: /expired/.test(e.message) ? 410 : 0, text: e.message }, context, null, st)
      }
    )
  }
}
function stopLive() {
  if (!hls) return
  hls.destroy()
  hls = null
  liveKey = null
}
function playLive(w, seq) {
  stopLive()
  liveKey = w.hls
  const h = (hls = new Hls({ loader: WorkerLoader, enableWorker: false, liveSyncDurationCount: 3, maxBufferLength: 30, backBufferLength: 60 }))
  h.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
    // cap to the chosen quality; ABR picks below it
    const ok = data.levels.map((l, i) => [l.height, i]).filter(([ht]) => ht && ht <= S.quality)
    if (ok.length) {
      const top = ok.sort((a, b) => a[0] - b[0]).pop()[1]
      h.autoLevelCapping = top
      h.nextLevel = top // start at the chosen quality; ABR steps down if the worker cannot keep up
    }
    void video.play().catch(() => {})
  })
  h.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
    const lv = h.levels[d.level]
    if (lv?.height && S.watch === w) {
      w.height = lv.height
      $('#qualityBtn').innerHTML = `<span>${lv.height}p</span>${I.gear()}`
    }
  })
  let recovered = 0
  h.on(Hls.Events.ERROR, (_, d) => {
    if (!d.fatal) return
    log(`hls fatal ${d.type} ${d.details} ${d.error?.message ?? ''}`)
    if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recovered++ < 2) return h.recoverMediaError()
    if (seq !== loadSeq) return
    stopLive()
    $('#spin').hidden = true
    // the playlist URL expired (or YouTube refused it): resolve the stream again, a few times
    const n = liveRetries.get(w.id) ?? 0
    if (n < 2) return void (liveRetries.set(w.id, n + 1), openWatch(w, { fresh: true }))
    S.watch.error = `Live playback stopped (${d.details})`
    renderWatchInfo()
  })
  h.attachMedia(video)
  h.loadSource(LIVE_MASTER)
}

/* ---------------- volume, speed, quality, captions ---------------- */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
function syncVolume() {
  const v = video.muted ? 0 : video.volume
  $('#volBtn').innerHTML = v === 0 ? I.muted() : v < 0.5 ? I.volLow() : I.vol()
  $('#volSlider').value = String(v)
  $('#volSlider').style.background = `linear-gradient(to right, #fff ${v * 100}%, rgba(255,255,255,.35) ${v * 100}%)`
  for (const el of $$('#mini [data-vol]')) {
    el.value = String(v)
    el.style.background = `linear-gradient(to right, #fff ${v * 100}%, rgba(255,255,255,.35) ${v * 100}%)`
  }
  for (const el of $$('#mini [data-vol-icon]')) el.innerHTML = v === 0 ? I.muted(17) : v < 0.5 ? I.volLow(17) : I.vol(17)
}
video.addEventListener('volumechange', () => {
  syncVolume()
  S.volume = video.volume
  S.muted = video.muted
  store.set('volume', { v: S.volume, muted: S.muted })
})
$('#volSlider').addEventListener('input', (e) => {
  const v = +tg(e).value
  video.volume = v
  video.muted = v === 0
})
// the slider sits inside the controls; keep drags from reaching the stage's tap handling
$('#volSlider').addEventListener('pointerdown', (e) => e.stopPropagation())

function setSpeed(v, { quiet = false } = {}) {
  S.speed = v
  video.defaultPlaybackRate = v
  video.playbackRate = v
  store.set('speed', v)
  syncKnob('speed')
  if (!quiet) toast(v === 1 ? 'Speed: normal' : `Speed: ${v}x`)
}
video.addEventListener('loadedmetadata', () => {
  if (video.playbackRate !== S.speed) video.playbackRate = S.speed
})

function setQuality(q) {
  if (q === S.quality && S.watch?.height) return
  S.quality = q
  store.set('quality', S.quality)
  toast(`Quality: up to ${S.quality}p`)
  if (S.watch?.id) {
    const at = video.currentTime
    const w = S.watch
    S.watch = null
    void openWatch(w, { startAt: at })
  }
}

let menuOpen = null
function openMenu(kind) {
  menuOpen = kind
  const m = $('#pmenu')
  const row = (attr, label, on, sub = '') =>
    `<button ${attr} class="flex w-full items-center gap-2 px-3 py-[7px] text-left hover:bg-white/10"><span class="w-3.5 shrink-0 text-brand">${on ? I.tick() : ''}</span><span class="flex-1 truncate">${label}</span>${sub ? `<span class="text-[10.5px] text-mute">${sub}</span>` : ''}</button>`
  const head = (t) => `<p class="px-3 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wider text-mute">${t}</p>`
  if (kind === 'settings') {
    const now = S.watch?.height
    m.innerHTML =
      head('Quality') +
      QUALITIES.map((q) => row(`data-mq="${q}"`, `${q}p`, q === S.quality, now && q === S.quality && now !== q ? `now ${now}p` : '')).join('') +
      `<div class="my-1 h-px bg-white/10"></div>` +
      head('Speed') +
      SPEEDS.map((v) => row(`data-speed="${v}"`, v === 1 ? 'Normal' : `${v}x`, v === S.speed)).join('')
  } else {
    const cur = activeCaption?.key ?? ''
    m.innerHTML = head('Captions') + row('data-cc-key=""', 'Off', !cur) + (S.watch?.captions ?? []).map((c) => row(`data-cc-key="${esc(c.key)}"`, esc(c.name), c.key === cur)).join('')
  }
  m.hidden = false
  $('#stage').classList.add('menu')
}
function closeMenu() {
  menuOpen = null
  $('#pmenu').hidden = true
  $('#stage').classList.remove('menu')
}
document.addEventListener('click', (e) => {
  if (menuOpen && !tg(e).closest('#pmenu, [data-act="cc"], [data-act="settings"]')) closeMenu()
}, true)

// Captions: the worker turns YouTube's json3 into cues; they go in as a <track> (a blob: WebVTT),
// so the browser draws them, in the panel and in picture-in-picture alike.
let activeCaption = null
let captionSeq = 0
function syncCc() {
  $('#ccBtn').innerHTML = I.cc(18, !!activeCaption)
  $('#ccBtn').classList.toggle('opacity-40', !S.watch?.captions?.length)
}
function clearCaptions() {
  captionSeq++
  activeCaption = null
  for (const t of video.querySelectorAll('track')) {
    URL.revokeObjectURL(t.src)
    t.remove()
  }
  syncCc()
}
const vttTime = (s) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 23)
const vttText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
async function pickCaption(key, { remember = true } = {}) {
  const c = S.watch?.captions?.find((x) => x.key === key)
  clearCaptions()
  if (remember) {
    S.cc = c ? c.lang : ''
    store.set('cc', S.cc)
  }
  if (!c) return
  const seq = captionSeq
  const r = await call('tube.captions', { key: c.key }, 30_000)
  if (seq !== captionSeq) return
  if (r.error || !r.cues?.length) {
    const busy = /429/.test(r.error ?? '')
    const orig = S.watch?.captions?.find((x) => x.orig && x.key !== c.key)
    if (busy && c.auto && !c.orig && orig) {
      toast(`${c.name} is not available; showing ${orig.name}`)
      return pickCaption(orig.key, { remember: false })
    }
    return toast(!r.error ? 'These captions are empty' : busy ? 'YouTube is limiting caption requests. Try again in a minute.' : `Captions: ${r.error}`)
  }
  const vtt = 'WEBVTT\n\n' + r.cues.map(([a, b, t]) => `${vttTime(a)} --> ${vttTime(b)}\n${vttText(t)}`).join('\n\n')
  const el = document.createElement('track')
  el.kind = 'subtitles'
  el.srclang = c.lang
  el.label = c.name
  el.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
  video.append(el)
  el.track.mode = 'showing'
  activeCaption = c
  syncCc()
}
async function autoCaption(w) {
  syncCc()
  if (!S.cc || !w.captions?.length) return
  const c = w.captions.find((x) => x.lang === S.cc && !x.auto) ?? w.captions.find((x) => x.lang === S.cc)
  if (c) await pickCaption(c.key, { remember: false })
}

/* ---------------- tools under the video: loop, autoplay, A-B, audio ---------------- */
let related = [] // "more videos" for autoplay
const autoplayed = new Set()
const KNOBS = {
  volume: { label: 'Volume', min: 0, max: 3, step: 0.05, def: 1, get: () => S.boost, set: (v) => (S.boost = v), text: (v) => `${Math.round(v * 100)}%` },
  transpose: { label: 'Transpose', min: -12, max: 12, step: 1, def: 0, get: () => S.semis, set: (v) => (S.semis = v), text: (v) => (v > 0 ? `+${v}` : String(v)) },
  pitch: { label: 'Pitch', min: 415, max: 466, step: 1, def: 440, get: () => S.hz, set: (v) => (S.hz = v), text: (v) => `${v} Hz` },
  speed: { label: 'Speed', min: 0.25, max: 2, step: 0.05, def: 1, get: () => S.speed, set: (v) => setSpeed(v, { quiet: true }), text: (v) => `${Math.round(v * 100)}%` }
}
const audioChanged = () => S.boost !== 1 || S.semis !== 0 || S.hz !== 440 || S.speed !== 1

function renderTools() {
  const box = $('#tools')
  if (!S.watch) return void ((box.innerHTML = ''), ($('#audioCards').innerHTML = ''))
  const chip = (act, icon, label, on, extra = '') =>
    `<button data-act="${act}" class="${on ? 'bg-white text-black' : 'bg-surface text-[#ddd] hover:bg-white/10'} flex shrink-0 items-center gap-1.5 rounded-full px-3 py-[7px] text-[11.5px] font-medium">${icon}<span>${label}</span>${extra}</button>`
  const card = (key) => {
    const k = KNOBS[key]
    const v = k.get()
    return `<div class="rounded-2xl bg-surface px-3.5 pb-2 pt-2.5">
      <div class="flex items-center text-[12px]"><span class="font-medium">${k.label}</span>
        <span data-val="${key}" class="ml-auto mr-2.5 tabular-nums text-[#ddd]">${k.text(v)}</span>
        <button data-reset="${key}" class="text-mute hover:text-white" aria-label="Reset ${k.label}">${I.reset(14)}</button></div>
      <div class="mt-1 flex items-center gap-1.5">
        <button data-step="${key}" data-dir="-1" class="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-white/10" aria-label="Less">${I.minus()}</button>
        <input type="range" data-knob="${key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${v}" class="knob min-w-0 flex-1" aria-label="${k.label}">
        <button data-step="${key}" data-dir="1" class="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-white/10" aria-label="More">${I.plus(14)}</button>
      </div></div>`
  }
  box.innerHTML = `
    <div class="no-sb flex gap-2 overflow-x-auto">
      ${chip('lofi', I.lofi(), 'Lofi', S.lofi)}
      ${chip('loop', I.repeat(), 'Loop', S.loop)}
      ${chip('autoplay', I.autoplay(), 'Autoplay', S.autoplay)}
      ${chip('audio', I.sliders(), 'Audio', S.audioOpen, `${audioChanged() && !S.audioOpen ? '<span class="h-1.5 w-1.5 rounded-full bg-brand"></span>' : ''}${I.down(11)}`)}
    </div>
`
  $('#audioCards').innerHTML = S.audioOpen ? `<div class="mt-3 grid gap-2">${['volume', 'transpose', 'pitch', 'speed'].map(card).join('')}</div>` : ''
  for (const key of Object.keys(KNOBS)) syncKnob(key)
}
function syncKnob(key) {
  const k = KNOBS[key]
  const el = $(`#audioCards [data-knob="${key}"]`)
  if (!el) return
  const v = k.get()
  el.value = String(v)
  const pct = ((v - k.min) / (k.max - k.min)) * 100
  el.style.background = `linear-gradient(to right, rgb(var(--brand)) ${pct}%, rgb(var(--line)) ${pct}%)`
  $(`#audioCards [data-val="${key}"]`).textContent = k.text(v)
}
function setKnob(key, v) {
  KNOBS[key].set(v)
  syncKnob(key)
  if (key !== 'speed') {
    store.set('audio', { boost: S.boost, semis: S.semis, hz: S.hz })
    void applyAudio()
  }
}
document.addEventListener('input', (e) => {
  const key = tg(e).dataset?.knob
  if (key) setKnob(key, +tg(e).value)
})

// Web Audio is wired in only once something needs it (a boost or a pitch change): after
// createMediaElementSource the element can never play straight to the speakers again.
let graph = null
let graphing = null
async function applyAudio() {
  const ratio = 2 ** (S.semis / 12) * (S.hz / 440)
  if (!graph && S.boost === 1 && ratio === 1) return
  graph ??= await (graphing ??= buildGraph())
  if (!graph) return
  graph.gain.gain.setTargetAtTime(S.boost, graph.ctx.currentTime, 0.02)
  if (graph.pitch) graph.pitch.parameters.get('ratio').value = ratio
  else if (ratio !== 1) toast('Pitch change is not available here')
  if (graph.ctx.state !== 'running') void graph.ctx.resume()
}
async function buildGraph() {
  try {
    const ctx = new AudioContext()
    let pitch = null
    try {
      await ctx.audioWorklet.addModule('./pitch-worklet.js')
      pitch = new AudioWorkletNode(ctx, 'tube-pitch', { outputChannelCount: [2] })
    } catch (e) {
      log(`pitch worklet: ${e.name}: ${e.message}`)
    }
    const src = ctx.createMediaElementSource(video)
    const gain = ctx.createGain()
    if (pitch) src.connect(pitch).connect(gain)
    else src.connect(gain)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.78
    gain.connect(analyser).connect(ctx.destination)
    video.addEventListener('play', () => ctx.state !== 'running' && void ctx.resume())
    return { ctx, src, gain, pitch, analyser }
  } catch (e) {
    toast(`Audio tools are not available (${e.name})`)
    return null
  }
}

// a saved boost / pitch comes back with the first playback
video.addEventListener('play', () => void applyAudio())

// Autoplay: when a video ends (and Loop is off), the next one from "more videos" starts.
video.addEventListener('ended', () => {
  if (S.loop) return void ((video.currentTime = 0), video.play())
  if (!S.autoplay || !S.watch) return
  autoplayed.add(S.watch.id)
  const next = nextVideo()
  if (!next) return
  toast(`Up next: ${next.title}`)
  void openWatch(next)
})

/* ---------------- playlists (your YouTube account's) ---------------- */
async function loadPlaylistOptions() {
  if (!S.account) return renderSheet()
  const id = S.plFor.id
  const r = await call('yt.playlistsFor', { id })
  if (S.plFor?.id !== id) return
  S.plOptions = r.error ? { error: r.error } : r.playlists
  renderSheet()
}
function renderPlaylistSheet() {
  const box = $('#sheetBody')
  const v = S.plFor
  const head = `<div class="flex items-center gap-3">${img(v.thumb, 'aspect-video w-[88px] shrink-0 rounded-[10px] object-cover')}
      <div class="min-w-0"><p class="text-[16px] font-medium">Save to playlist</p><p class="clamp2 mt-0.5 text-[11.5px] text-mute">${esc(v.title)}</p></div></div>`
  if (!S.account) {
    box.innerHTML = `${head}<p class="mt-5 text-[12.5px] text-mute">Playlists live in your YouTube account. Sign in to add videos to them.</p>
      <button data-act="account" class="mt-4 w-full rounded-full bg-brand py-2.5 text-[13px] font-bold">Sign in</button>`
    return hydrate(box)
  }
  const ps = S.plOptions as any
  const list =
    ps === null
      ? `<div class="space-y-3 px-4 py-3">${Array.from({ length: 3 }, () => '<div class="flex items-center gap-3"><div class="sk h-5 w-5 rounded-[6px]"></div><div class="sk h-3 w-1/2 rounded"></div></div>').join('')}</div>`
      : ps.error
        ? `<p class="px-4 py-4 text-[12px] text-[#ffb4b4]">${esc(ps.error)}</p>`
        : ps.map((p) => `<li><button data-pl-toggle="${esc(p.id)}" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/5">
            <span class="${p.has ? 'bg-brand text-white' : 'border border-[#666]'} grid h-5 w-5 shrink-0 place-items-center rounded-[6px]">${p.has ? I.tick(13) : ''}</span>
            <span class="min-w-0 flex-1 truncate text-[13.5px]">${esc(p.title)}</span>
            ${p.privacy === 'PRIVATE' ? `<span class="text-mute">${I.lock()}</span>` : ''}</button></li>`).join('')
  box.innerHTML = `${head}
    <ul class="no-sb mt-5 max-h-[40vh] overflow-y-auto rounded-[18px] bg-surface">${list}</ul>
    <p class="mt-5 text-[12px] font-medium text-mute">New playlist</p>
    <div class="mt-2 flex gap-2">
      <input id="plName" maxlength="150" placeholder="Name" class="min-w-0 flex-1 rounded-[12px] border border-white/10 bg-black/30 px-3 py-2 text-[13px] outline-none focus:border-brand">
      <select id="plPrivacy" class="rounded-[12px] border border-white/10 bg-black/30 px-2 text-[12px] outline-none" aria-label="Visibility">
        <option value="PRIVATE">Private</option><option value="UNLISTED">Unlisted</option><option value="PUBLIC">Public</option></select>
      <button data-act="plCreate" class="rounded-[12px] bg-brand px-4 text-[12.5px] font-bold">Create</button>
    </div>
    <button data-act="closeSheet" class="mt-5 w-full rounded-full border border-line py-2.5 text-[13px]">Done</button>`
  hydrate(box)
}
async function togglePlaylist(playlistId) {
  const p = (S.plOptions as any)?.find?.((x) => x.id === playlistId)
  if (!p || !S.plFor) return
  p.has = !p.has
  renderSheet()
  const r = await call('yt.playlistEdit', { playlistId, id: S.plFor.id, add: p.has })
  if (r.error) {
    p.has = !p.has
    renderSheet()
    return toast(r.error)
  }
  toast(p.has ? `Added to ${p.title}` : `Removed from ${p.title}`)
}
async function createPlaylist() {
  const title = $('#plName').value.trim()
  if (!title) return void $('#plName').focus()
  const r = await call('yt.playlistCreate', { title, privacy: $('#plPrivacy').value, id: S.plFor.id })
  if (r.error) return toast(r.error)
  toast(`Created ${title}`)
  S.plOptions = null
  renderSheet()
  void loadPlaylistOptions()
}
/** Library ▸ Playlists: your playlists, or one playlist's videos. */
async function renderPlaylists(el, tabs, fresh = false) {
  const nav = `<nav class="no-sb mt-6 flex gap-6 overflow-x-auto px-5 pb-3 text-[14px] text-[#9a9a9a]">
    ${tabs.map(([k, n]) => `<button data-lib="${k}" class="${k === 'playlists' ? 'tab-active' : ''} shrink-0">${n}</button>`).join('')}</nav>`
  if (!S.account) {
    el.innerHTML = `${header('Library')}${nav}<div class="mx-5 mt-6 rounded-2xl bg-panel p-5 text-center"><p class="text-[12.5px] text-mute">Your YouTube playlists show here once you sign in.</p>
      <button data-act="account" class="mt-4 rounded-full bg-brand px-5 py-2 text-[12.5px] font-bold">Sign in</button></div>`
    return
  }
  const id = S.openPlaylist
  if (id) {
    el.innerHTML = `${header('Library')}${nav}<div id="plDetail" class="mt-4 px-5">
      <button data-act="plBack" class="flex items-center gap-1 text-[12px] text-mute hover:text-white">${I.back(13)} Playlists</button>
      <div class="mt-3 space-y-2"><div class="sk h-5 w-2/3 rounded"></div><div class="sk h-3 w-1/4 rounded"></div></div>
      <div class="mt-5 space-y-4">${SK.rows(5)}</div></div>`
    const r = await call('yt.playlist', { id, fresh }, 90_000)
    if (S.view !== 'library' || S.openPlaylist !== id) return
    if (r.error) return void ($('#plDetail').innerHTML = errorBox(r.error, 'reload'))
    S.playlistData = { id, ...r }
    $('#plDetail').innerHTML = `
      <button data-act="plBack" class="flex items-center gap-1 text-[12px] text-mute hover:text-white">${I.back(13)} Playlists</button>
      <p class="mt-3 text-[18px] font-bold">${esc(r.title)}</p>
      <p class="mt-0.5 text-[11.5px] text-mute">${r.videos.length} video${r.videos.length === 1 ? "" : "s"}</p>
      <div class="mt-4 flex gap-2">
        <button data-act="plPlay" class="flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[12.5px] font-bold text-black">${I.play(14)} Play all</button>
        <button data-act="plShuffle" class="flex items-center gap-1.5 rounded-full bg-surface px-4 py-2 text-[12.5px]">${I.shuffle(15)} Shuffle</button>
      </div>
      <div class="mt-5 space-y-4">${r.videos.length ? r.videos.map(rowCard).join('') : empty('This playlist is empty.')}</div>`
    return hydrate(el)
  }
  el.innerHTML = `${header('Library')}${nav}<div class="mt-3 flex justify-end px-5"><button data-act="plRefresh" class="text-[11px] text-mute hover:text-white">Refresh</button></div>
    <div id="plList" class="mt-2 grid grid-cols-2 gap-x-3 gap-y-5 px-5">${Array.from({ length: 4 }, () => '<div><div class="sk aspect-video w-full rounded-[14px]"></div><div class="sk mt-2 h-3 w-3/4 rounded"></div></div>').join('')}</div>`
  const r = await call('yt.playlists', { fresh }, 90_000)
  if (S.view !== 'library' || S.openPlaylist) return
  const box = $('#plList')
  if (r.error) return void (box.outerHTML = errorBox(r.error, 'reload'))
  box.innerHTML = r.playlists.length
    ? r.playlists.map((p) => `<button data-pl-open="${esc(p.id)}" class="block min-w-0 text-left">
        <div class="relative">${img(p.thumb, 'aspect-video w-full rounded-[14px] object-cover')}
          <span class="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px]">${I.listPlus(12)}${p.count ?? ''}</span></div>
        <p class="mt-1.5 truncate text-[12px] font-medium">${esc(p.title)}</p></button>`).join('')
    : `<p class="col-span-2">${empty('No playlists yet. Use “Playlist” under a video to make one.')}</p>`
  hydrate(box)
}

/* ---------------- Lofi: a music-player face for the watch page ---------------- */
// The <video> keeps playing out of sight; this screen shows the thumbnail, the controls of a music
// app and the captions as lyrics. Its colors come from the thumbnail.
function nextVideo() {
  if (S.queue?.length) {
    const rest = S.queue.filter((v) => v.id !== S.watch?.id && !autoplayed.has(v.id))
    const i = S.queue.findIndex((v) => v.id === S.watch?.id)
    if (S.shuffle) return rest[Math.floor(Math.random() * rest.length)] ?? null
    return S.queue[i + 1] ?? null
  }
  const pool = related.filter((v) => !autoplayed.has(v.id) && v.id !== S.watch?.id)
  if (!pool.length) return null
  return S.shuffle ? pool[Math.floor(Math.random() * pool.length)] : pool[0]
}
const lofiThumb = (w) => `https://i.ytimg.com/vi/${w.id}/hqdefault.jpg` // always there; 4:3 with bars, cropped to 16:9
let lofiFor = null // video id the Lofi screen was built for
/** The tools row and the audio knobs go back under the player (from the Lofi card). */
function toolsHome() {
  if ($('#audioCards').previousElementSibling !== $('#tools')) $('#tools').after($('#audioCards'))
}
function renderLofi() {
  const box = $('#lofi')
  const w = S.watch
  const on = S.lofi && !!w
  $('#v-watch').classList.toggle('lofi', on)
  if (!on) {
    lofiFor = null
    toolsHome()
    if (lyricsByLofi) closeLyrics()
    placeVideo(false)
    box.innerHTML = ''
    box.hidden = true
    return
  }
  box.hidden = false
  if (lofiFor !== w.id || !$('#lofiVideo')) {
    lofiFor = w.id
    $('#stage').prepend(video) // out of the card before its HTML is replaced
    $('#pipNote').before($('#shade'), $('#controls'), $('#pmenu'))
    toolsHome()
    box.innerHTML = `
    <div class="lofi-bg absolute inset-0"></div>
    ${img(lofiThumb(w), 'lofi-blur absolute inset-x-0 top-0 h-[70%] w-full object-cover')}
    <div class="absolute inset-0 bg-gradient-to-b from-transparent via-black/10 to-black/40"></div>
    <div class="relative pb-7">
      <div class="px-5 pt-5">
        <div class="lofi-card relative">
          <div id="lofiVideo" class="relative aspect-video w-full overflow-hidden rounded-[22px] bg-black">
            ${img(lofiThumb(w), 'lofi-art pointer-events-none absolute inset-0 z-[1] h-full w-full object-cover transition-opacity duration-300')}
          </div>
        </div>
        <canvas id="lofiViz" class="mt-9 block h-[84px] w-full" aria-hidden="true"></canvas>
        <div id="lofiLyricsWrap" class="lyrics-collapse ${lyricsOpen ? 'open' : ''}"><div class="min-h-0 overflow-hidden">
          <section class="glass-dark mt-3 rounded-[20px] px-4 pb-4 pt-3.5">
            <p class="text-[14px] font-semibold">Lyrics</p>
            <div id="lofiLyrics" data-no-i18n class="mt-2 min-h-[64px] space-y-1.5 text-[13.5px] leading-snug"></div>
          </section>
        </div></div>
      </div>
      <div class="px-5 pt-5">
        <p class="truncate text-[12px] text-white/70">Playing From · <button id="lofiChannel" class="text-white/90 hover:underline"></button></p>
        <p id="lofiTitle" data-no-i18n class="clamp2 mt-1 text-[21px] font-bold leading-tight tracking-tight"></p>
        <div class="lofi-pills no-sb -mx-5 mt-4 flex gap-1.5 overflow-x-auto px-5 text-[12px]">
          <button data-act="lofi" role="switch" aria-checked="true" class="glass-tint flex items-center gap-2 rounded-[14px] px-3.5 py-2.5" title="Leave Lofi">${I.lofi(16)}<span>Lofi</span></button>
          <button data-act="audio" id="lofiAudioBtn" class="flex items-center gap-2 rounded-[14px] px-3.5 py-2.5">${I.sliders(16)}<span>Audio</span></button>
          <button data-act="lofiLyrics" id="lofiLyricsBtn" class="flex items-center gap-2 rounded-[14px] px-3.5 py-2.5">${I.lyrics(16)}<span>Lyrics</span></button>
          <button data-act="lofiUpNext" id="lofiUpNextBtn" class="flex items-center gap-2 rounded-[14px] px-3.5 py-2.5">${I.queue(16)}<span>Up Next</span></button>
          <button data-act="lofiArt" id="lofiArtBtn" class="flex items-center gap-2 rounded-[14px] px-3.5 py-2.5"></button>
        </div>
        <div id="lofiAudio"></div>
        <div id="lofiUpNext"></div>
        <div class="mt-5 flex justify-between text-[12px] tabular-nums text-white/85"><span id="lofiCur">0:00</span><span id="lofiDur"></span></div>
        <div id="lofiBar"></div>
        <div class="mt-6 flex items-center justify-between px-1">
          <button data-act="shuffle" id="lofiShuffle" aria-label="Shuffle">${I.shuffle()}</button>
          <button data-act="lofiPrev" aria-label="Previous">${I.prev()}</button>
          <button data-act="toggle" id="lofiPlay" class="glass grid h-[76px] w-[76px] place-items-center rounded-full" aria-label="Play"></button>
          <button data-act="lofiNext" aria-label="Next">${I.next()}</button>
          <button data-act="lofiLoop" id="lofiLoopBtn" aria-label="Repeat">${I.loopIc()}</button>
        </div>
      </div>
    </div>`
    hydrate(box)
    $('#lofiAudio').append($('#audioCards'))
    vizSeen.disconnect()
    vizSeen.observe($('#lofiViz'))
    void startViz()
  }
  // the parts that change while the same video plays
  $('#lofiTitle').textContent = w.title
  $('#lofiChannel').textContent = w.channel
  $('#lofiChannel').dataset.channel = w.channelId ?? ''
  $('#lofiDur').textContent = w.live ? 'LIVE' : clock(w.duration || 0)
  if (!!$('#lofiSeek') === !!w.live || !$('#lofiBar').firstChild)
    $('#lofiBar').innerHTML = w.live ? '<div class="glass mt-2.5 h-[12px] rounded-full"></div>' : `<input id="lofiSeek" type="range" min="0" max="1000" value="0" class="lofi-seek mt-2.5 block w-full" aria-label="Seek">`
  $('#lofiShuffle').className = S.shuffle ? 'text-[#f0a23a]' : 'text-white'
  $('#lofiLoopBtn').className = S.loop ? 'text-[#f0a23a]' : 'text-white'
  $('#lofiLyricsWrap').classList.toggle('open', lyricsOpen)
  $('#lofiLyricsBtn').classList.toggle('glass-tint', lyricsOpen)
  $('#lofiLyricsBtn').classList.toggle('glass-dark', !lyricsOpen)
  const thumbOnly = S.lofiThumb || !(w.video || w.hls)
  $('#lofiVideo').classList.toggle('show-art', thumbOnly)
  $('#lofiArtBtn').innerHTML = S.lofiThumb ? `${I.image(16)}<span>Thumbnail</span>` : `${I.film(16)}<span>Video</span>`
  $('#lofiArtBtn').className = `${S.lofiThumb ? 'glass-tint' : 'glass-dark'} flex items-center gap-2 rounded-[14px] px-3.5 py-2.5`
  $('#lofiAudioBtn').classList.toggle('glass-tint', !!S.audioOpen)
  $('#lofiAudioBtn').classList.toggle('glass-dark', !S.audioOpen)
  $('#lofiUpNextBtn').classList.toggle('glass-tint', upNextOpen)
  $('#lofiUpNextBtn').classList.toggle('glass-dark', !upNextOpen)
  renderUpNext()
  $('#lofiPlay').innerHTML = S.playing ? I.pause(30) : I.play(30)
  placeVideo(false)
  syncLofiTime()
  renderLyrics()
  // a new video with the lyrics open: load its captions too
  if (lyricsOpen && !activeCaption && !lyricsLoading && w.captions?.length) void openLyrics()
}
// Visualizer: bars that follow the music's spectrum (low notes left), mirrored around the middle.
let vizRaf = 0
let vizVisible = true
const vizSeen = new IntersectionObserver(([e]) => (vizVisible = e.isIntersecting))
video.addEventListener('play', () => {
  if (S.lofi && !vizRaf && $('#lofiViz')) void startViz()
})
let vizBase = [139, 71, 230] // average color of the thumbnail
let vizCache = null
/** Three stops around the thumbnail's hue, bright enough to read on its own background. */
function vizStops() {
  if (vizCache?.base === vizBase) return vizCache.stops
  const [r, g, b] = vizBase.map((v) => v / 255)
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  let h = 0
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (h * 60 + 360) % 360
  const sat = Math.min(0.85, 0.45 + d)
  const hsl = (hh, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * sat
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
    const m = l - c / 2
    const [a, bb, cc] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x]
    return [a, bb, cc].map((v) => Math.round((v + m) * 255))
  }
  const stops = [hsl((h + 340) % 360, 0.66), hsl(h, 0.6), hsl((h + 28) % 360, 0.56)]
  vizCache = { base: vizBase, stops }
  return stops
}
async function startViz() {
  graph ??= await (graphing ??= buildGraph())
  if (!graph?.analyser || !$('#lofiViz')) return
  if (graph.ctx.state !== 'running') void graph.ctx.resume()
  cancelAnimationFrame(vizRaf)
  const an = graph.analyser
  const bins = new Uint8Array(an.frequencyBinCount)
  const BARS = 32
  const colorAt = (t) => {
    const STOPS = vizStops()
    const f = t * (STOPS.length - 1)
    const k = Math.min(STOPS.length - 2, Math.floor(f))
    const u = f - k
    return STOPS[k].map((c, j) => Math.round(c + (STOPS[k + 1][j] - c) * u))
  }
  const rgb = (c, m = 1, a = 1) => `rgba(${c.map((v) => Math.max(0, Math.min(255, Math.round(v * m)))).join(',')},${a})`
  let last = 0
  let quiet = 0
  const draw = (now = 0) => {
    const c = $('#lofiViz')
    if (!c || !S.lofi) return void (vizRaf = 0)
    vizRaf = requestAnimationFrame(draw)
    if (document.hidden || !vizVisible || now - last < 33) return // ~30 fps is plenty for bars
    last = now
    // paused: draw until the bars have fallen, then stop until playback starts again
    if (video.paused) {
      if (++quiet > 45) return void (cancelAnimationFrame(vizRaf), (vizRaf = 0))
    } else quiet = 0
    const dpr = devicePixelRatio || 1
    const w = c.clientWidth
    const h = c.clientHeight
    if (c.width !== Math.round(w * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr))
    const g = (c as unknown as HTMLCanvasElement).getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    an.getByteFrequencyData(bins)
    const step = (w - 10) / BARS
    const bw = step * 0.62
    const dx = bw * 0.55 // depth: the side and top faces lean up-right
    const dy = bw * 0.42
    const floor = h * 0.74 // bars stand here; their reflection fades below
    const maxH = floor - dy - 2
    // floor glow
    const fl = g.createRadialGradient(w / 2, floor, 4, w / 2, floor, w * 0.55)
    fl.addColorStop(0, rgb(colorAt(0.5), 1, 0.22))
    fl.addColorStop(1, rgb(colorAt(0), 1, 0))
    g.fillStyle = fl
    g.fillRect(0, floor - 6, w, h - floor + 6)
    for (let i = 0; i < BARS; i++) {
      const idx = Math.min(bins.length - 1, Math.floor(2 + (i / BARS) ** 1.9 * bins.length * 0.55))
      const v = bins[idx] / 255
      const bh = Math.max(3, v ** 1.35 * maxH)
      const x = 4 + i * step + (step - bw - dx * 0.5) / 2
      const top = floor - bh
      const col = colorAt(i / (BARS - 1))
      // reflection
      const rf = g.createLinearGradient(0, floor, 0, floor + bh * 0.6)
      rf.addColorStop(0, rgb(col, 1, 0.28))
      rf.addColorStop(1, rgb(col, 1, 0))
      g.fillStyle = rf
      g.fillRect(x, floor + 1, bw, Math.min(h - floor, bh * 0.6))
      // side face (shade)
      g.fillStyle = rgb(col, 0.52)
      g.beginPath()
      g.moveTo(x + bw, top)
      g.lineTo(x + bw + dx, top - dy)
      g.lineTo(x + bw + dx, floor - dy)
      g.lineTo(x + bw, floor)
      g.closePath()
      g.fill()
      // front face, lit from above, with a glow that grows with the level
      const fr = g.createLinearGradient(0, top, 0, floor)
      fr.addColorStop(0, rgb(col, 1.25))
      fr.addColorStop(1, rgb(col, 0.78))
      g.shadowColor = rgb(col, 1, 0.8)
      g.shadowBlur = 4 + v * 14
      g.fillStyle = fr
      g.fillRect(x, top, bw, bh)
      g.shadowBlur = 0
      // top face (highlight)
      g.fillStyle = rgb(col.map((v2) => v2 + (255 - v2) * 0.55))
      g.beginPath()
      g.moveTo(x, top)
      g.lineTo(x + dx, top - dy)
      g.lineTo(x + bw + dx, top - dy)
      g.lineTo(x + bw, top)
      g.closePath()
      g.fill()
    }
  }
  draw()
}

// Up Next: the playlist being played, else the related videos, with the current one marked.
let upNextOpen = false
let myLists = null // your playlists, for the Up Next source picker
async function loadMyLists() {
  if (!S.account || myLists) return
  const r = await call('yt.playlists', {}, 90_000)
  if (r.playlists) {
    myLists = r.playlists
    renderUpNext()
  }
}
async function useUpNextSource(id) {
  if (!id) {
    S.queue = null
    S.playlistData = null
    return renderUpNext()
  }
  const box = $('#lofiUpNext')
  if (box) box.querySelector('section')?.insertAdjacentHTML('beforeend', '<p id="upNextLoading" class="px-2 py-2 text-[11.5px] text-white/60">Loading playlist…</p>')
  const r = await call('yt.playlist', { id }, 90_000)
  if (r.error) return toast(r.error)
  S.playlistData = { id, ...r }
  S.queue = r.videos
  S.shuffle = false
  renderUpNext()
  renderLofi()
}
function upNextItems() {
  const w = S.watch
  if (S.queue?.length) return S.queue
  return w ? [w, ...related.filter((v) => v.id !== w.id)] : related
}
const eq = () => `<span class="eq flex h-[14px] items-end gap-[2px]"><i></i><i></i><i></i></span>`
function renderUpNext() {
  const box = $('#lofiUpNext')
  if (!box) return
  if (!upNextOpen) return void (box.innerHTML = '')
  void loadMyLists()
  const items = upNextItems().slice(0, 30)
  const cur = S.watch?.id
  box.innerHTML = `<section class="glass-dark mt-3 rounded-[20px] px-2 pb-2 pt-3">
      <div class="flex items-center gap-2 px-2 pb-1.5"><p class="text-[14px] font-semibold">Up Next</p>
        <label class="relative ml-auto flex min-w-0 max-w-[60%] items-center gap-1 rounded-full bg-white/10 py-1 pl-2.5 pr-2 text-[11.5px]">
          <span class="truncate">${S.queue?.length ? esc(S.playlistData?.title ?? 'Playlist') : 'Related'}</span>${I.down(9)}
          <select data-up-source class="absolute inset-0 cursor-pointer opacity-0" aria-label="Play from">
            <option value="" ${S.queue?.length ? '' : 'selected'}>Related</option>
            ${(myLists ?? []).map((p) => `<option value="${esc(p.id)}" ${S.queue?.length && S.playlistData?.id === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
            ${S.account && !myLists ? '<option disabled>Loading playlists…</option>' : ''}
          </select></label>
        ${S.queue?.length ? `<button data-act="plPlay" class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-black" title="Play this playlist" aria-label="Play this playlist">${I.play(12)}</button>` : ''}
      </div>
      ${
        items.length
          ? items.map((v) => {
              const on = v.id === cur
              return `<div class="${on ? 'bg-white/10' : 'hover:bg-white/5'} flex items-center gap-3 rounded-[14px] px-2 py-2">
                <button data-up-next="${esc(v.id)}" class="flex min-w-0 flex-1 items-center gap-3 text-left">
                  ${img(v.thumb, 'h-11 w-11 shrink-0 rounded-[10px] object-cover')}
                  <span class="min-w-0 flex-1"><span class="block truncate text-[13px] font-medium">${esc(v.title)}</span><span class="block truncate text-[11px] text-white/60">${esc(v.channel || '')}</span></span>
                  <span class="flex shrink-0 flex-col items-end gap-1 text-[11px] tabular-nums text-white/70">${on ? `<span class="${S.playing ? '' : 'paused'}">${eq()}</span>` : ''}${v.live ? 'LIVE' : v.duration ? clock(v.duration) : ''}</span>
                </button>
                <button data-pl-for="${esc(v.id)}" class="grid h-8 w-6 shrink-0 place-items-center text-white/70 hover:text-white" aria-label="Add to playlist">${I.more(15)}</button>
              </div>`
            }).join('')
          : `<p class="px-2 py-4 text-[12px] text-white/60">Loading…</p>`
      }
    </section>`
  hydrate(box)
}

// Lyrics: T opens a sheet under the video with the captions (kept off the picture: mode 'hidden').
let lyricsOpen = false
let lyricsByLofi = false // captions were loaded for the lyrics, so they go when the lyrics close
let lyricsLoading = false
async function openLyrics() {
  const caps = S.watch?.captions ?? []
  lyricsOpen = true
  if (!caps.length || activeCaption) renderLofi()
  if (!caps.length) return
  if (!activeCaption) {
    const c = caps.find((x) => x.lang === S.cc && !x.auto) ?? caps.find((x) => !x.auto) ?? caps.find((x) => x.orig) ?? caps[0]
    lyricsByLofi = true
    lyricsLoading = true
    renderLofi()
    try {
      await pickCaption(c.key, { remember: false })
    } finally {
      lyricsLoading = false
    }
  }
  for (const t of video.textTracks) if (t.mode === 'showing') t.mode = 'hidden'
  setTimeout(renderLyrics, 300)
}
function closeLyrics() {
  lyricsOpen = false
  if (lyricsByLofi) clearCaptions()
  else for (const t of video.textTracks) if (t.mode === 'hidden') t.mode = 'showing'
  lyricsByLofi = false
  if ($('#lofiVideo')) renderLofi()
}
function syncLofiTime() {
  if (!$('#lofi') || $('#lofi').hidden) return
  const d = S.watch?.duration || video.duration || 0
  const cur = $('#lofiCur')
  if (cur) cur.textContent = S.watch?.live ? '● LIVE' : clock(video.currentTime)
  const el = $('#lofiSeek')
  if (!el || lofiSeeking) return
  const v = d ? (video.currentTime / d) * 1000 : 0
  el.value = String(v)
  el.style.setProperty('--p', `${v / 10}%`)
}
let lofiSeeking = false
video.addEventListener('timeupdate', syncLofiTime)
document.addEventListener('input', (e) => {
  if (tg(e).id !== 'lofiSeek') return
  lofiSeeking = true
  const d = S.watch?.duration || video.duration || 0
  tg(e).style.setProperty('--p', `${+tg(e).value / 10}%`)
  if (d) video.currentTime = Math.min(d - 0.5, (+tg(e).value / 1000) * d)
})
document.addEventListener('change', (e) => {
  if (tg(e).id === 'lofiSeek') lofiSeeking = false
})
// Lyrics: the caption cue playing now, highlighted, and the next two.
function renderLyrics() {
  const box = $('#lofiLyrics')
  if (!box) return
  const tr = [...video.textTracks].find((t) => t.mode !== 'disabled')
  if (!tr?.cues?.length) {
    box.innerHTML = `<p class="text-white/60">${S.watch?.captions?.length ? 'Loading captions…' : 'No captions for this video.'}</p>`
    return
  }
  const cues = [...tr.cues]
  const t = video.currentTime
  let i = cues.findLastIndex((c) => c.startTime <= t)
  if (i < 0) i = 0
  const lines = []
  for (let k = i; k < cues.length && lines.length < 3; k++) {
    const text = (cues[k] as VTTCue).text.replace(/\n/g, ' ').trim()
    if (text && !lines.includes(text)) lines.push(text)
  }
  box.innerHTML = lines.map((l, k) => `<p class="${k === 0 && cues[i].endTime >= t ? 'lyric-hi font-medium' : 'text-white/85'}">${esc(l)}</p>`).join('')
}
let lyricTick = 0
video.addEventListener('timeupdate', () => {
  if (!S.lofi || Date.now() - lyricTick < 400) return
  lyricTick = Date.now()
  renderLyrics()
})
// Background tint from the thumbnail: average color, kept dark enough for white text.
document.addEventListener('load', (e) => {
  const el = e.target as HTMLImageElement
  if (!el.classList?.contains('lofi-blur')) return
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 12
    const g = c.getContext('2d')
    g.drawImage(el, 0, 0, 12, 12)
    const px = g.getImageData(0, 0, 12, 12).data
    let r = 0, gg = 0, b = 0
    for (let k = 0; k < px.length; k += 4) (r += px[k]), (gg += px[k + 1]), (b += px[k + 2])
    const n = px.length / 4
    const mix = (v, f) => Math.round((v / n) * f)
    $('#lofi').style.setProperty('--lofi-a', `${mix(r, 0.75)} ${mix(gg, 0.6)} ${mix(b, 0.7)}`)
    $('#lofi').style.setProperty('--lofi-b', `${mix(r, 0.3)} ${mix(gg, 0.22)} ${mix(b, 0.35)}`)
    vizBase = [mix(r, 1), mix(gg, 1), mix(b, 1)]
  } catch {}
}, true)

/** Offers a template in Orca's save dialog; where there is none, puts it in the editor instead. */
async function saveTemplate(name: string, mime: string, text: string) {
  if (orca.files) {
    const r = await orca.files.saveAs({ suggestedName: name, mimeType: mime, data: text }).catch(() => null)
    if (r?.status === 'saved') toast(t('Template saved'), 'success')
    return
  }
  const box = $(mime === 'text/css' ? '#cssCode' : '#scriptCode')
  box.value = text
  S.drafts[mime === 'text/css' ? 'css' : 'script'] = text
  toast(t('Template added to the editor'))
}

/* ---------------- language ---------------- */
async function changeLang(pref) {
  S.lang = pref
  store.set('lang', pref)
  await setLang(pref)
  // strings built in code (counts, ...) are drawn again in the new language
  renderNav()
  if (S.watch) (renderWatchInfo(), renderTools(), renderMini())
  show(S.view)
}

/* ---------------- theme + custom CSS / script ---------------- */
const THEMES = {
  default: { name: 'Default', ink: '161616', panel: '202020', surface: '2c2c2c', line: '3a3a3a', mute: '9a9a9a' },
  oled: { name: 'Black', ink: '000000', panel: '0e0e0e', surface: '1c1c1c', line: '2c2c2c', mute: '8a8a8a' },
  midnight: { name: 'Midnight', ink: '0e1320', panel: '161c2b', surface: '222a3c', line: '323c53', mute: '8d97ad' },
  mocha: { name: 'Mocha', ink: '1a1614', panel: '241f1c', surface: '332c28', line: '463d37', mute: 'a39689' },
  forest: { name: 'Forest', ink: '0f1611', panel: '17201a', surface: '223026', line: '324437', mute: '8fa394' },
  plum: { name: 'Plum', ink: '17121c', panel: '201a27', surface: '2e2537', line: '41354d', mute: '9d90ab' }
}
const ACCENTS = { red: ['Red', 'e3262b'], blue: ['Royal Blue', '3d6bf2'], teal: ['Teal', '14b8a6'], green: ['Green', '22a35a'], purple: ['Purple', '8b5cf6'], orange: ['Orange', 'f97316'], pink: ['Pink', 'ec4899'] }
const COLOR_KEYS = [['brand', 'Accent'], ['ink', 'Background'], ['panel', 'Cards'], ['surface', 'Buttons'], ['line', 'Lines'], ['mute', 'Muted text']]
const LAYOUT_PARTS = [['tools', 'Tools under the video (Loop, Autoplay, Audio)'], ['actions', 'Like / views / copy / save row'], ['comments', 'Comments and live chat'], ['related', 'More videos under the player'], ['labels', 'Labels in the bottom bar'], ['chips', 'Category chips on Home']]
const themeColors = () => ({ ...(THEMES[S.theme.preset] ?? THEMES.default), brand: (ACCENTS[S.theme.accent] ?? ACCENTS.red)[1], ...S.theme.custom })
function applyTheme() {
  const c = themeColors()
  const root = document.documentElement.style
  for (const [k] of COLOR_KEYS) {
    const hex = c[k]
    root.setProperty(`--${k}`, [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' '))
  }
  let st = document.getElementById('userCss')
  if (!st) {
    st = document.createElement('style')
    st.id = 'userCss'
    document.head.append(st)
  }
  st.textContent = S.theme.cssOn ? S.theme.css : ''
  const L = S.theme.layout
  root.setProperty('--zoom', String(L.zoom / 100))
  const cl = document.documentElement.classList
  cl.toggle('corners-small', L.corners === 'small')
  cl.toggle('corners-square', L.corners === 'square')
  for (const [k] of LAYOUT_PARTS) cl.toggle(`hide-${k}`, !!L.hide[k])
}
function saveTheme() {
  applyTheme()
  store.set('theme', S.theme)
}
document.addEventListener('input', (e) => {
  const k = tg(e).dataset?.color
  if (k) {
    S.theme.custom[k] = tg(e).value.slice(1).toLowerCase()
    applyTheme()
  }
  const draft = tg(e).dataset?.draft
  if (draft) S.drafts[draft] = tg(e).value
})
document.addEventListener('change', (e) => {
  if (tg(e).dataset?.color) saveTheme()
})
/** Runs user code in the panel as an inline <script> (the frame allows inline scripts, not eval). */
function runUserScript(code) {
  if (!code.trim()) return toast('The script is empty')
  window.__tubeScriptError = (e) => toast(`Script error: ${(e as Error)?.message ?? e}`)
  const el = document.createElement('script')
  el.textContent = `(async () => {\ntry {\n${code}\n} catch (e) { window.__tubeScriptError(e) }\n})()`
  document.body.append(el)
  el.remove()
}

/* ---------------- Settings ▸ Updates ---------------- */
let upd: { latest?: string; busy?: boolean; checking?: boolean; error?: string } = {}
const newer = (a: string, b: string) => {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(Number)
  const pb = b.replace(/^v/, '').split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}
/** Settings ▸ Updates: Tube itself (the tools inside come with each Tube version). */
function updatesHtml() {
  const L = upd.latest
  const isNew = !!L && newer(L, ABOUT.version)
  const status = L === undefined ? t('Not checked yet') : isNew ? t('{v} is available', { v: esc(L.replace(/^v/, '')) }) : t('Up to date')
  const btn = isNew
    ? `<button data-act="updateSelf" class="shrink-0 rounded-full bg-brand px-4 py-1.5 text-[12px] font-bold text-white disabled:opacity-50" ${upd.busy ? 'disabled' : ''}>${upd.busy ? t('Updating…') : t('Update')}</button>`
    : `<button data-act="checkUpdates" class="shrink-0 rounded-full border border-line px-4 py-1.5 text-[12px] hover:bg-white/5 disabled:opacity-50" ${upd.checking ? 'disabled' : ''}>${upd.checking ? t('Checking…') : t('Check for updates')}</button>`
  return `<div class="flex items-center gap-3 px-4 py-4">
      <span class="grid h-[30px] w-[40px] shrink-0 place-items-center rounded-[8px] bg-brand text-white">${I.tube(22)}</span>
      <span class="min-w-0 flex-1"><span class="block text-[13.5px] font-medium">Tube ${ABOUT.version}</span><span class="mt-0.5 block text-[11.5px] ${isNew ? 'text-[#2fbf71]' : 'text-mute'}">${status}</span></span>
      ${btn}
    </div>${upd.error ? `<p class="px-4 pb-3 text-[11.5px] leading-relaxed text-[#ffb4b4]">${esc(upd.error)}</p>` : ''}`
}
function syncUpdates() {
  const box = $('#updatesCard')
  if (box) box.innerHTML = updatesHtml()
}
async function checkUpdates() {
  upd.checking = true
  syncUpdates()
  const r = await call('tube.latest')
  upd.checking = false
  upd.latest = r.tube ?? ''
  syncUpdates()
  const isNew = !!upd.latest && newer(upd.latest, ABOUT.version)
  toast(isNew ? t('Tube {v} is available', { v: upd.latest.replace(/^v/, '') }) : t('Tube is up to date'), isNew ? 'info' : 'success')
}
async function updateSelf() {
  upd.busy = true
  upd.error = ''
  syncUpdates()
  toast(t('Updating Tube…'))
  const r = await call('tube.updateSelf', {}, 240_000)
  upd.busy = false
  if (r?.ok) toast(t('Tube updated to {v}', { v: r.version || '' }), 'success') // Orca restarts Tube with it
  else {
    upd.error = r?.needsApproval ? t('This version asks for new access. Update it in Orca: Settings ▸ Plugins.') : r?.error || t('Update failed')
    toast(upd.error, 'error')
  }
  syncUpdates()
}
/** When Tube starts: say so if a newer Tube is out (the worker checked once, at its start). */
async function noticeNewVersion() {
  const r = await call('tube.startupLatest')
  if (!r.tube) return
  upd.latest = r.tube
  if (newer(r.tube, ABOUT.version)) toast(t('Tube {v} is available — update it in Settings ▸ Updates', { v: r.tube.replace(/^v/, '') }))
}

/* ---------------- first start ---------------- */
// The worker installs its tools on first start; until yt-dlp is in place the panel shows progress.
const SETUP_STEPS: Record<string, string> = { 'yt-dlp': 'Downloading the video engine (yt-dlp)…', node: 'Preparing the player helper…', ffmpeg: 'Downloading ffmpeg for downloads…' }
async function waitForSetup() {
  for (let shown = false; ; ) {
    const r = await callRaw('tube.setup')
    const st = r?.setup
    if (!st || (st.stage === 'ready' && r.tools?.ytdlp)) {
      $('#setupScreen').hidden = true
      return
    }
    // ffmpeg and the runtime may still be installing once yt-dlp works: no need to block for them
    if (st.stage === 'working' && r.tools?.ytdlp && st.step !== 'yt-dlp' && !shown) return
    shown = true
    $('#setupScreen').hidden = false
    $('#setupStep').textContent = t(SETUP_STEPS[st.step] ?? 'Getting things ready…')
    $('#setupBar').style.width = `${st.pct ?? 0}%`
    $('#setupError').hidden = st.stage !== 'error'
    if (st.stage === 'error') $('#setupErrorText').textContent = st.error
    await sleep(500)
  }
}

/* ---------------- offline ---------------- */
// Shown when the frame says it is offline or a request fails for network reasons, and only once
// the worker confirms YouTube is unreachable. Clears itself when the connection comes back.
let offline = false
let checking = null
function setOffline(on) {
  if (on === offline) return
  offline = on
  $('#offline').hidden = !on
  if (!on) {
    feedCache = null
    show(S.view)
  }
}
function checkOnline() {
  checking ??= callRaw('tube.ping', {}, 8000)
    .then((r) => setOffline(!r?.ok))
    .finally(() => (checking = null))
  return checking
}
addEventListener('offline', () => void checkOnline())
addEventListener('online', () => void checkOnline())
// while offline, look again every 15 s
setInterval(() => offline && void checkOnline(), 15_000)

/* ---------------- prefetch ---------------- */
// Resting on a video card for a moment asks the worker to resolve it, so opening it is quick.
let hoverTimer = 0
let prefetching = false
const prefetchTimes = []
const prefetched = new Set()
document.addEventListener('pointerover', (e) => {
  const card = tg(e).closest?.('[data-watch], [data-up-next]') as El
  clearTimeout(hoverTimer)
  if (!card) return
  const id = card.dataset.watch || card.dataset.upNext
  if (!id || prefetched.has(id) || id === S.watch?.id) return
  hoverTimer = setTimeout(() => {
    // one yt-dlp at a time, and not a burst while the pointer sweeps across a list
    const now = Date.now()
    while (prefetchTimes.length && now - prefetchTimes[0] > 60_000) prefetchTimes.shift()
    if (prefetching || prefetchTimes.length >= 8) return
    prefetched.add(id)
    if (prefetched.size > 40) prefetched.delete(prefetched.values().next().value)
    prefetchTimes.push(now)
    prefetching = true
    void call('tube.watch', { id, maxHeight: S.quality }, 90_000).finally(() => (prefetching = false))
  }, 300)
})

/* Hover preview: resting on a video tile plays it, muted, over its thumbnail, like YouTube's inline
   preview: the first 10 s of a video on a loop (nothing past them is fetched), or a live stream at its
   live edge in its lowest quality. Members-only videos get a label instead. */
const PREVIEW_SECONDS = 10
let pv: { id: string; el: HTMLVideoElement; stop: () => void } | null = null
let pvWant = ''
let pvTimer = 0
function stopPreview() {
  clearTimeout(pvTimer)
  pvWant = ''
  if (!pv) return
  pv.stop()
  pv.el.remove()
  pv = null
}
async function startPreview(box: HTMLElement, id: string) {
  pvWant = id
  const r = await call('tube.watch', { id, maxHeight: S.quality }, 90_000)
  if (pvWant !== id || !box.isConnected) return
  const w = r.watch
  if (w?.members) {
    // only members can watch it: say so on the tile, and leave it out of previews from now on
    box.removeAttribute('data-pv')
    if (!box.querySelector('.members-chip')) box.insertAdjacentHTML('beforeend', membersChip)
    return
  }
  if (!w || !(w.live ? w.hls : w.video)) return log(`preview ${id}: ${r.error ?? 'nothing playable'}`)
  stopPreview()
  pvWant = id
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.className = 'pointer-events-none absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-300'
  box.append(el)
  el.addEventListener('playing', () => el.classList.remove('opacity-0'), { once: true })
  const fail = (e) => {
    log(`preview ${id}: ${e?.message ?? e}`)
    if (pv?.el === el) stopPreview()
  }
  if (w.live) {
    const h = new Hls({ loader: WorkerLoader, tubeKey: w.hls, enableWorker: false, liveSyncDurationCount: 2, maxBufferLength: 6, backBufferLength: 0 } as any)
    pv = { id, el, stop: () => h.destroy() }
    h.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      // the smallest picture is plenty for a thumbnail
      const low = data.levels.map((l, i) => [l.height || 1e4, i]).sort((x, y) => x[0] - y[0])[0]
      if (low) (h.autoLevelCapping = low[1]), (h.nextLevel = low[1])
      void el.play().catch(fail)
    })
    h.on(Hls.Events.ERROR, (_, d) => d.fatal && fail(new Error(d.details)))
    h.attachMedia(el)
    h.loadSource(LIVE_MASTER)
    return
  }
  el.addEventListener('timeupdate', () => {
    if (el.currentTime >= PREVIEW_SECONDS) el.currentTime = 0
  })
  const player = new Player(el, call, { ahead: 3, onError: fail })
  pv = { id, el, stop: () => player.destroy() }
  try {
    await player.load({ ...w, audio: null }, 0)
    if (pv?.el === el) await el.play()
  } catch (e) {
    fail(e)
  }
}
document.addEventListener('pointerover', (e) => {
  const box = tg(e).closest?.('[data-pv]') as HTMLElement | null
  const id = box?.closest<HTMLElement>('[data-watch]')?.dataset.watch
  if (!box || !id) return
  if (pvWant === id || pv?.id === id) return
  stopPreview()
  // no preview while Orca's window is in the background, and not for the video already playing
  if (document.hidden || id === S.watch?.id) return
  pvWant = id
  pvTimer = setTimeout(() => void startPreview(box, id), 600)
})
document.addEventListener('pointerout', (e) => {
  const box = tg(e).closest?.('[data-pv]')
  if (box && !box.contains((e as PointerEvent).relatedTarget as Node)) stopPreview()
})
// leaving the list (opening a video, switching views, hiding Orca) ends the preview
document.addEventListener('click', stopPreview, true)
document.addEventListener('visibilitychange', () => document.hidden && stopPreview())

/* ---------------- live chat ---------------- */
// Polled through the worker every few seconds while the watch view shows the chat.
let chatSeq = 0
const chatSeen = new Set()
function startChat(w) {
  const seq = ++chatSeq
  chatSeen.clear()
  $('#comments').innerHTML = `<div class="mt-5 rounded-[24px] bg-panel px-4 py-3.5">
    <button data-act="chat" class="flex w-full items-center gap-2 text-left">
      <span class="h-2 w-2 rounded-full bg-brand"></span><span class="text-[13px] font-medium">Live chat</span>
      <span id="chatChevron" class="ml-auto text-[#ccc] transition-transform" style="${S.chatOpen ? 'transform:rotate(180deg)' : ''}">${I.down(14)}</span>
    </button>
    <div id="chatList" data-no-i18n class="no-sb mt-2 h-[360px] overflow-y-auto overscroll-contain text-[12.5px]" ${S.chatOpen ? '' : 'hidden'}>${SK.chat()}</div>
  </div>`
  let key = null
  let fails = 0
  const tick = async () => {
    if (seq !== chatSeq) return
    if (S.view === 'watch' && S.chatOpen && !document.hidden) {
      const r = await call('tube.chat', key ? { id: w.id, key } : { id: w.id }, 30_000)
      if (seq !== chatSeq) return
      if (r.error) {
        if (!key || ++fails > 5) return void ($('#chatList').innerHTML = `<p class="py-8 text-center text-[11.5px] text-mute">${esc(r.error)}</p>`)
      } else {
        fails = 0
        key = r.key
        appendChat(r.items, !chatSeen.size)
      }
    }
    setTimeout(tick, key ? 2500 : 1000)
  }
  void tick()
}
const ROLE = { owner: 'rounded bg-[#ffd600] px-1 text-black', moderator: 'text-[#7c9cff]', member: 'text-[#2ba640]', verified: 'text-[#ddd]' }
function chatHtml(m) {
  const who = `<span class="${ROLE[m.role] ?? 'text-[#9a9a9a]'} mr-1.5 font-medium">${esc(m.author)}</span>`
  if (m.amount != null) {
    const bg = /^#[0-9a-f]{6}$/i.test(m.color ?? '') ? m.color : '#1e88e5'
    return `<div class="my-1.5 rounded-xl px-3 py-2 text-black" style="background:${bg}"><p class="text-[11.5px] font-medium opacity-80">${esc(m.author)} · <b>${esc(m.amount)}</b></p>${m.text ? `<p class="mt-0.5 break-words">${esc(m.text)}</p>` : ''}</div>`
  }
  if (m.member) return `<div class="my-1.5 rounded-xl bg-[#0f9d58]/25 px-3 py-2 break-words">${who}${esc(m.text)}</div>`
  return `<p class="break-words py-[3px] leading-snug">${who}<span class="text-[#e8e8e8]">${esc(m.text)}</span></p>`
}
function appendChat(items, first) {
  const list = $('#chatList')
  if (!list) return
  if (first) list.innerHTML = items.length ? '' : '<p class="py-8 text-center text-[11.5px] text-mute">No messages yet.</p>'
  const fresh = items.filter((m) => m.id && !chatSeen.has(m.id))
  if (!fresh.length) return
  if (list.firstElementChild?.matches('p.text-center')) list.innerHTML = ''
  const stick = first || list.scrollHeight - list.scrollTop - list.clientHeight < 60
  for (const m of fresh) chatSeen.add(m.id)
  if (chatSeen.size > 3000) for (const id of [...chatSeen].slice(0, 1000)) chatSeen.delete(id)
  list.insertAdjacentHTML('beforeend', fresh.map(chatHtml).join(''))
  while (list.childElementCount > 250) list.firstElementChild.remove()
  if (stick) list.scrollTop = list.scrollHeight
}

/* ---------------- comments ---------------- */
/** Runs `fn` once `el` is near the viewport (comments cost a yt-dlp run; most people never scroll there). */
let visibleWatch = null
function whenVisible(el, fn) {
  visibleWatch?.disconnect()
  const id = S.watch?.id
  el.innerHTML = '<div class="h-px"></div>'
  visibleWatch = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return
    visibleWatch.disconnect()
    visibleWatch = null
    if (S.watch?.id === id) fn()
  }, { rootMargin: '400px' })
  visibleWatch.observe(el)
}
// An accordion: closed it shows the top comment on one line; open, the whole list.
function syncComments() {
  const list = $('#cmList')
  if (!list) return
  list.hidden = !S.commentsOpen
  $('#cmPreview').hidden = S.commentsOpen
  $('#cmChevron').style.transform = S.commentsOpen ? 'rotate(180deg)' : ''
}
async function loadComments(w) {
  const box = $('#comments')
  box.innerHTML = `<div class="mt-5 rounded-[24px] bg-panel px-4 py-4"><p class="text-[13px] font-medium">Comments</p><div class="mt-1">${SK.comments()}</div></div>`
  const r = await call('tube.comments', { id: w.id }, 90_000)
  if (S.watch?.id !== w.id) return
  if (r.error || !r.items?.length) {
    box.innerHTML = `<div class="mt-5 rounded-[24px] bg-panel px-4 py-4"><p class="text-[13px] font-medium">Comments</p><p class="mt-2 text-[11.5px] text-mute">${r.error ? esc(r.error) : 'No comments.'}</p></div>`
    return
  }
  const one = (c) => `<div class="flex gap-3 py-2.5">
      <div class="shrink-0">${avatar(c.avatar, c.author, 'h-8 w-8 text-[12px]')}</div>
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-x-1.5 text-[11px] text-mute">${c.pinned ? `<span class="flex items-center gap-0.5">${I.pin()}Pinned</span>` : ''}<span class="${c.uploader ? 'rounded-full bg-[#3a3a3a] px-1.5 text-white' : 'text-[#ddd]'}">${esc(c.author)}</span><span>${esc(c.time)}</span></p>
        <p data-act="expandComment" class="clamp4 mt-1 cursor-pointer whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">${esc(c.text)}</p>
        <p class="mt-1.5 flex items-center gap-1.5 text-[11px] text-mute">${I.like(13)}${c.likes ? count(c.likes) : ''}${c.hearted ? `<span class="ml-1.5 text-brand">${I.heart()}</span>` : ''}</p>
      </div></div>`
  const top = r.items[0]
  w.commentCount = r.count ?? r.items.length
  renderLofi()
  box.innerHTML = `<div class="mt-5 rounded-[24px] bg-panel px-4 py-3.5">
    <button data-act="comments" class="flex w-full items-center gap-2 text-left">
      <span class="text-[13px] font-medium">Comments</span><span class="text-[11.5px] text-mute">${r.count != null ? count(r.count) : r.items.length}</span>
      <span id="cmChevron" class="ml-auto text-[#ccc] transition-transform">${I.down(14)}</span>
    </button>
    <button data-act="comments" id="cmPreview" class="mt-2.5 flex w-full items-center gap-2.5 text-left">
      <span class="shrink-0">${avatar(top.avatar, top.author, 'h-6 w-6 text-[10px]')}</span>
      <span class="min-w-0 flex-1 truncate text-[12px] text-[#ddd]">${esc(top.text.replace(/\s+/g, ' '))}</span>
    </button>
    <div id="cmList" class="mt-1 divide-y divide-white/5">${r.items.map(one).join('')}</div>
  </div>`
  syncComments()
  hydrate(box)
}

/* ---------------- picture-in-picture ---------------- */
// Document PiP gets Tube's own controls; the <video> element itself moves into that window, so the
// Media Source stream keeps running. Plain video PiP is the fallback.
let pipWin = null
function pipNote(on) {
  $('#pipNote').hidden = !on
}
async function togglePip() {
  if (pipWin) return pipWin.close()
  if (document.pictureInPictureElement) return void document.exitPictureInPicture()
  if (!S.watch?.video) return toast('Nothing is playing')
  if (video.readyState < 1) return toast('Wait for the video to load')
  if ('documentPictureInPicture' in window) {
    try {
      return await openDocPip()
    } catch (e) {
      log(`document pip: ${e.name}: ${e.message}`)
    }
  }
  try {
    await video.requestPictureInPicture()
  } catch (e) {
    toast(`Picture-in-picture is not available (${e.name})`)
  }
}
async function openDocPip() {
  const ratio = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16
  const w = await (window as any).documentPictureInPicture.requestWindow({ width: 480, height: Math.round(480 * ratio) })
  pipWin = w
  const d = w.document
  for (const sheet of document.styleSheets) {
    try {
      const st = d.createElement('style')
      st.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n')
      d.head.append(st)
    } catch {}
  }
  d.title = S.watch?.title ?? 'Tube'
  d.documentElement.style.background = '#000'
  d.body.className = 'm-0 overflow-hidden bg-black font-sans text-white antialiased'
  d.body.innerHTML = `
    <div id="pstage" class="group relative h-screen w-screen select-none">
      <div id="pctl" class="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <div class="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-black/50"></div>
        <p class="absolute left-3 right-12 top-2.5 truncate text-[12px] font-medium">${esc(S.watch?.title ?? '')}</p>
        <button data-pip="back" class="absolute right-2 top-1.5 grid h-8 w-8 place-items-center rounded-full hover:bg-white/10" title="Back to the panel">${I.pip(16)}</button>
        <div class="absolute inset-0 flex items-center justify-center gap-9">
          <button data-pip="rew" class="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10">${I.rew(20)}</button>
          <button data-pip="toggle" class="grid h-12 w-12 place-items-center rounded-full bg-white/10 hover:bg-white/20">${S.playing ? I.pause(26) : I.play(26)}</button>
          <button data-pip="fwd" class="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10">${I.fwd(20)}</button>
        </div>
        <span id="ptime" class="absolute bottom-4 left-3 text-[10.5px] tabular-nums text-[#ddd]"></span>
        <div id="pbar" class="absolute bottom-0 left-0 right-0 h-3 cursor-pointer"><div class="absolute bottom-0 left-0 right-0 h-[3px] bg-white/25"><div id="pcur" class="h-full w-0 bg-brand"></div></div></div>
      </div>
    </div>`
  video.classList.add('object-contain')
  d.getElementById('pstage').prepend(video)
  pipNote(true)
  const tick = () => {
    const dur = S.watch?.duration || video.duration || 0
    d.getElementById('ptime').textContent = `${clock(video.currentTime)} / ${clock(dur)}`
    d.getElementById('pcur').style.width = dur ? `${(video.currentTime / dur) * 100}%` : '0'
  }
  video.addEventListener('timeupdate', tick)
  tick()
  d.addEventListener('click', (e) => {
    const b = tg(e).closest('[data-pip]') as HTMLElement
    if (!b) return
    const k = b.dataset.pip
    if (k === 'toggle') video.paused ? video.play() : video.pause()
    if (k === 'rew') video.currentTime = Math.max(0, video.currentTime - 10)
    if (k === 'fwd') video.currentTime = Math.min((S.watch?.duration || video.duration) - 0.5, video.currentTime + 10)
    if (k === 'back') w.close()
  })
  d.getElementById('pbar').addEventListener('pointerdown', (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const dur = S.watch?.duration || video.duration
    if (dur) video.currentTime = Math.max(0, Math.min(dur - 0.5, ((e.clientX - r.left) / r.width) * dur))
  })
  d.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'k') (e.preventDefault(), video.paused ? video.play() : video.pause())
    if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5)
    if (e.key === 'ArrowRight') video.currentTime += 5
  })
  w.addEventListener('pagehide', () => {
    video.removeEventListener('timeupdate', tick)
    video.classList.remove('object-contain')
    pipWin = null
    $('#stage').prepend(video)
    pipNote(false)
    renderMini()
  })
}
video.addEventListener('enterpictureinpicture', () => pipNote(true))
video.addEventListener('leavepictureinpicture', () => pipNote(false))

/* Media Session: the PiP window, the Touch Bar and media keys drive the player. */
function mediaSession(w) {
  if (!('mediaSession' in navigator) || !w) return
  const art = imgCache.get(w.thumb)
  navigator.mediaSession.metadata = new MediaMetadata({ title: w.title, artist: w.channel, artwork: art ? [{ src: art, sizes: '320x180', type: 'image/jpeg' }] : [] })
  const h = (a, f) => {
    try {
      navigator.mediaSession.setActionHandler(a, f)
    } catch {}
  }
  h('play', () => video.play())
  h('pause', () => video.pause())
  h('seekbackward', (e) => (video.currentTime = Math.max(0, video.currentTime - (e.seekOffset || 10))))
  h('seekforward', (e) => (video.currentTime += e.seekOffset || 10))
  h('seekto', (e) => (video.currentTime = e.seekTime))
}

// Controls fade while playing; any pointer move brings them back.
let hideTimer
function wake() {
  $('#stage').classList.remove('asleep')
  $('#stage').classList.add('awake')
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => $('#stage').classList.remove('awake'), 2600)
}
$('#stage').addEventListener('pointermove', wake)
$('#stage').addEventListener('pointerdown', wake)
// A press anywhere outside the player puts its controls (and the volume slider) away at once.
document.addEventListener('pointerdown', (e) => {
  const stage = $('#stage')
  if (stage.contains(tg(e)) || tg(e).closest?.('#pmenu')) return
  clearTimeout(hideTimer)
  stage.classList.remove('awake')
  stage.classList.add('asleep')
  if (document.activeElement === $('#volSlider')) $('#volSlider').blur()
}, true)

/* Seek-bar preview: one frame of YouTube's storyboard sheets (5×5 frames of 160×90), fetched through the worker. */
let boardFor = ''
const sheets = new Map<string, Promise<string>>()
function sheet(url: string): Promise<string> {
  if (boardFor !== S.watch?.id) (sheets.clear(), (boardFor = S.watch?.id ?? ''))
  let p = sheets.get(url)
  if (!p) {
    p = call('tube.images', { urls: [url] }).then((r) => {
      const d = r.images?.[url] ?? ''
      if (!d) sheets.delete(url) // failed: try again on the next hover
      return d
    })
    sheets.set(url, p)
  }
  return p
}
let previewWant = -1
const PREVIEW_SCALE = 0.7 // 160×90 frames shown at 112×63
let previewSheet = ''
function showPreview(at: number | null, x: number, width: number) {
  const b = S.watch?.board
  const el = $('#seekPrev')
  if (!b || at == null || S.watch?.live) return void (el.hidden = true)
  const per = b.cols * b.rows
  const i = Math.max(0, Math.floor(at / b.every))
  const s = Math.min(b.sheets.length - 1, Math.floor(i / per))
  const k = Math.min(per - 1, i - s * per)
  el.hidden = false
  const z = PREVIEW_SCALE
  el.style.width = `${b.w * z}px`
  el.style.height = `${b.h * z}px`
  const half = (b.w * z) / 2 + 6
  el.style.left = `${Math.max(half, Math.min(width - half, x))}px`
  previewWant = i
  void sheet(b.sheets[s]).then((d) => {
    if (previewWant !== i || !d) return
    if (previewSheet !== b.sheets[s]) {
      el.style.backgroundImage = `url("${d}")`
      el.style.backgroundSize = `${b.cols * b.w * z}px ${b.rows * b.h * z}px`
      previewSheet = b.sheets[s]
    }
    el.style.backgroundPosition = `-${(k % b.cols) * b.w * z}px -${Math.floor(k / b.cols) * b.h * z}px`
  })
}
// fetch every sheet as soon as the pointer reaches the bar, so scrubbing shows frames without waiting
$('#seekbar').addEventListener('pointerenter', () => {
  for (const u of S.watch?.board?.sheets ?? []) void sheet(u)
})

/** Where a point on the seek bar lands: seconds into the video, or into a live stream's rewind window. */
function seekTimeAt(f: number): number | null {
  if (S.watch?.live) {
    const [a, b] = liveRange()
    return b > a ? a + f * (b - a) : null
  }
  const d = S.watch?.duration || video.duration
  return d && isFinite(d) ? Math.min(d - 0.5, f * d) : null
}
const barFraction = (e) => {
  const r = $('#seekbar').getBoundingClientRect()
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
}
// While dragging, the bar and knob follow the pointer; the video seeks once, on release.
let scrubbing = false
function scrubTo(f: number) {
  const pct = `${f * 100}%`
  $('#pCur').style.width = pct
  placeKnob(pct)
  const at = seekTimeAt(f)
  if (at != null && !S.watch?.live) $('#tCur').textContent = clock(at)
}
function seekFromEvent(e) {
  const t = seekTimeAt(barFraction(e))
  if (t != null) video.currentTime = Math.max(0, t)
}
// Hover: the time under the pointer, kept inside the player's edges.
$('#seekbar').addEventListener('pointermove', (e) => {
  const r = $('#seekbar').getBoundingClientRect()
  const f = barFraction(e)
  const at = seekTimeAt(f)
  const tip = $('#seekTip')
  // live: how far behind the live edge that point is
  const behind = S.watch?.live && at != null ? liveRange()[1] - at : 0
  tip.textContent = at == null ? '' : S.watch?.live ? (behind < 5 ? 'LIVE' : `-${clock(behind)}`) : clock(at)
  const half = tip.offsetWidth / 2 + 6
  tip.style.left = `${Math.max(half, Math.min(r.width - half, f * r.width))}px`
  showPreview(at, f * r.width, r.width)
  $('#pHover').style.width = `${f * 100}%`
})
$('#seekbar').addEventListener('pointerdown', (e) => {
  e.stopPropagation()
  const bar = $('#seekbar')
  bar.setPointerCapture(e.pointerId)
  bar.classList.add('drag')
  scrubbing = true
  scrubTo(barFraction(e))
  const move = (ev) => scrubTo(barFraction(ev))
  const end = (ev) => {
    bar.removeEventListener('pointermove', move)
    bar.removeEventListener('pointerup', end)
    bar.removeEventListener('pointercancel', end)
    bar.classList.remove('drag')
    scrubbing = false
    seekFromEvent(ev)
  }
  bar.addEventListener('pointermove', move)
  bar.addEventListener('pointerup', end)
  bar.addEventListener('pointercancel', end)
})

/* Sticky headers get a hairline once the page scrolls; the channel one turns from clear to solid. */
function syncHeads() {
  const on = window.scrollY > 8
  for (const h of $$('.sticky-head')) h.classList.toggle('scrolled', on)
}
addEventListener('scroll', syncHeads, { passive: true })
new MutationObserver(syncHeads).observe($('#app'), { childList: true, subtree: true })

/* ---------------- navigation ---------------- */
const NAV = [
  ['explore', 'Explore'],
  ['channels', 'Channels'],
  ['home', 'Home'],
  ['library', 'Library'],
  ['settings', 'Settings']
]
const NAV_FOR = { home: 'home', watch: null, explore: 'explore', channels: 'channels', channel: 'channels', library: 'library', settings: 'settings' }
function renderNav() {
  const active = NAV_FOR[S.view] ?? NAV_FOR[S.stack.at(-1)?.view] ?? 'home'
  $('#navItems').innerHTML = NAV.map((n) => {
    if (!n) return '<span></span>'
    const [k, label] = n
    const on = k === active
    return `<button data-nav="${k}" class="${on ? 'text-white' : 'text-[#6f6f6f]'} flex flex-col items-center gap-1">${NAV_ICONS[k][on ? 1 : 0]}<span class="nav-label">${label}</span></button>`
  }).join('')
}

function show(view: string, opts: { focus?: boolean } = {}) {
  S.view = view
  for (const s of $$('.view')) s.classList.toggle('active', s.id === 'v-' + view)
  renderNav()
  renderMini()
  if (view !== 'watch') window.scrollTo(0, 0)
  if (view === 'home') void renderHome()
  if (view === 'explore') void renderExplore(opts.focus)
  if (view === 'channels') void renderChannels(opts.focus)
  if (view === 'channel') void renderChannel()
  if (view === 'library') void renderLibrary()
  if (view === 'settings') renderSettings()
  if (view === 'watch') {
    window.scrollTo(0, 0)
    wake()
  }
}
function go(view, opts = {}) {
  if (S.view !== view || view === 'channel') S.stack.push({ view: S.view, channel: S.channel })
  if (S.stack.length > 30) S.stack.shift()
  show(view, opts)
}
function back() {
  const prev = S.stack.pop()
  if (!prev) return show('home')
  if (prev.channel) S.channel = prev.channel
  show(prev.view)
}

/* ---------------- events ---------------- */
const VIDEO_ID = /(?:youtu\.be\/|v=|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})|^([\w-]{11})$/
const CHANNEL_REF = /youtube\.com\/(@[\w.-]+|channel\/(UC[\w-]{22}))/

document.addEventListener('click', (e) => {
  const t = tg(e).closest('button, [data-act]') as El
  if (!t) return
  const d = t.dataset
  if (d.mq) return (closeMenu(), setQuality(+d.mq))
  if (d.type && S.view === 'explore') {
    S.explore = { ...S.explore, type: d.type }
    return void renderExplore()
  }
  if (d.zoom || d.corners) {
    if (d.zoom) S.theme.layout.zoom = +d.zoom
    if (d.corners) S.theme.layout.corners = d.corners as State['theme']['layout']['corners']
    saveTheme()
    return renderSettings()
  }
  if (d.themePreset) {
    S.theme.preset = d.themePreset
    S.theme.custom = {}
    saveTheme()
    return renderSettings()
  }
  if (d.accent) {
    S.theme.accent = d.accent
    delete S.theme.custom.brand
    saveTheme()
    return renderSettings()
  }
  if (d.reset) return setKnob(d.reset, KNOBS[d.reset].def)
  if (d.step) {
    const k = KNOBS[d.step]
    return setKnob(d.step, Math.min(k.max, Math.max(k.min, +(k.get() + k.step * +d.dir).toFixed(3))))
  }
  if (d.speed) return (closeMenu(), setSpeed(+d.speed))
  if (d.ccKey != null) return (closeMenu(), void pickCaption(d.ccKey))
  if (d.nav) {
    S.stack = []
    return show(d.nav)
  }
  if (d.go) return go(d.go)
  if (d.suggest != null) return runQuery(d.suggest)
  if (d.fillin != null) {
    $('#searchQ').value = d.fillin
    $('#searchQ').focus()
    return void suggestFor(d.fillin)
  }
  if (d.forget != null) {
    S.recent = S.recent.filter((x) => x !== d.forget)
    store.set('recent', S.recent)
    return void suggestFor($('#searchQ').value)
  }
  if (d.browser) return void importLogin({ browser: d.browser })
  if (d.profile != null) {
    const p = S.profiles?.[+d.profile]
    if (p) return void importLogin({ browser: p.browser, profile: p.profile })
  }
  if (d.openProfile != null && S.failedSource) {
    void call('auth.openProfile', S.failedSource)
    S.loginError = 'Sign in to YouTube in the window that opened, then pick the profile again.'
    S.failedSource = null
    return renderSheet()
  }
  if (d.watch) {
    S.queue = t.closest('#plDetail') ? (S.playlistData?.videos ?? null) : null
    const pools = [feedCache?.items, libItems, S.history, S.saved, channelData?.videos, S.playlistData?.videos].flat().filter(Boolean)
    const item = pools.find((v) => v.id === d.watch) ?? { id: d.watch, title: t.querySelector('p')?.textContent ?? '' }
    return void openWatch(item)
  }
  if (d.channel) {
    S.channel = { id: d.channel, tab: 'videos' }
    return go('channel')
  }
  if (d.sub) {
    const pools = [S.subs, channelData ? [channelData] : [], lastChannelResults].flat()
    const w = S.watch
    const ch = pools.find((c) => c.id === d.sub) ?? (w?.channelId === d.sub ? { id: w.channelId, name: w.channel, avatar: w.avatar, subs: w.subs } : { id: d.sub, name: '' })
    const rerender = () => (S.view === 'watch' ? renderWatchInfo() : show(S.view))
    const p = toggleSub(ch)
    rerender()
    void p.then((ok) => {
      if (ok) toast(isSub(ch.id) ? `Subscribed to ${ch.name || 'channel'}` : 'Unsubscribed')
      rerender()
    })
    return
  }
  if (d.chip) {
    S.chip = d.chip
    return void renderHome()
  }
  if (d.cat) {
    S.explore = { ...S.explore, q: '', cat: d.cat }
    return void renderExplore()
  }
  if (d.tab) {
    S.channel = { ...S.channel, tab: d.tab }
    return void renderChannel()
  }
  if (d.quality) {
    S.quality = +d.quality
    store.set('quality', S.quality)
    toast(`Quality: up to ${S.quality}p`)
    return renderSettings()
  }
  if (d.openUrl) return void openUrl(d.openUrl)
  if (d.plToggle) return void togglePlaylist(d.plToggle)
  if (d.upNext) {
    const v = upNextItems().find((x) => x.id === d.upNext)
    if (v) void openWatch(v) // keeps the playlist queue
    return
  }
  if (d.plFor) {
    const v = upNextItems().find((x) => x.id === d.plFor)
    if (!v) return
    S.plFor = { id: v.id, title: v.title, thumb: v.thumb }
    S.plOptions = null
    openSheet('playlist')
    return void loadPlaylistOptions()
  }
  if (d.plOpen) {
    S.openPlaylist = d.plOpen
    return void renderPlaylists($('#v-library'), LIB_TABS())
  }
  if (d.lib) {
    S.libraryTab = d.lib
    return renderLibrary()
  }
  switch (d.act) {
    case 'back':
      return back()
    case 'search':
      return openSearch()
    case 'closeSearch':
      return closeSearch()
    case 'clearSearch':
      $('#searchQ').value = ''
      $('#searchQ').focus()
      return void suggestFor('')
    case 'account':
      return openSheet()
    case 'closeSheet':
      return closeSheet()
    case 'login':
      return void beginLogin()
    case 'relogin':
      S.account = null
      store.set('account', null)
      openSheet()
      return void beginLogin()
    case 'cancelLogin':
      S.login = null
      void call('auth.cancel')
      return renderSheet()
    case 'logout':
      return void logout()
    case 'like':
    case 'dislike': {
      const w = S.watch
      if (!w) return
      if (!S.account) return openSheet()
      const before = { liked: !!w.liked, disliked: !!w.disliked }
      const rating = (d.act === 'like' ? w.liked : w.disliked) ? 'none' : d.act
      w.liked = rating === 'like'
      w.disliked = rating === 'dislike'
      renderWatchInfo()
      void call('yt.like', { id: w.id, rating }).then((r) => {
        if (r.error) {
          Object.assign(w, before)
          toast(r.error)
          renderWatchInfo()
        }
      })
      return
    }
    case 'reload':
      feedCache = null
      return show(S.view)
    case 'toggle':
      if (!S.watch?.video) return
      return void (video.paused ? video.play() : video.pause())
    case 'rew':
      return void (video.currentTime = Math.max(0, video.currentTime - 10))
    case 'fwd':
      return void (video.currentTime = Math.min((S.watch?.duration || video.duration) - 0.5, video.currentTime + 10))
    case 'quality':
      return setQuality(QUALITIES[(QUALITIES.indexOf(S.quality) + 1) % QUALITIES.length])
    case 'settings':
      return menuOpen === 'settings' ? closeMenu() : openMenu('settings')
    case 'cc':
      if (!S.watch?.captions?.length) return toast('No captions for this video')
      return menuOpen === 'cc' ? closeMenu() : openMenu('cc')
    case 'loop':
      S.loop = !S.loop
      video.loop = S.loop
      toast(S.loop ? 'Loop: on' : 'Loop: off')
      return renderTools()
    case 'autoplay':
      S.autoplay = !S.autoplay
      store.set('autoplay', S.autoplay)
      toast(S.autoplay ? 'Autoplay: on' : 'Autoplay: off')
      return renderTools()
    case 'audio':
      S.audioOpen = !S.audioOpen
      renderTools()
      return renderLofi()
    case 'chat':
      S.chatOpen = !S.chatOpen
      $('#chatList').hidden = !S.chatOpen
      $('#chatChevron').style.transform = S.chatOpen ? 'rotate(180deg)' : ''
      return
    case 'comments':
      S.commentsOpen = !S.commentsOpen
      return syncComments()
    case 'expandComment':
      return void t.classList.toggle('clamp4')
    case 'mute':
      if (video.muted || video.volume === 0) {
        video.muted = false
        if (video.volume === 0) video.volume = 0.5
      } else video.muted = true
      return
    case 'desc':
      $('#desc').hidden = !$('#desc').hidden
      return void (t.style.transform = $('#desc').hidden ? '' : 'rotate(180deg)')
    case 'lofi':
      S.lofi = !S.lofi
      store.set('lofi', S.lofi)
      renderTools()
      renderLofi()
      return renderMini()
    case 'lofiPrev': {
      if (video.currentTime > 3 || !S.watch) return void (video.currentTime = 0)
      const prev = S.history.find((v) => v.id !== S.watch.id)
      return void (prev ? openWatch(prev) : (video.currentTime = 0))
    }
    case 'lofiNext': {
      const next = S.watch && nextVideo()
      if (!next) return toast('Nothing up next')
      autoplayed.add(S.watch.id)
      return void openWatch(next)
    }
    case 'shuffle':
      S.shuffle = !S.shuffle
      toast(S.shuffle ? 'Shuffle: on' : 'Shuffle: off')
      return renderLofi()
    case 'lofiLoop':
      S.loop = !S.loop
      video.loop = S.loop
      toast(S.loop ? 'Loop: on' : 'Loop: off')
      renderTools()
      return renderLofi()
    case 'lofiUpNext':
      upNextOpen = !upNextOpen
      return renderLofi()
    case 'lofiArt':
      S.lofiThumb = !S.lofiThumb
      store.set('lofiThumb', S.lofiThumb)
      return renderLofi()
    case 'lofiLyrics':
      return void (lyricsOpen ? closeLyrics() : openLyrics())
    case 'lofiComments':
      return void $('#comments').scrollIntoView({ behavior: 'smooth', block: 'start' })
    case 'playlist':
      if (!S.watch) return
      S.plFor = { id: S.watch.id, title: S.watch.title, thumb: S.watch.thumb }
      S.plOptions = null
      openSheet('playlist')
      return void loadPlaylistOptions()
    case 'plCreate':
      return void createPlaylist()
    case 'plBack':
      S.openPlaylist = null
      return renderLibrary()
    case 'plPlay':
    case 'plShuffle': {
      const pl = S.playlistData
      if (!pl?.videos?.length) return
      S.queue = pl.videos
      S.shuffle = d.act === 'plShuffle'
      const first = S.shuffle ? pl.videos[Math.floor(Math.random() * pl.videos.length)] : pl.videos[0]
      return void openWatch(first)
    }
    case 'plRefresh':
      return void renderPlaylists($('#v-library'), LIB_TABS(), true)
    case 'retrySetup':
      return void callRaw('tube.retrySetup')
    case 'updateSelf':
      return void updateSelf()
    case 'checkUpdates':
      return void checkUpdates()
    case 'retryOnline': {
      t.disabled = true
      return void checkOnline().finally(() => {
        t.disabled = false
        if (offline) toast('Still offline')
      })
    }
    case 'download':
      return void (S.watch && download(S.watch))
    case 'copyLink':
      return void copyText(`https://youtu.be/${S.watch.id}`).then((ok) => toast(ok ? 'Link copied' : 'Could not copy the link', ok ? 'success' : 'error'))
    case 'save':
      S.saved = isSaved(S.watch.id) ? S.saved.filter((v) => v.id !== S.watch.id) : remember(S.saved, S.watch, 500)
      store.set('saved', S.saved)
      return renderWatchInfo()
    case 'pip':
      return void togglePip()
    case 'openWatch':
      if (S.view === 'watch') return void window.scrollTo({ top: 0, behavior: 'smooth' })
      return go('watch')
    case 'closeMini':
      if (pipWin) pipWin.close()
      if (document.pictureInPictureElement) void document.exitPictureInPicture()
      loadSeq++
      player.destroy()
      stopLive()
      chatSeq++
      S.watch = null
      $('#watchInfo').innerHTML = ''
      $('#watchMore').innerHTML = ''
      $('#comments').innerHTML = ''
      $('#tools').innerHTML = ''
      renderLofi()
      syncPlayButtons()
      return renderMini()
    case 'clearHistory':
      S.history = []
      store.set('history', [])
      toast('Watch history cleared')
      return show(S.view)
    case 'togglePart':
      S.theme.layout.hide[d.part] = !t.checked
      return saveTheme()
    case 'resetColors':
      S.theme.custom = {}
      saveTheme()
      return renderSettings()
    case 'toggleCss':
      S.theme.cssOn = t.checked
      saveTheme()
      return toast(S.theme.cssOn ? 'Custom CSS on' : 'Custom CSS off')
    case 'saveCss':
      S.theme.css = $('#cssCode').value
      delete S.drafts.css
      if (!S.theme.cssOn && S.theme.css.trim()) {
        S.theme.cssOn = true
        renderSettings()
      }
      saveTheme()
      return toast('Custom CSS saved')
    case 'templateCss':
      return void saveTemplate('tube-custom.css', 'text/css', CSS_TEMPLATE)
    case 'templateScript':
      return void saveTemplate('tube-custom-script.js', 'text/javascript', SCRIPT_TEMPLATE)
    case 'saveScript':
      S.script.code = $('#scriptCode').value
      delete S.drafts.script
      store.set('script', S.script)
      return toast('Script saved')
    case 'runScript':
      return runUserScript($('#scriptCode').value)
    case 'toggleScriptAuto':
      S.script.auto = t.checked
      store.set('script', S.script)
      return toast(S.script.auto ? 'The script runs when Tube opens' : 'Automatic run off')
    case 'clearRecent':
      S.recent = []
      store.set('recent', [])
      toast('Search history cleared')
      return renderSettings()
  }
})

async function openUrl(url) {
  if (!orca.shell) return toast('Opening links is not available here')
  const r = await orca.shell.openExternal(url).catch(() => null)
  if (!r?.opened) toast('Cancelled')
}

document.addEventListener('submit', (e) => {
  e.preventDefault()
  if (tg(e).id === 'searchForm') return runQuery($('#searchQ').value)
  if (tg(e).id === 'channelsForm') {
    S.channelsQuery = $('#channelsQ').value.trim()
    return void renderChannels()
  }
})
document.addEventListener('change', (e) => {
  if (tg(e).matches?.('[data-up-source]')) return void useUpNextSource(tg(e).value)
  if (tg(e).matches?.('[data-lang]')) return void changeLang(tg(e).value)
  const f = tg(e).dataset.filter
  if (f) {
    S.explore = { ...S.explore, [f]: tg(e).value }
    void renderExplore()
  }
})
document.addEventListener('input', (e) => {
  if (tg(e).id === 'searchQ') {
    $('#searchClear').hidden = !tg(e).value
    clearTimeout(suggestTimer)
    suggestTimer = setTimeout(() => void suggestFor(tg(e).value), 140)
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#searchOverlay').hidden) return closeSearch()
    if (!$('#sheet').hidden) return closeSheet()
  }
  if (e.key === '/' && !tg(e).matches('input, textarea, select')) {
    e.preventDefault()
    return openSearch()
  }
  if (tg(e).matches('input, textarea, select')) return
  if (!S.watch?.video) return
  if (e.key === ' ' || e.key === 'k') {
    e.preventDefault()
    video.paused ? video.play() : video.pause()
  } else if (e.key === 'ArrowLeft' || e.key === 'j') video.currentTime = Math.max(0, video.currentTime - (e.key === 'j' ? 10 : 5))
  else if (e.key === 'ArrowRight' || e.key === 'l') video.currentTime += e.key === 'l' ? 10 : 5
})

/* ---------------- search overlay ---------------- */
let suggestTimer
let suggestSeq = 0
function openSearch() {
  const o = $('#searchOverlay')
  o.hidden = false
  $('#searchQ').value = S.view === 'explore' ? S.explore.q : ''
  $('#searchClear').hidden = !$('#searchQ').value
  requestAnimationFrame(() => o.classList.add('open'))
  setTimeout(() => $('#searchQ').focus(), 30)
  void suggestFor($('#searchQ').value)
}
function closeSearch() {
  const o = $('#searchOverlay')
  o.classList.remove('open')
  $('#searchQ').blur()
  setTimeout(() => (o.hidden = !o.classList.contains('open') || o.hidden), 180)
}
const row = (icon, label, attrs, extra = '') => `<li class="flex items-center">
  <button ${attrs} class="flex min-w-0 flex-1 items-center gap-3.5 px-5 py-3 text-left text-[13.5px] hover:bg-white/5"><span class="shrink-0 text-[#8f8f8f]">${icon}</span><span class="truncate">${esc(label)}</span></button>${extra}</li>`
async function suggestFor(q) {
  const seq = ++suggestSeq
  const box = $('#searchSuggest')
  q = q.trim()
  const recent = S.recent.filter((x) => !q || x.toLowerCase().includes(q.toLowerCase())).slice(0, q ? 3 : 8)
  const recentRows = recent.map((x) =>
    row(I.clock(), x, `data-suggest="${esc(x)}"`, `<button data-forget="${esc(x)}" class="px-4 text-[#777]" aria-label="Remove">${I.close(14)}</button>`)
  )
  const paint = (items) => {
    const rows = [...recentRows, ...items.filter((x) => !recent.includes(x)).map((x) => row(I.search(18), x, `data-suggest="${esc(x)}"`, `<button data-fillin="${esc(x)}" class="px-4 text-[#777]" aria-label="Use">${I.fill()}</button>`))]
    box.innerHTML = rows.join('')
    box.hidden = !rows.length
  }
  paint([])
  if (!q) return
  const r = await call('tube.suggest', { q })
  if (seq === suggestSeq) paint(r.items ?? [])
}
function runQuery(raw) {
  const q = String(raw ?? '').trim()
  if (!q) return
  S.recent = [q, ...S.recent.filter((x) => x !== q)].slice(0, 20)
  store.set('recent', S.recent)
  closeSearch()
  const vid = VIDEO_ID.exec(q)
  if (vid && (q.includes('/') || q.length === 11) && !q.includes(' ')) return void openWatch({ id: vid[1] ?? vid[2] })
  const ch = CHANNEL_REF.exec(q)
  if (ch) {
    S.channel = { id: ch[2] ?? ch[1], tab: 'videos' }
    return go('channel')
  }
  S.explore = { ...S.explore, q }
  if (S.view === 'explore') return void renderExplore()
  go('explore')
}

/* ---------------- account ---------------- */
function openSheet(mode: 'account' | 'playlist' = 'account') {
  S.sheetMode = mode
  if (!S.account && !S.login) S.profiles = null // re-read: profiles may have changed
  const sh = $('#sheet')
  sh.hidden = false
  renderSheet()
  requestAnimationFrame(() => sh.classList.add('open'))
}
function closeSheet() {
  const sh = $('#sheet')
  sh.classList.remove('open')
  setTimeout(() => (sh.hidden = !sh.classList.contains('open') || sh.hidden), 200)
}
const BROWSERS = [
  ['chrome', 'Chrome'],
  ['firefox', 'Firefox'],
  ['vivaldi', 'Vivaldi'],
  ['safari', 'Safari']
]
function renderSheet() {
  if (S.sheetMode === 'playlist') return renderPlaylistSheet()
  const a = S.account
  const box = $('#sheetBody')
  if (a) {
    box.innerHTML = `
      <div class="flex items-center gap-4">
        ${avatar(a.avatar, a.name, 'h-14 w-14 text-[20px]')}
        <div class="min-w-0"><p class="truncate text-[16px] font-medium">${esc(a.name)}</p><p class="truncate text-[12px] text-mute">${esc(a.handle)}</p></div>
      </div>
      <ul class="mt-5 overflow-hidden rounded-[18px] bg-surface text-[13.5px]">
        ${[['watchlater', 'Watch later'], ['liked', 'Liked videos']].map(([k, n]) => `<li><button data-lib-open="${k}" class="w-full px-4 py-3 text-left hover:bg-white/5">${n}</button></li>`).join('')}
        <li><button data-go-channels="1" class="w-full px-4 py-3 text-left hover:bg-white/5">Subscriptions <span class="text-mute">${S.subs.length}</span></button></li>
      </ul>
      <button data-act="logout" class="mt-5 w-full rounded-[16px] border border-line py-3 text-[13px] text-[#ff8a8a]">Sign out</button>`
  } else if (S.login === 'waiting') {
    box.innerHTML = `
      <div class="flex flex-col items-center py-4 text-center">
        <div class="spinner"></div>
        <p class="mt-5 text-[14px] font-medium">Finish signing in in the window that opened</p>
        <p class="mt-2 text-[12px] leading-relaxed text-mute">Once YouTube shows you as signed in, the window closes by itself (it can take up to half a minute), or close it yourself.</p>
        <button data-act="cancelLogin" class="mt-6 rounded-[14px] border border-line px-5 py-2 text-[12.5px]">Cancel</button>
      </div>`
  } else if (S.login === 'importing') {
    box.innerHTML = `<div class="flex flex-col items-center py-6 text-center"><div class="spinner"></div><p class="mt-5 text-[13px]">Reading the browser's YouTube sign-in…</p><p class="mt-2 text-[11.5px] leading-relaxed text-mute">If macOS asks for the keychain password for “Chrome Safe Storage”, enter it and choose Always Allow.</p></div>`
  } else {
    const ps = S.profiles
    const failed = S.failedSource
    box.innerHTML = `
      <p class="text-[18px] font-medium">Sign in to YouTube</p>
      <p class="mt-1.5 text-[12.5px] leading-relaxed text-mute">Pick the browser profile you use YouTube in. Tube copies its YouTube sign-in; macOS asks once for keychain access — choose <b class="text-white">Always Allow</b>.</p>
      ${S.loginError ? `<div class="mt-4 rounded-xl bg-[#2a1515] px-3 py-2.5 text-[12px] text-[#ffb4b4]">${esc(S.loginError)}${
        failed ? `<button data-open-profile class="mt-2 block font-medium text-white underline">Open YouTube in that profile, sign in, then pick it again</button>` : ''
      }</div>` : ''}
      <ul class="no-sb mt-4 max-h-[46vh] overflow-y-auto rounded-[18px] bg-surface">
        ${
          ps === null
            ? `<li class="px-4 py-3">${SK.people(3).replace(/<div class="sk h-8 w-\[88px\][^>]*><\/div>/g, '')}</li>`
            : ps.length
              ? ps
                  .map(
                    (p, i) => `<li><button data-profile="${i}" class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/5">
                ${avatar(p.picture, p.name, 'h-9 w-9 text-[13px]')}
                <span class="min-w-0 flex-1"><span class="block truncate text-[13.5px]">${esc(p.name)}</span><span class="block truncate text-[11px] text-mute">${esc(p.email || 'Not signed in to Google')}</span></span>
                <span class="shrink-0 rounded-md bg-black/30 px-1.5 py-0.5 text-[10px] text-[#bbb]">${esc(p.label)}</span></button></li>`
                  )
                  .join('')
              : `<li class="px-4 py-5 text-center text-[12px] text-mute">No Chrome, Brave, Edge or Vivaldi profiles found.</li>`
        }
      </ul>
      <div class="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11.5px] text-mute">
        <span>Other:</span>
        <button data-browser="firefox" class="underline">Firefox</button>
        <button data-browser="safari" class="underline">Safari</button>
        <button data-act="login" class="underline">Separate sign-in window</button>
      </div>`
    if (ps === null) void loadProfiles()
  }
  hydrate(box)
}
async function finishLogin(r) {
  if (r.account) {
    S.account = r.account
    S.login = null
    S.loginError = ''
    store.set('account', S.account)
    feedCache = null
    S.chip = 'All'
    toast(`Signed in as ${S.account.name}`)
    closeSheet()
    await loadAccountSubs(true)
    show(S.view === 'watch' ? 'home' : S.view)
  } else {
    S.login = null
    S.loginError = r.error || 'Sign-in failed'
    renderSheet()
  }
}
async function beginLogin() {
  S.login = 'waiting'
  S.loginError = ''
  renderSheet()
  // The worker answers when the window is done; a request may wait at most 120 s, so ask again.
  for (;;) {
    const r = await call('auth.login', {}, 120_000)
    if (S.login !== 'waiting') return
    if (r.code === 'timeout') continue
    return finishLogin(r)
  }
}
async function loadProfiles() {
  const r = await call('auth.profiles')
  S.profiles = r.profiles ?? []
  if (!$('#sheet').hidden && !S.account && !S.login) renderSheet()
}
async function importLogin(source) {
  S.login = 'importing'
  S.loginError = ''
  S.failedSource = null
  renderSheet()
  const r = await call('auth.import', source, 120_000)
  // Signed in to Google but never opened YouTube there: offer to open it in that profile.
  if (r.error && source.profile && /Not signed in to YouTube/i.test(r.error)) S.failedSource = source
  finishLogin(r)
}
async function logout() {
  await call('auth.logout')
  S.account = null
  store.set('account', null)
  S.subs = await store.get('subs', [])
  feedCache = null
  S.chip = 'All'
  closeSheet()
  toast('Signed out')
  show(S.view)
}
async function loadAccountSubs(fresh = false) {
  const r = await call('yt.subscriptions', { fresh }, 90_000)
  if (!S.account || r.error) return
  S.subs = r.items ?? []
  store.set('subsAccount', S.subs)
  if (S.view === 'home' || S.view === 'channels') show(S.view)
}
document.addEventListener('click', (e) => {
  const t = tg(e).closest('[data-lib-open], [data-go-channels]') as El
  if (!t) return
  closeSheet()
  if (t.dataset.libOpen) {
    S.libraryTab = t.dataset.libOpen
    S.stack = []
    return show('library')
  }
  S.channelsQuery = ''
  S.stack = []
  show('channels')
})

/* ---------------- static icons + boot ---------------- */
$('[data-act="back"]', $('#stage')).innerHTML = I.down(18)
$('[data-act="rew"]', $('#stage')).innerHTML = I.back10()
$('[data-act="fwd"]', $('#stage')).innerHTML = I.fwd10()
$('#ctlPrev').innerHTML = I.prev(22)
$('#ctlNext').innerHTML = I.next(22)
$('#qualityBtn').innerHTML = I.gear()
$('#pipBtn').innerHTML = I.pip()
$('#stageSearch').innerHTML = I.search(18)
syncCc()
syncPlayButtons()

;(async () => {
  // every stored setting in one round trip instead of one after another
  const keys = { account: null, history: [], saved: [], quality: 720, recent: [], lang: null, theme: {}, script: {}, lofi: false, lofiThumb: false, speed: 1, cc: '', autoplay: true, audio: {}, volume: { v: 1, muted: false }, avatars: {}, subs: [], subsAccount: [], chAvatars: {} }
  const got = Object.fromEntries(await Promise.all(Object.entries(keys).map(async ([k, d]) => [k, await store.get(k, d)])))
  for (const [u, d] of Object.entries(got.avatars ?? {})) (avatarData.set(u, d), imgCache.set(u, d))
  for (const [id, u] of Object.entries(got.chAvatars ?? {})) chAvatars.set(id, u)
  ;({ account: S.account, history: S.history, saved: S.saved, quality: S.quality, recent: S.recent } = got)
  // first run: start in Orca's own language (and remember it); afterwards the setting decides
  S.lang = got.lang
  if (!S.lang) {
    S.lang = orcaLang()
    store.set('lang', S.lang)
  }
  await setLang(S.lang)
  startI18n()
  S.theme = { ...S.theme, ...got.theme }
  S.theme.custom ??= {}
  S.theme.layout = { zoom: 100, corners: 'round', hide: {}, ...S.theme.layout }
  S.theme.layout.hide ??= {}
  applyTheme()
  S.script = { ...S.script, ...got.script }
  if (S.script.auto && S.script.code.trim()) runUserScript(S.script.code)
  ;({ lofi: S.lofi, lofiThumb: S.lofiThumb, speed: S.speed, cc: S.cc, autoplay: S.autoplay } = got)
  Object.assign(S, (({ boost = 1, semis = 0, hz = 440 }) => ({ boost, semis, hz }))(got.audio ?? {}))
  video.volume = got.volume.v
  video.muted = got.volume.muted
  video.defaultPlaybackRate = S.speed
  syncVolume()
  S.subs = S.account ? got.subsAccount : got.subs
  // Check the session in the background; the cached account paints first.
  void call('auth.account').then(async (r) => {
    if (r.error && !SIGNED_OUT.test(r.error)) return // offline etc.: keep the cached account
    const was = !!S.account
    S.account = r.account ?? null
    store.set('account', S.account)
    if (S.account) await loadAccountSubs()
    else if (was) {
      S.subs = await store.get('subs', [])
      toast('Signed out of YouTube')
    }
    if (was !== !!S.account || S.view === 'home') {
      feedCache = null
      show(S.view)
    }
  })
  // From the worker's tube.remote: open a video, seek, or report the player state to the log.
  type Remote = { id?: string; t?: number; status?: boolean; view?: string; channel?: string; q?: string; ui?: string; text?: string }
  orca.plugin.on('tube.open', (payload) => {
    const { id, t, status, view, channel, q, ui, text } = payload as Remote
    if (ui === 'search') {
      openSearch()
      if (text) {
        $('#searchQ').value = text
        $('#searchClear').hidden = false
        void suggestFor(text)
      }
      return
    }
    if (ui === 'account') return openSheet()
    if (ui === 'pause') return void video.pause()
    if (ui === 'play') return void video.play()
    if (ui === 'settings' || ui === 'cc') return (wake(), openMenu(ui))
    if (ui === 'captions') return void pickCaption(text ?? '')
    if (ui === 'click') {
      const el = document.querySelector<HTMLElement>(text ?? '')
      log(`remote click ${text}: ${el ? el.tagName : 'not found'}`)
      return void el?.click()
    }
    if (ui === 'offline') return void setOffline(text !== 'off')
    if (ui === 'lang') return void changeLang(text || 'auto')
    if (ui === 'upnext') return void useUpNextSource(text ?? '')
    if (ui === 'scroll') return void window.scrollTo(0, +(text ?? 0))
    if (ui === 'audio') return ((S.audioOpen = !S.audioOpen), renderTools())
    if (ui === 'knob') {
      const [k, v] = String(text).split('=')
      if (KNOBS[k]) setKnob(k, +v)
      return void setTimeout(() => log(`audio graph=${!!graph} pitch=${!!graph?.pitch} ctx=${graph?.ctx.state} boost=${S.boost} semis=${S.semis} hz=${S.hz}`), 1500)
    }
    if (ui === 'close') return closeSearch(), closeSheet()
    if (channel) {
      S.channel = { id: channel, tab: 'videos' }
      return go('channel')
    }
    if (q != null) S.explore = { ...S.explore, q }
    if (view) {
      S.stack = []
      return show(view)
    }
    if (status) {
      const b = video.buffered
      const ranges = Array.from({ length: b.length }, (_, i) => `${b.start(i).toFixed(1)}-${b.end(i).toFixed(1)}`).join(',')
      return log(`state ${S.watch?.id ?? '-'} t=${video.currentTime.toFixed(1)} paused=${video.paused} ready=${video.readyState} buffered=${ranges} audioBytes=${(video as any).webkitAudioDecodedByteCount ?? "?"} caps=${S.watch?.captions?.length ?? "-"} cc=${activeCaption?.key ?? "-"} tracks=${video.textTracks.length} live=${!!hls} level=${hls?.currentLevel ?? "-"} err=${S.watch?.error ?? ''}`)
    }
    if (id && id !== S.watch?.id) return void openWatch({ id }, { startAt: t ?? 0 })
    if (t != null) video.currentTime = t
  })
  await waitForSetup()
  const st = await call('tube.status')
  S.ytdlp = st.ytdlp
  show('home')
  void noticeNewVersion()
})()
