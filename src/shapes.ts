// Shapes shared by the worker and the panel. No Node imports here: the panel's typecheck reads it.

export type Video = {
  kind: 'video'
  id: string
  title: string
  channel: string
  channelId: string
  duration: number | null
  views: number | null
  live: boolean
  thumb: string
  /** a Short: shown as a vertical card */
  short?: boolean
  /** YouTube's own view text when there is no count (Shorts search) */
  viewsText?: string
}

export type Channel = {
  kind: 'channel'
  id: string
  name: string
  handle: string
  subs: number | null
  avatar: string
}

export type Item = Video | Channel

export type ChannelPage = Channel & {
  banner: string
  description: string
  videos: Video[]
}

export type Track = { key: string; mime: string; size: number }

export type Watch = {
  id: string
  title: string
  description: string
  channel: string
  channelId: string
  avatar: string
  subs: number | null
  views: number | null
  likes: number | null
  duration: number
  uploaded: string
  thumb: string
  live: boolean
  height: number
  video: Track | null
  audio: Track | null
  captions: Caption[]
  /** Live streams: key for `tube.hls` (the HLS master playlist stays in the worker). */
  hls: string | null
}

/** A caption track the panel can ask for (`tube.captions`); the URL stays in the worker. */
export type Caption = { key: string; lang: string; name: string; auto: boolean; /** auto captions in the spoken language (not machine-translated) */ orig?: boolean }

export type Cue = [start: number, end: number, text: string]
