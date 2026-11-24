# Tube

YouTube in [Orca](https://github.com/stablyai/orca)'s right sidebar: browse, search and watch
without leaving your workspace.

- **Watch**: videos, Shorts and live streams; quality and speed, captions, picture-in-picture,
  download to `~/Downloads`, loop and autoplay, audio tools (gain, transpose, pitch).
- **Lofi**: a music-player face for the watch page, with a visualizer, lyrics (captions) and Up Next.
- **Browse**: Home, Explore (videos / channels / Shorts, sorted and filtered by date and length),
  channels, comments and live chat.
- **Your account** (optional): sign in through a browser profile you already use to get your
  recommendations, subscriptions, history, likes and playlists, and to like, subscribe and add to
  playlists.
- **Make it yours**: themes, accent colours, layout, custom CSS and scripts; English and Japanese.

## Requirements

- macOS (sign-in reads a Chromium browser profile through the keychain).
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), installed with its extras:
  `pipx install 'yt-dlp[default]'` (or `uv tool install 'yt-dlp[default]'`). Old versions get
  HTTP 403 from YouTube; upgrade if playback stops.
- `node` or `deno` on the PATH, for yt-dlp's signature solving.

Tools are looked up in `~/.local/bin`, `~/.nix-profile/bin`, Homebrew and `/usr/local/bin`.

## How it works

The panel (`panel/`) is plain HTML/JS; the worker (`src/`) makes every network call, because the
panel's frame may only load `self`, `data:` and `blob:`.

- Lists come from `yt-dlp --flat-playlist -J`; signed-in reads and writes use YouTube's own web API
  with the session copied from your browser.
- Video plays through Media Source: the worker reads the DASH streams (H.264 + AAC) with HTTP Range
  and the panel uses the `sidx` index to seek. Live streams play through hls.js, fed by the worker.
- Images arrive as bytes from the worker and are kept in a small cache; channel avatars and settings
  live in the plugin's own storage.

## Develop

```sh
orca plugin dev load . --approve <fingerprint>   # Orca prints the fingerprint
./scripts/build-css.sh                           # after changing classes in panel/*.{html,js}
orca plugin check . --json
orca plugin dev request local.tube tube.remote --data '{"id":"<videoId>"}'   # open a video
orca plugin dev request local.tube tube.remote --data '{"status":true}'       # state -> orca plugin logs
```

Translations live in `panel/i18n/`: copy `ja.js` to `<code>.js`, translate the values and add the
language to `LANGS` in `i18n.js`.

## Third-party

`panel/vendor/hls.min.js` is [hls.js](https://github.com/video-dev/hls.js) 1.5.17 (Apache-2.0).
