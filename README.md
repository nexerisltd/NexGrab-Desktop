# NexGrab

> A clean, capable desktop downloader for YouTube video and audio, built with Electron and yt-dlp.

![NexGrab cover](https://github.com/nexerisltd/NexGrab-Desktop/blob/main/assets/cover.png)

NexGrab makes it simple to download videos, extract audio, manage playlists, save subtitles, and keep a history of your downloads from one focused desktop app.

## Download

### Windows

[![Download NexGrab for Windows](https://img.shields.io/badge/Download-NexGrab%20for%20Windows-0ea5e9?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/nexerisltd/NexGrab-Desktop/releases/download/v.2.0.1/NexGrab-Setup-2.0.1-win64.exe)

Download and run **NexGrab Setup 2.0.1 for Windows (64-bit)**.

## Highlights

| | Feature |
| --- | --- |
| Video | Download video up to 4K/8K quality. |
| Audio | Extract MP3, M4A, Opus, FLAC, or WAV audio. |
| Playlists | Download complete playlists and manage a bulk queue. |
| Clips | Save only the part you need with start and end timestamps. |
| Subtitles | Download subtitles and use SponsorBlock support. |
| Workflow | Use history, clipboard watching, speed limits, themes, and persistent save locations. |

## Screenshots

### Home

![NexGrab home in dark mode](assets/Home_Dark.png)

![NexGrab home in light mode](assets/Home_Light.png)

### Settings

![NexGrab settings screen](assets/Settings_slide.png)

### History

![NexGrab history screen](assets/History_Slide.png)

## Run Locally

**Requirements:** Node.js 18 or newer.

```bash
npm install
npm start
```

## Build From the Project Root

```bash
npm run dist
```

This runs `electron-builder` and creates the platform-specific distributable. On Windows, the installer is written to `dist/NexGrab-Setup-2.0.1-win64.exe`.

## Development Notes

- Bundled `yt-dlp` and `ffmpeg` binaries are expected in the relevant `assets/bin` directories.
- During local development, the app can fall back to system-installed `yt-dlp` and `ffmpeg` when bundled binaries are unavailable.

## Responsible Use

NexGrab uses `yt-dlp` locally and does not require accounts or tracking. Please respect YouTube's Terms of Service and applicable copyright laws.
