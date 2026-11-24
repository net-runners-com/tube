// Media Source player fed by the worker. Each track is a fragmented MP4 that the worker reads with
// HTTP Range; the sidx box at its head maps time to byte offsets, so seeking jumps straight there.

const AHEAD = 40 // seconds buffered ahead of the playhead before we stop asking
const BEHIND = 30 // seconds kept behind it
const TICK = 400

export function fromBase64(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const fourcc = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])

/**
 * Reads ftyp/moov/sidx from the head of a stream.
 * Returns { initEnd, segments } , { need } when more bytes are needed, or null when there is no index.
 */
export function parseHead(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let o = 0
  let initEnd = 0
  while (o + 8 <= u8.length) {
    let size = dv.getUint32(o)
    const type = fourcc(u8, o + 4)
    if (size === 1) size = Number(dv.getBigUint64(o + 8))
    if (size < 8) return null
    if (type === 'moov') initEnd = o + size
    if (type === 'sidx') {
      if (o + size > u8.length) return { need: o + size }
      return { initEnd, segments: parseSidx(dv, o, size) }
    }
    if (type === 'moof' || type === 'mdat') return initEnd ? { initEnd, segments: null, mediaStart: o } : null
    o += size
  }
  return { need: o + 64 * 1024 }
}

function parseSidx(dv, o, size) {
  let p = o + 8
  const version = dv.getUint8(p)
  p += 8 // version+flags, reference_ID
  const timescale = dv.getUint32(p)
  p += 4
  let ept, first
  if (version === 0) {
    ept = dv.getUint32(p)
    first = dv.getUint32(p + 4)
    p += 8
  } else {
    ept = Number(dv.getBigUint64(p))
    first = Number(dv.getBigUint64(p + 8))
    p += 16
  }
  p += 2
  const count = dv.getUint16(p)
  p += 2
  const segs = []
  let offset = o + size + first
  let t = ept / timescale
  for (let i = 0; i < count; i++) {
    const bytes = dv.getUint32(p) & 0x7fffffff
    const dur = dv.getUint32(p + 4) / timescale
    p += 12
    segs.push({ start: offset, end: offset + bytes, t0: t, t1: t + dur })
    offset += bytes
    t += dur
  }
  return segs
}

function rangeAt(sb, t) {
  const b = sb.buffered
  for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.25 && t <= b.end(i)) return [b.start(i), b.end(i)]
  return null
}

const once = (target, ev) => new Promise((r) => target.addEventListener(ev, r, { once: true }))

type Request = (method: string, input?: any, timeoutMs?: number) => Promise<any>
type Hooks = { onError?: (e: Error) => void; onBuffer?: (end: number) => void; /** seconds to buffer ahead (default 40) */ ahead?: number }

export class Player {
  video: HTMLVideoElement
  request: Request
  onError: (e: Error) => void
  onBuffer: (end: number) => void
  tracks: any[]
  alive: boolean
  reported = false
  ms: MediaSource | null = null
  url = ''
  timer: ReturnType<typeof setInterval> | null = null
  onSeeking: (() => void) | null = null
  ahead: number

  constructor(video: HTMLVideoElement, request: Request, { onError, onBuffer, ahead = AHEAD }: Hooks = {}) {
    this.ahead = ahead
    this.video = video
    this.request = request
    this.onError = onError ?? (() => {})
    this.onBuffer = onBuffer ?? (() => {})
    this.tracks = []
    this.alive = false
  }

  async load(watch, startAt = 0) {
    this.destroy()
    this.reported = false
    const kinds = [watch.video, watch.audio].filter(Boolean)
    for (const t of kinds) {
      if (!MediaSource.isTypeSupported(t.mime)) throw new Error(`This Orca cannot play ${t.mime}`)
    }
    const ms = new MediaSource()
    this.ms = ms
    this.alive = true
    const url = URL.createObjectURL(ms)
    this.url = url
    this.video.src = url
    await once(ms, 'sourceopen')
    if (!this.alive || this.ms !== ms) return
    ms.duration = watch.duration || Infinity
    this.tracks = kinds.map((t) => ({
      ...t,
      sb: ms.addSourceBuffer(t.mime),
      pos: 0,
      gen: 0,
      busy: false,
      done: false,
      reset: false,
      segments: null
    }))
    await Promise.all(this.tracks.map((tr) => this.head(tr)))
    if (!this.alive) return
    if (startAt > 0) this.video.currentTime = startAt
    this.onSeeking = () => this.seek(this.video.currentTime)
    this.video.addEventListener('seeking', this.onSeeking)
    this.timer = setInterval(() => this.tick(), TICK)
    this.tick()
  }

  async fetch(tr, start: number, len?: number) {
    const input: { key: string; start: number; len?: number } = { key: tr.key, start }
    if (len) input.len = len // undefined is not JSON: the bridge refuses it
    const r = await this.request('tube.chunk', input)
    if (r.error) throw new Error(r.error)
    return { bytes: fromBase64(r.b64), eof: r.eof }
  }

  /** Init segment + index, then whatever media the first slice already holds. */
  async head(tr) {
    let { bytes, eof } = await this.fetch(tr, 0)
    let head = parseHead(bytes)
    while (head?.need && !eof) {
      const more = await this.fetch(tr, bytes.length, head.need - bytes.length + 1)
      const joined = new Uint8Array(bytes.length + more.bytes.length)
      joined.set(bytes)
      joined.set(more.bytes, bytes.length)
      bytes = joined
      eof = more.eof
      head = parseHead(bytes)
    }
    if (!head || head.need) throw new Error('Stream has no MP4 header')
    tr.segments = head.segments
    const mediaStart = head.segments?.[0]?.start ?? head.mediaStart ?? head.initEnd
    tr.init = bytes.slice(0, head.initEnd)
    await this.append(tr, tr.init)
    await this.append(tr, bytes.subarray(mediaStart))
    tr.pos = bytes.length
    tr.done = eof
  }

  async append(tr, bytes) {
    if (!bytes.length) return
    for (let attempt = 0; ; attempt++) {
      while (tr.sb.updating) await once(tr.sb, 'updateend')
      try {
        tr.sb.appendBuffer(bytes)
        await once(tr.sb, 'updateend')
        return
      } catch (e) {
        if (e.name !== 'QuotaExceededError' || attempt > 2) throw e
        await this.evict(tr, 5)
      }
    }
  }

  async evict(tr, keep = BEHIND) {
    const cut = this.video.currentTime - keep
    const b = tr.sb.buffered
    if (!b.length || b.start(0) >= cut) return
    while (tr.sb.updating) await once(tr.sb, 'updateend')
    tr.sb.remove(0, cut)
    await once(tr.sb, 'updateend')
  }

  seek(t) {
    for (const tr of this.tracks) {
      if (rangeAt(tr.sb, t)) continue
      if (!tr.segments) continue // no index: keep reading in order
      let i = tr.segments.findIndex((s) => t < s.t1)
      if (i < 0) i = tr.segments.length - 1
      tr.gen++
      tr.busy = false
      tr.pos = tr.segments[i].start
      tr.done = false
      tr.reset = true
    }
    this.tick()
  }

  tick() {
    if (!this.alive) return
    for (const tr of this.tracks) void this.pump(tr).catch((e) => this.failed(tr, e))
    const v = this.video
    const ahead = Math.min(...this.tracks.map((tr) => (rangeAt(tr.sb, v.currentTime)?.[1] ?? v.currentTime) - v.currentTime))
    this.onBuffer(v.currentTime + Math.max(0, ahead))
    if (this.ms.readyState === 'open' && this.tracks.every((tr) => tr.done && !tr.sb.updating && !tr.busy)) {
      try {
        this.ms.endOfStream()
      } catch {}
    }
  }

  async pump(tr) {
    if (tr.busy || tr.done || tr.stalled || Date.now() < (tr.retryAt ?? 0)) return
    const t = this.video.currentTime
    const end = rangeAt(tr.sb, t)?.[1] ?? t
    if (end - t > this.ahead && !tr.reset) return
    const gen = tr.gen
    tr.busy = true
    try {
      if (tr.reset) {
        while (tr.sb.updating) await once(tr.sb, 'updateend')
        if (this.ms.readyState === 'open') tr.sb.abort()
        tr.reset = false
      }
      await this.evict(tr)
      const { bytes, eof } = await this.fetch(tr, tr.pos)
      if (gen !== tr.gen || !this.alive) return
      await this.append(tr, bytes)
      if (gen !== tr.gen) return
      tr.pos += bytes.length
      tr.done = eof
      tr.failures = 0
    } finally {
      if (gen === tr.gen) tr.busy = false
    }
  }

  /** Backs off 1s, 2s, 4s; after the third failure in a row the track stops and the app decides. */
  failed(tr, e) {
    if (!this.alive) return
    tr.failures = (tr.failures ?? 0) + 1
    tr.retryAt = Date.now() + 1000 * 2 ** (tr.failures - 1)
    if (tr.failures >= 3 || /expired/.test(e?.message)) {
      tr.stalled = true
      if (!this.reported) {
        this.reported = true
        this.onError(e)
      }
    }
  }

  destroy() {
    this.alive = false
    clearInterval(this.timer)
    if (this.onSeeking) this.video.removeEventListener('seeking', this.onSeeking)
    for (const tr of this.tracks) tr.gen++
    this.tracks = []
    if (this.url) {
      this.video.removeAttribute('src')
      this.video.load()
      URL.revokeObjectURL(this.url)
      this.url = null
    }
  }
}
