# Put platform binaries here so NexGrab needs ZERO setup from users

NexGrab is coded to auto-detect and use binaries placed in these folders
(see BUNDLED_YTDLP / BUNDLED_FFMPEG in main.js). If they exist, they're used
automatically — nobody has to install yt-dlp or ffmpeg themselves.

## assets/bin/win/   (for Windows builds)
- yt-dlp.exe   → https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
- ffmpeg.exe   → https://www.gyan.dev/ffmpeg/builds/ (get the "essentials" build, pull ffmpeg.exe out of the bin/ folder)

## assets/bin/mac/   (for macOS builds)
- yt-dlp       → https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos
- ffmpeg       → https://evermeet.cx/ffmpeg/ (static build)
Run: chmod +x yt-dlp ffmpeg

## assets/bin/linux/   (for Linux builds)
- yt-dlp       → https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
- ffmpeg       → https://johnvansickle.com/ffmpeg/ (static build, pull the ffmpeg binary out)
Run: chmod +x yt-dlp ffmpeg

---

Once the binaries are in place, `npm run dist` on each platform will pack them
straight into the installer as extraResources (see the "build" section of
package.json). The result: a normal user just downloads the installer,
double-clicks, and NexGrab works immediately — no terminal, no PATH, no
separate installs.

Note: build each platform's installer on that platform (or via CI, e.g.
GitHub Actions with a build matrix) — electron-builder can't reliably
cross-compile native installers from a single machine.

If a binary is missing for the current platform, NexGrab falls back to
whatever "yt-dlp"/"ffmpeg" it finds on the system PATH, so development
(`npm start`) still works fine without these files.
