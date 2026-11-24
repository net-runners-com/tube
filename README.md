<div align="center">

<img src="assets/icon.png" width="112" alt="Tube icon">

# Tube

**YouTube in Orca's sidebar.**<br>
Watch, listen and browse without leaving your workspace.

[![Version](https://img.shields.io/github/v/tag/net-runners-com/tube?label=version&color=e3262b)](https://github.com/net-runners-com/tube/tags)
[![Orca plugin](https://img.shields.io/badge/Orca-plugin-1c1c1c)](https://orca.dev/plugins/net-runners-com/tube)
[![License: MIT](https://img.shields.io/badge/license-MIT-444)](LICENSE)

<img src="assets/cover.jpg" alt="Tube in Orca: Home, Lofi mode and Shorts" width="100%">

</div>

<img src="assets/features.jpg" alt="Everything in Tube" width="100%">

---

## Why Tube

A tutorial, a talk or a playlist next to your code, without a browser tab to lose and without
leaving Orca. Tube is a full YouTube client in the right sidebar: its own interface, no embedded
youtube.com page, no ads in the feed.

## Features

### 🏠 Your YouTube, next to your code

<img src="assets/home.jpg" alt="Home and the watch page" width="100%">

- **Home** with your recommendations and subscriptions — or trending videos when signed out.
- **Channels** you follow, each channel's Videos, Shorts, Live and About.
- **Library**: history, your YouTube playlists, Watch later, liked and saved videos.
- **Sign in** with a browser profile you already use YouTube in. Optional: everything else works
  signed out.

### 🎧 Lofi mode — a music player for long sessions

<img src="assets/lofi.jpg" alt="Lofi mode with the visualizer and Up Next" width="100%">

- The video in a floating card over a background tinted from its thumbnail.
- A **3D visualizer** that moves with the music, in the video's own colors.
- **Lyrics**: the captions, line by line, under the video.
- **Up Next** from related videos or any of your playlists, with shuffle and repeat.

### 🔎 Videos, channels and Shorts

<img src="assets/explore.jpg" alt="Explore with Shorts" width="100%">

- Search videos, channels and Shorts; sort by relevance, popularity or date.
- Filter by upload date (last hour … this year) and length (under 3 min, 3–20, over 20).
- Categories: trending, music, gaming, learning, news, sports and more.

### ▶️ Everything under the player

<img src="assets/watch.jpg" alt="The watch page" width="100%">

- Quality up to 1080p, speed, **captions** (uploaded and automatic).
- **Live streams** with their **live chat**.
- Like, subscribe, **add to your playlists**, copy the link, **download** to `~/Downloads`.
- **Comments**, more from the channel, autoplay and loop.
- **Audio tools**: boost the volume, transpose by semitones, retune the reference pitch, change
  the speed without changing the pitch.
- A **mini player** that keeps playing while you browse.

### 🪟 Picture-in-picture

<img src="assets/pip.jpg" alt="A floating picture-in-picture window over Tube" width="100%">

- Pop the video out into a **floating window** that stays on top of every app, and keep watching
  while you code in Orca or anywhere else.
- Controls right on the window: play / pause, ±10 s and the seek bar.
- Works from the player, the mini player and Lofi mode; one click brings the video back.

### 🎨 Make it yours

<img src="assets/themes.jpg" alt="Theme and layout settings" width="100%">

- Six themes, seven accent colors, or your own colors.
- Layout: size, corners, and the parts of the page you'd rather hide.
- **Custom CSS** and **custom scripts** for anything else.
- In Orca's languages: English, 简体中文, 繁體中文, 한국어, 日本語, Español, Français, Português, Русский, Türkçe and Deutsch — following Orca's own setting.

## Install

In Orca: **Settings → Plugins**, find **Tube** in the community catalog and install it.

Or from a terminal:

```sh
orca plugin install net-runners-com/tube
```

**That's all.** Tube runs on macOS, Windows and Linux. The first time it opens, it downloads the
video tools it needs (yt-dlp, Node.js and ffmpeg) into its own folder — about half a minute,
verified file by file — so there is nothing else to install.

To update, use **Settings ▸ Updates** in Tube, or Orca's plugin settings. The tools inside come
with each Tube version.

## Tips

- **Signing in**: open the account button (top right) and pick the browser profile you use
  YouTube in. On macOS the system asks once for keychain access to read that browser's sign-in.
- **Playback stops with an error?** Update Tube (Settings ▸ Updates); new versions bring fixed video tools.
- **Downloads** go to your Downloads folder as MP4, at the quality set in Settings.
- **Offline**: Tube shows a notice and picks up again on its own when you're back online.

## Privacy

Tube talks to YouTube directly from your computer. Your sign-in stays on your machine, in Tube's
own storage; nothing is sent anywhere else.

## License

[MIT](LICENSE) © net-runners-com
