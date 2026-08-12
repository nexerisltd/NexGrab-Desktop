# NexGrab

**A beautifully simple, seriously capable YouTube downloader.**
Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) · Desktop app (Electron) · Minimalist UI

- **Name:** NexGrab
- **Author:** NexApp
- **Version:** 0.0.1

---

## ✨ Features

- 🎬 **Video downloads up to 4K/8K** — pick from every resolution yt-dlp can see for that video
- 🎧 **Audio-only extraction** — MP3, M4A, Opus, FLAC (lossless), WAV, with selectable bitrate
- 📃 **Full playlist support** — fetch an entire playlist, tick the videos you actually want, download in bulk
- 🧵 **Batch queue** with configurable **concurrent downloads** (1–5 at once)
- 📊 **Live progress** — percentage, speed, ETA, and merge status per item, right in the queue
- ⏱️ **Clip / trim downloads** — grab just a section of a video (start–end timestamps)
- 📝 **Subtitle downloads** — auto-detected languages, embedded straight into the video file
- 🚀 **SponsorBlock integration** — automatically cut sponsor segments out of downloaded videos
- 🖼️ **Thumbnail + metadata embedding** — downloaded files carry cover art, title, and artist tags
- 📋 **Clipboard watcher** — copy a YouTube link anywhere and NexGrab notices it automatically
- 🕘 **Download history** — searchable, with one click to reveal a file in its folder
- 🐌 **Speed limiter** — cap bandwidth usage so downloads don't hog your connection
- 🌗 **Dark & light themes**, minimalist glass UI, zero clutter
- 📁 **Custom save location**, remembered between sessions
- 🔔 **Native notifications** when a download finishes

---

## 🧩 For end users

Nothing to install. Download the NexGrab installer for your OS, run it, done —
yt-dlp and ffmpeg are bundled inside the app.

## 🧩 For developers building NexGrab

1. **Node.js** ≥ 18 — https://nodejs.org
2. Drop platform binaries into `assets/bin/win`, `assets/bin/mac`, `assets/bin/linux`
   — see `assets/bin/README.md` for exact download links. These get bundled
   into the installer automatically by `npm run dist`.
3. Drop your logo into `assets/` as `icon.png`, `icon.ico`, `icon.icns`
   — see `assets/ICON_README.md`.

While developing (`npm start`) without the bundled binaries in place, NexGrab
falls back to whatever `yt-dlp` / `ffmpeg` it finds on your system PATH, so
you can still test locally without downloading the binaries yet.

---

## 🚀 Run it

```bash
cd NexGrab
npm install
npm start
```

## 📦 Build a distributable app

```bash
npm run dist
```

This uses `electron-builder` to produce a Windows installer, macOS `.dmg`, or Linux `AppImage` depending on the platform you build on.

---

## 🗂️ Project structure

```
NexGrab/
├── main.js        # Electron main process — spawns yt-dlp, manages downloads, settings, history
├── preload.js     # Secure IPC bridge exposed to the UI as window.nex
├── src/
│   ├── index.html # App shell
│   ├── style.css  # Design system (dark/light tokens, components)
│   └── renderer.js# All UI behaviour — fetch info, queue, drawers, progress
└── package.json
```

The backend is intentionally thin: it just prepares the right `yt-dlp` command-line flags for each job, streams progress back over IPC, and keeps a small JSON history/settings file in the app's user-data folder. All the polish lives in the frontend.

---

## 🔒 Notes

- NexGrab only talks to `yt-dlp` on your own machine — no accounts, no tracking, no ads.
- Respect YouTube's Terms of Service and copyright law in your region when downloading content.
"# NexGrab-Desktop" 
