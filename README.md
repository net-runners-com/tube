# Tube

A YouTube client in Orca's right sidebar. The panel is plain HTML/JS (`panel/`); the worker
(`src/`) does every network call.

- Lists (search, channels, channel tabs, subscription feed) come from `yt-dlp --flat-playlist -J`.
- Thumbnails and avatars are fetched by the worker and handed over as `data:` URLs — the panel's
  frame CSP only allows `'self' data: blob:` for images and media, and no iframes.
- Video plays through Media Source: the worker reads the DASH streams (H.264 + AAC, fragmented
  MP4) with HTTP Range in 720 KB slices; the panel keeps ~40 s buffered and uses the `sidx` index
  to seek straight to the right byte offset.
- Subscriptions, history, saved videos and the quality cap live in the plugin's own storage. No
  Google account is used.

## Requirements

- `yt-dlp` (recent: old versions get HTTP 403 after the first ~10 MB) and `node` (or `deno`) for
  its signature solving. Looked up in `~/.local/bin`, `~/.nix-profile/bin`, Homebrew and `/usr/local/bin`.
- Live streams are not playable yet (HLS).

## Develop

```sh
orca plugin dev load . --approve <fingerprint>   # Orca prints the fingerprint
./scripts/build-css.sh                           # after changing classes in panel/*.{html,js}
orca plugin dev request local.tube tube.remote --data '{"id":"<videoId>"}'   # open a video
orca plugin dev request local.tube tube.remote --data '{"t":120}'             # seek
orca plugin dev request local.tube tube.remote --data '{"status":true}'       # state -> orca plugin logs
```
