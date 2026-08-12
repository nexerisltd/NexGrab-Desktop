# NexGrab

A beautifully simple, seriously capable desktop downloader for YouTube videos and audio, built with Electron and yt-dlp.

![NexGrab cover](assets/Cover.png)

NexGrab brings a clean, modern desktop experience to downloading content from YouTube with support for video, audio, playlists, subtitles, trimming, and more.

## ✨ Highlights

- 🎬 Download videos up to 4K/8K or extract audio in MP3, M4A, Opus, FLAC, WAV
- 📃 Support for full playlists and bulk queue management
- ✂️ Clip downloads by start and end timestamps
- 📝 Subtitle downloads and SponsorBlock support
- 🕘 Download history, clipboard watching, speed limiting, and theme switching
- 📁 Custom save location with persistent settings

## 📸 Screenshots

### Home view

![NexGrab home in dark mode](assets/Home_Dark.png)

![NexGrab home in light mode](assets/Home_Light.png)

### Settings

![NexGrab settings screen](assets/Settings_slide.png)

### History

![NexGrab history screen](assets/History_Slide.png)

## 🚀 Run locally

```bash
npm install
npm start
```

## 📦 Build a distributable app

```bash
npm run dist
```

This uses electron-builder to generate installers for Windows, macOS, and Linux depending on the platform you build on.

## 🧩 Development notes

- Node.js 18 or newer is recommended
- Bundled binaries for yt-dlp and ffmpeg are expected under the assets/bin folders
- The app can fall back to system-installed yt-dlp/ffmpeg during local development if the bundled binaries are not present yet

## 🔒 Notes

- NexGrab uses yt-dlp on your machine and does not require accounts or tracking
- Please respect YouTube's Terms of Service and local copyright laws when downloading content
