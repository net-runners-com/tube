// Shapes the panel works with. Lists and the watch page come from the worker (src/yt.ts), so the
// video/channel types are the worker's own; the rest is panel state.
import type { Caption, Channel, ChannelPage, Track, Video, Watch } from '../../src/shapes'

export type { Caption, Channel, ChannelPage, Track, Video, Watch }

/** A video as the panel keeps it (history, saved, queues): the worker's shape plus flags it sets. */
export type Item = Partial<Video> & { id: string; title?: string; thumb?: string; short?: boolean; viewsText?: string }

/** The watch page's video: what `tube.watch` returned, plus what the panel learns later. */
export type WatchState = Partial<Watch> & {
  id: string
  loading?: boolean
  error?: string
  liked?: boolean
  disliked?: boolean
  commentCount?: number
}

export type Account = { name: string; handle: string; avatar: string }
export type Sub = { kind?: 'channel'; id: string; name: string; avatar: string; subs: number | null }
export type PlaylistOption = { id: string; title: string; has: boolean; privacy: string }
export type Theme = {
  preset: string
  accent: string
  custom: Record<string, string>
  css: string
  cssOn: boolean
  layout: { zoom: number; corners: 'round' | 'small' | 'square'; hide: Record<string, boolean> }
}

export type State = {
  view: string
  stack: { view: string; channel: State['channel'] }[]
  subs: Sub[]
  history: Item[]
  saved: Item[]
  quality: number
  volume: number
  muted: boolean
  speed: number
  /** preferred caption language ('' = off) */
  cc: string
  loop: boolean
  autoplay: boolean
  audioOpen: boolean
  commentsOpen: boolean
  lang: string
  lofi: boolean
  /** the Lofi card shows the thumbnail instead of the video */
  lofiThumb: boolean
  shuffle: boolean
  theme: Theme
  script: { code: string; auto: boolean }
  /** unsaved CSS / script text, so re-rendering Settings keeps it */
  drafts: { css?: string; script?: string }
  chatOpen: boolean
  /** gain after the element volume (1 = 100%) */
  boost: number
  /** transpose, semitones */
  semis: number
  /** reference pitch */
  hz: number
  chip: string
  explore: { q: string; cat: string; sort: string; type: string; date: string; length: string }
  channelsQuery: string
  channel: { id: string; tab: string } | null
  watch: WatchState | null
  playing: boolean
  account: Account | null
  /** 'waiting' | 'importing' while signing in */
  login: string | null
  loginError: string
  /** recent searches */
  recent: string[]
  /** browser profiles for sign-in (loaded when the sheet opens) */
  profiles: any[] | null
  failedSource: any
  ytdlp?: string | null
  libraryTab?: string
  sheetMode?: 'account' | 'playlist'
  /** the playlist "Play all" / Up Next is going through */
  queue?: Item[] | null
  playlistData?: { id: string; title: string; videos: Item[] } | null
  openPlaylist?: string | null
  plFor?: { id: string; title: string; thumb: string } | null
  plOptions?: PlaylistOption[] | { error: string } | null
}

/** Orca hands HTML panels a global `orca` (see orca-frame); hls.js puts `Hls` on window. */
declare global {
  // eslint-disable-next-line no-var
  var Hls: any
  interface Window {
    __tubeScriptError?: (e: unknown) => void
  }
}
