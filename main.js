const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Bundled binaries — NexGrab ships its own yt-dlp + ffmpeg so users never
// have to install anything separately. Falls back to PATH lookup in dev
// if the bundled binary isn't present yet (e.g. before you've dropped the
// platform binaries into assets/bin/<platform>/).
// ---------------------------------------------------------------------------
const PLATFORM_DIR = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, 'assets', 'bin', PLATFORM_DIR);

const YTDLP_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const FFMPEG_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const BUNDLED_YTDLP = path.join(BIN_DIR, YTDLP_NAME);
const BUNDLED_FFMPEG = path.join(BIN_DIR, FFMPEG_NAME);

// If the bundled binary exists, use it; otherwise fall back to whatever is on PATH.
const YTDLP_BIN = fs.existsSync(BUNDLED_YTDLP) ? BUNDLED_YTDLP : 'yt-dlp';
const FFMPEG_BIN = fs.existsSync(BUNDLED_FFMPEG) ? BUNDLED_FFMPEG : 'ffmpeg';

// macOS/Linux packaging can strip the execute bit — restore it defensively.
if (process.platform !== 'win32') {
  try { fs.chmodSync(YTDLP_BIN, 0o755); } catch {}
  try { fs.chmodSync(FFMPEG_BIN, 0o755); } catch {}
}

// ---------------------------------------------------------------------------
// Paths & persistent storage (plain JSON files — no DB needed, keeps backend simple)
// ---------------------------------------------------------------------------
const USER_DATA = app.getPath('userData');
const HISTORY_FILE = path.join(USER_DATA, 'history.json');
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');

const DEFAULT_SETTINGS = {
  outputDir: app.getPath('downloads'),
  ytdlpPath: YTDLP_BIN,
  ffmpegPath: FFMPEG_BIN,
  concurrency: 2,
  theme: 'dark',
  embedThumbnail: true,
  embedMetadata: true,
  clipboardWatch: true,
  sponsorBlock: false,
  rateLimit: '' // e.g. "5M" for 5MB/s, empty = unlimited
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let settings = { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_FILE, {}) };
let history = readJSON(HISTORY_FILE, []);

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#0b0c0f',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.env.NEXGRAB_DEBUG) mainWindow.webContents.openDevTools();
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.nexapp.nexgrab');
}

app.whenReady().then(() => {
  createWindow();
  startClipboardWatcher();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Clipboard watcher — auto-detects a fresh YouTube link copied by the user
// ---------------------------------------------------------------------------
let lastClipboard = '';
const YT_URL_RE = /(youtube\.com\/(watch\?v=|shorts\/|playlist\?list=)|youtu\.be\/)/i;

function startClipboardWatcher() {
  setInterval(() => {
    if (!settings.clipboardWatch) return;
    const text = clipboard.readText();
    if (text && text !== lastClipboard && YT_URL_RE.test(text)) {
      lastClipboard = text;
      mainWindow?.webContents.send('clipboard:youtube-url', text.trim());
    }
  }, 1200);
}

// ---------------------------------------------------------------------------
// Helpers to run yt-dlp
// ---------------------------------------------------------------------------
function runYtDlpJSON(args) {
  return new Promise((resolve, reject) => {
    execFile(settings.ytdlpPath, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

ipcMain.handle('ytdlp:check', async () => {
  try {
    const out = await runYtDlpJSON(['--version']);
    return { ok: true, version: out.trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ytdlp:fetch-info', async (_evt, url) => {
  try {
    // Step 1: cheap flat probe to see if this is a playlist
    const flatOut = await runYtDlpJSON(['-J', '--flat-playlist', '--no-warnings', url]);
    const flat = JSON.parse(flatOut);

    if (flat._type === 'playlist') {
      return {
        ok: true,
        kind: 'playlist',
        title: flat.title || 'Playlist',
        uploader: flat.uploader || flat.channel || '',
        entries: (flat.entries || []).map((e) => ({
          id: e.id,
          title: e.title,
          url: e.url && e.url.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
          duration: e.duration || null,
          thumbnail: e.thumbnails ? e.thumbnails[e.thumbnails.length - 1]?.url : null
        }))
      };
    }

    // Step 2: full extraction for a single video (real formats list)
    const fullOut = await runYtDlpJSON(['-J', '--no-playlist', '--no-warnings', url]);
    const info = JSON.parse(fullOut);

    const formats = (info.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none');
    const heights = [...new Set(formats.map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);

    return {
      ok: true,
      kind: 'video',
      id: info.id,
      title: info.title,
      uploader: info.uploader || info.channel || '',
      duration: info.duration || 0,
      thumbnail: info.thumbnail,
      viewCount: info.view_count || null,
      availableHeights: heights,
      hasSubtitles: !!(info.subtitles && Object.keys(info.subtitles).length),
      subtitleLangs: info.subtitles ? Object.keys(info.subtitles) : [],
      url
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dialog:choose-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  settings.outputDir = res.filePaths[0];
  writeJSON(SETTINGS_FILE, settings);
  return settings.outputDir;
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_evt, partial) => {
  settings = { ...settings, ...partial };
  writeJSON(SETTINGS_FILE, settings);
  return settings;
});

ipcMain.handle('history:get', () => history);
ipcMain.handle('history:clear', () => {
  history = [];
  writeJSON(HISTORY_FILE, history);
  return history;
});
ipcMain.handle('shell:open-folder', (_evt, filePath) => {
  shell.showItemInFolder(filePath);
});
ipcMain.handle('shell:open-path', (_evt, filePath) => {
  shell.openPath(filePath);
});

// ---------------------------------------------------------------------------
// Download engine — one child process per queued job, tracked by jobId
// ---------------------------------------------------------------------------
const activeJobs = new Map(); // jobId -> ChildProcess

function buildArgs(job) {
  const { url, mode, height, audioFormat, audioQuality, container, subtitles, subLangs,
    trimStart, trimEnd, sponsorBlock, rateLimit } = job;

  const args = ['--newline', '--no-warnings', '--ignore-config'];

  if (rateLimit) args.push('--limit-rate', rateLimit);

  if (mode === 'audio') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', audioFormat, '--audio-quality', String(audioQuality));
  } else {
    const heightFilter = height && height !== 'best' ? `[height<=${height}]` : '';
    args.push('-f', `bestvideo${heightFilter}+bestaudio/best${heightFilter}`);
    args.push('--merge-output-format', container || 'mp4');
  }

  if (job.embedThumbnail) args.push('--embed-thumbnail');
  if (job.embedMetadata) args.push('--add-metadata');

  if (subtitles) {
    args.push('--write-subs', '--sub-langs', subLangs || 'en.*');
    if (mode !== 'audio') args.push('--embed-subs');
  }

  if (trimStart || trimEnd) {
    args.push('--download-sections', `*${trimStart || '0'}-${trimEnd || 'inf'}`);
  }

  if (sponsorBlock && mode !== 'audio') {
    args.push('--sponsorblock-remove', 'all');
  }

  args.push('--ffmpeg-location', settings.ffmpegPath);
  args.push('-o', path.join(job.outputDir, '%(title)s.%(ext)s'));
  args.push(url);
  return args;
}

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\w+)\s+at\s+([\d.]+\w+\/s|Unknown)\s+ETA\s+([\d:]+|Unknown)/;
const DEST_RE = /\[download\] Destination: (.+)/;
const ALREADY_RE = /has already been downloaded/;
const MERGE_RE = /\[Merger\]|Merging formats/;

ipcMain.handle('download:start', async (_evt, job) => {
  const args = buildArgs(job);
  const proc = spawn(settings.ytdlpPath, args, { cwd: job.outputDir });
  activeJobs.set(job.jobId, { proc, destination: null });

  const send = (channel, payload) => mainWindow?.webContents.send(channel, { jobId: job.jobId, ...payload });

  let destination = null;

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    text.split(/\r|\n/).forEach((line) => {
      if (!line.trim()) return;

      const dest = line.match(DEST_RE);
      if (dest) { destination = dest[1]; activeJobs.get(job.jobId).destination = destination; }

      if (MERGE_RE.test(line)) {
        send('download:progress', { status: 'merging', percent: 99 });
        return;
      }
      if (ALREADY_RE.test(line)) {
        send('download:progress', { status: 'exists', percent: 100 });
        return;
      }

      const m = line.match(PROGRESS_RE);
      if (m) {
        send('download:progress', {
          status: 'downloading',
          percent: parseFloat(m[1]),
          size: m[2],
          speed: m[3],
          eta: m[4]
        });
      }
    });
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

  proc.on('close', (code) => {
    activeJobs.delete(job.jobId);
    if (code === 0) {
      const entry = {
        id: job.jobId,
        title: job.title,
        url: job.url,
        mode: job.mode,
        quality: job.mode === 'audio' ? `${job.audioFormat.toUpperCase()} ${job.audioQuality}` : `${job.height || 'best'}p`,
        path: destination || job.outputDir,
        date: new Date().toISOString()
      };
      history.unshift(entry);
      history = history.slice(0, 300);
      writeJSON(HISTORY_FILE, history);

      send('download:progress', { status: 'done', percent: 100, path: destination });
      if (Notification.isSupported()) {
        new Notification({ title: 'NexGrab', body: `Finished: ${job.title}` }).show();
      }
    } else {
      send('download:progress', { status: 'error', error: stderrBuf.slice(-500) || `yt-dlp exited with code ${code}` });
    }
  });

  proc.on('error', (err) => {
    activeJobs.delete(job.jobId);
    send('download:progress', { status: 'error', error: err.message });
  });

  return { started: true };
});

ipcMain.handle('download:cancel', (_evt, jobId) => {
  const job = activeJobs.get(jobId);
  if (job) {
    job.proc.kill();
    activeJobs.delete(jobId);
    return true;
  }
  return false;
});
