// YouTube live chat, read anonymously: the popout page gives the first messages and a continuation,
// then youtubei `live_chat/get_live_chat` returns what arrived since. Runs in the worker (Node).
import * as https from 'node:https'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export type ChatItem = {
  id: string
  author: string
  text: string
  /** owner / moderator / member / verified, else '' */
  role: string
  /** Super Chat / Super Sticker amount, e.g. "¥500" */
  amount?: string
  /** Super Chat background, CSS color */
  color?: string
  /** membership join / milestone */
  member?: boolean
}
export type ChatPage = { cont: string | null; items: ChatItem[] }

function request(url: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: body ? 'POST' : 'GET',
        timeout: 15_000,
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', ...(body ? { 'Content-Type': 'application/json' } : {}) }
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (d: Buffer) => parts.push(d))
        res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(parts).toString('utf8')) : reject(new Error(`chat ${res.statusCode}`))))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error('chat timeout')))
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

const runs = (m: any): string =>
  (m?.runs ?? [])
    .map((r: any) => r.text ?? (r.emoji ? (r.emoji.isCustomEmoji ? (r.emoji.shortcuts?.[0] ?? '') : (r.emoji.emojiId ?? '')) : ''))
    .join('') || (m?.simpleText ?? '')

const argb = (n: number | undefined) => (n == null ? undefined : `#${(n & 0xffffff).toString(16).padStart(6, '0')}`)

function role(badges: any[] | undefined): string {
  for (const b of badges ?? []) {
    const r = b.liveChatAuthorBadgeRenderer
    const icon = r?.icon?.iconType
    if (icon === 'OWNER') return 'owner'
    if (icon === 'MODERATOR') return 'moderator'
    if (r?.customThumbnail) return 'member'
    if (icon === 'VERIFIED') return 'verified'
  }
  return ''
}

/** POST youtubei/v1/<endpoint> without signing in (search, live chat). */
export const innertubeAnon = (endpoint: string, body: unknown) => request(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, body)

/** The chat messages in a list of actions; other actions (pins, deletions, polls) are skipped. */
export function parseActions(actions: any[] | undefined): ChatItem[] {
  const out: ChatItem[] = []
  for (const a of actions ?? []) {
    const it = a.addChatItemAction?.item
    if (!it) continue
    const r = it.liveChatTextMessageRenderer ?? it.liveChatPaidMessageRenderer ?? it.liveChatPaidStickerRenderer ?? it.liveChatMembershipItemRenderer
    if (!r) continue
    const base = { id: String(r.id ?? ''), author: r.authorName?.simpleText ?? '', role: role(r.authorBadges) }
    if (it.liveChatTextMessageRenderer) out.push({ ...base, text: runs(r.message) })
    else if (it.liveChatPaidMessageRenderer || it.liveChatPaidStickerRenderer)
      out.push({ ...base, text: runs(r.message), amount: r.purchaseAmountText?.simpleText ?? '', color: argb(r.bodyBackgroundColor ?? r.backgroundColor) })
    else out.push({ ...base, text: [runs(r.headerPrimaryText), runs(r.headerSubtext), runs(r.message)].filter(Boolean).join(' · '), member: true })
  }
  return out
}

const continuation = (list: any[] | undefined): string | null => {
  const c = list?.[0]
  const d = c && (c.invalidationContinuationData ?? c.timedContinuationData ?? c.reloadContinuationData ?? c.liveChatReplayContinuationData)
  return d?.continuation ?? null
}

/** First page: the newest messages and where to continue. Throws when the video has no live chat. */
export async function chatStart(videoId: string): Promise<ChatPage & { version: string }> {
  const html = await request(`https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}&is_popout=1`)
  const m = /(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\});\s*<\/script>/s.exec(html)
  const version = /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] ?? '2.20250101.00.00'
  const lc = m ? JSON.parse(m[1]).contents?.liveChatRenderer : null
  if (!lc) throw new Error('Live chat is off for this stream')
  return { version, cont: continuation(lc.continuations), items: parseActions(lc.actions) }
}

/** Messages since `cont`. */
export async function chatPoll(cont: string, version: string): Promise<ChatPage> {
  const j = JSON.parse(
    await request('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false', {
      context: { client: { clientName: 'WEB', clientVersion: version, hl: 'ja' } },
      continuation: cont
    })
  )
  const lcc = j.continuationContents?.liveChatContinuation
  return { cont: continuation(lcc?.continuations) ?? cont, items: parseActions(lcc?.actions) }
}
