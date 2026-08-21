const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, Menu, session, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { BinaryManager } = require('./binaryManager');

// ---------------------------------------------------------------------------
// Paths & persistent storage (plain JSON files — no DB needed, keeps backend simple)
// ---------------------------------------------------------------------------
const USER_DATA = app.getPath('userData');
const HISTORY_FILE = path.join(USER_DATA, 'history.json');
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');

const DEFAULT_SETTINGS = {
  outputDir: app.getPath('downloads'),
  ytdlpPath: '',  // resolved at startup by binaryManager, see initBinaries()
  ffmpegPath: '', // resolved at startup by binaryManager, see initBinaries()
  concurrency: 2,
  theme: 'dark',
  embedThumbnail: true,
  embedMetadata: true,
  clipboardWatch: true,
  sponsorBlock: false,
  minimizeToTray: true,
  closeToTray: true,
  rateLimit: '', // e.g. "5M" for 5MB/s, empty = unlimited
  cookiesFromBrowser: '', // e.g. "chrome", "edge", "firefox" — fixes "Sign in to confirm you're not a bot"
  cookiesFilePath: '', // path to an exported cookies.txt — more reliable than cookiesFromBrowser on newer Chrome
  potProviderEnabled: false // local PO Token provider sidecar (helps with SABR-blocked videos)
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
// Binary manager — replaces the old "bundled in assets/bin" approach.
// yt-dlp + ffmpeg are downloaded on first launch into userData/bin and kept
// up to date from there. See binaryManager.js for the full implementation.
// ---------------------------------------------------------------------------
const binaryManager = new BinaryManager(USER_DATA);
let depsReady = false;

binaryManager.on('progress', (payload) => {
  mainWindow?.webContents.send('deps:progress', payload);
});

async function initBinaries() {
  try {
    const { ytdlpPath, ffmpegPath, ready } = await binaryManager.ensureBinaries();
    settings.ytdlpPath = ytdlpPath;
    settings.ffmpegPath = ffmpegPath;
    writeJSON(SETTINGS_FILE, settings);
    depsReady = ready;
    mainWindow?.webContents.send('deps:ready', { ok: ready });
  } catch (e) {
    depsReady = false;
    mainWindow?.webContents.send('deps:ready', {
      ok: false,
      error: `Couldn't download required components. Check your internet connection and retry. (${e.message})`
    });
  }

  // Background update check — runs once shortly after startup, then daily.
  // Silent: only surfaces to the UI if something actually changes.
  setTimeout(() => backgroundUpdateCheck(), 8000);
  setInterval(() => backgroundUpdateCheck(), 24 * 60 * 60 * 1000);
}

async function backgroundUpdateCheck() {
  try {
    const result = await binaryManager.checkForUpdates({ silent: true });
    if (result.ytdlp.updated || result.ffmpeg.updated) {
      settings.ytdlpPath = binaryManager.ytdlpPath;
      settings.ffmpegPath = binaryManager.ffmpegPath;
      writeJSON(SETTINGS_FILE, settings);
      mainWindow?.webContents.send('deps:auto-updated', result);
    }
  } catch {
    // Silent background check — network hiccups shouldn't bother the user.
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow;
let tray = null;
let isQuitting = false;

const ICON_PATH = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#0b0c0f',
    icon: ICON_PATH,
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

  // Minimize to tray
  mainWindow.on('minimize', (e) => {
    if (settings.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Close to tray (unless user chose Quit from the tray menu, or the OS is
  // actually shutting the app down)
  mainWindow.on('close', (e) => {
    if (settings.closeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

function createTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('NexGrab');

  const menu = Menu.buildFromTemplate([
    { label: 'Open NexGrab', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    {
      label: 'Quit', click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show();
  });
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.nexapp.nexgrab');
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  startClipboardWatcher();
  initBinaries();
  if (settings.potProviderEnabled) startPotProvider().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  // With close-to-tray enabled the window is hidden rather than destroyed,
  // so this normally only fires on a real quit or on platforms/settings
  // where close-to-tray is off.
  if (process.platform !== 'darwin' && !settings.closeToTray) app.quit();
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
// Dependencies IPC (auto-download / update / manual re-download)
// ---------------------------------------------------------------------------
ipcMain.handle('deps:get-status', async () => {
  const status = await binaryManager.getStatus();
  return { ...status, ready: depsReady };
});

ipcMain.handle('deps:check-updates', async () => {
  try {
    const result = await binaryManager.checkForUpdates({ silent: false });
    if (result.ytdlp.updated || result.ffmpeg.updated) {
      settings.ytdlpPath = binaryManager.ytdlpPath;
      settings.ffmpegPath = binaryManager.ffmpegPath;
      writeJSON(SETTINGS_FILE, settings);
    }
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('deps:redownload', async () => {
  try {
    const status = await binaryManager.redownloadAll();
    settings.ytdlpPath = binaryManager.ytdlpPath;
    settings.ffmpegPath = binaryManager.ffmpegPath;
    writeJSON(SETTINGS_FILE, settings);
    depsReady = true;
    return { ok: true, ...status };
  } catch (e) {
    return {
      ok: false,
      error: `Couldn't download required components. Check your internet connection and retry. (${e.message})`
    };
  }
});

// ---------------------------------------------------------------------------
// Helpers to run yt-dlp
// ---------------------------------------------------------------------------
function runYtDlpJSON(args) {
  const cookieArgs = settings.cookiesFilePath
    ? ['--cookies', settings.cookiesFilePath]
    : settings.cookiesFromBrowser
      ? ['--cookies-from-browser', settings.cookiesFromBrowser]
      : [];
  const finalArgs = [...cookieArgs, ...args];
  return new Promise((resolve, reject) => {
    execFile(settings.ytdlpPath, finalArgs, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// SABR / PO Token fallback — some clients (mainly "web") get served
// SABR-only formats with no direct URL, which yt-dlp reports via stderr
// ("forcing SABR streaming...") rather than a clean error. Instead of
// surfacing that to the user, we retry the same request against a chain of
// alternate player clients until one works.
// ---------------------------------------------------------------------------
const CLIENT_CHAIN = ['tv', 'mweb', 'ios', 'web_creator'];
const SABR_ERROR_RE = /forcing sabr streaming|sabr[- ]only|missing url in format|requested format is not available|unable to extract yt initial data/i;

function buildExtractorArgs(client) {
  const args = ['--extractor-args', `youtube:player_client=${client}`];
  // web_creator can use a PO token when our local sidecar provider is up —
  // wire it in via the youtubepot-bgutilhttp extractor plugin's own args.
  // NOTE: if bgutil-ytdlp-pot-provider changes its expected extractor-args
  // key in a future release, update this line to match its README.
  if (client === 'web_creator' && settings.potProviderEnabled && potProviderIsRunning()) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${POT_PORT}`);
  }
  return args;
}

async function runYtDlpJSONWithFallback(baseArgs) {
  let lastErr;
  for (let i = 0; i < CLIENT_CHAIN.length; i++) {
    const client = CLIENT_CHAIN[i];
    try {
      return await runYtDlpJSON([...buildExtractorArgs(client), ...baseArgs]);
    } catch (e) {
      lastErr = e;
      const isLastClient = i === CLIENT_CHAIN.length - 1;
      // Only burn through the whole chain for SABR-shaped failures — a bad
      // URL or a private video should fail fast instead of retrying 4x.
      if (!SABR_ERROR_RE.test(e.message) || isLastClient) throw e;
    }
  }
  throw lastErr;
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

    // Step 2: full extraction for a single video (real formats list) — this
    // is the step most likely to hit a SABR-only response, so it goes
    // through the client fallback chain.
    const fullOut = await runYtDlpJSONWithFallback(['-J', '--no-playlist', '--no-warnings', url]);
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

// Used by "Download now" — lets the user pick a one-off destination
// WITHOUT changing their saved default download folder.
ipcMain.handle('dialog:choose-folder-once', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:choose-cookies-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Cookies file', extensions: ['txt'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  settings.cookiesFilePath = res.filePaths[0];
  writeJSON(SETTINGS_FILE, settings);
  return settings.cookiesFilePath;
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
ipcMain.handle('shell:open-folder', (_evt, rawPath) => {
  const filePath = rawPath ? path.normalize(rawPath.trim()) : '';

  if (filePath && fs.existsSync(filePath)) {
    if (process.platform === 'win32') {
      // shell.showItemInFolder() silently fails to select the file (just
      // focuses an already-open Explorer window) on some Windows builds.
      // Calling explorer.exe directly with /select is far more reliable.
      try {
        spawn('explorer.exe', [`/select,${filePath}`]);
      } catch {
        shell.showItemInFolder(filePath);
      }
    } else {
      shell.showItemInFolder(filePath);
    }
    return { ok: true };
  }

  const dir = filePath ? path.dirname(filePath) : null;
  if (dir && fs.existsSync(dir)) {
    shell.openPath(dir);
    return { ok: true, fallback: true };
  }
  return { ok: false };
});
ipcMain.handle('shell:open-path', (_evt, filePath) => {
  shell.openPath(filePath);
});

// ---------------------------------------------------------------------------
// "Sign in to YouTube" — an embedded Electron login window instead of asking
// the user to fiddle with browser extensions or cookies.txt files. Electron
// owns this window's cookie jar directly, so there's no "Chrome database is
// locked/encrypted" problem — we read the cookies straight from our own
// session once login completes.
// ---------------------------------------------------------------------------
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by NexGrab — do not edit', ''];
  cookies.forEach((c) => {
    const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push([domain, includeSub, path, secure, expiry, c.name, c.value].join('\t'));
  });
  return lines.join('\n');
}

let loginWindow = null;

ipcMain.handle('auth:youtube-signin', async () => {
  if (loginWindow) { loginWindow.focus(); return { started: true }; }

  const loginSession = session.fromPartition('persist:nexgrab-ytlogin');
  loginSession.setUserAgent(DESKTOP_CHROME_UA);

  loginWindow = new BrowserWindow({
    width: 480,
    height: 680,
    parent: mainWindow,
    modal: false,
    title: 'Sign in to YouTube',
    webPreferences: { session: loginSession, contextIsolation: true, nodeIntegration: false }
  });
  loginWindow.setMenuBarVisibility(false);

  // Google's login flow frequently opens a *second* window for account
  // picker / "Verify it's you" / 2-step verification steps. Electron blocks
  // window.open() by default, so that popup silently disappears — Google
  // then sees an incomplete flow and shows "This browser or app may not be
  // secure." Explicitly allowing child windows (in the same session, so
  // cookies stay unified) fixes the sign-in failure in most cases.
  loginWindow.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: loginWindow,
      width: 480,
      height: 680,
      webPreferences: { session: loginSession, contextIsolation: true, nodeIntegration: false }
    }
  }));

  loginWindow.webContents.on('did-create-window', (childWindow) => {
    childWindow.setMenuBarVisibility(false);
  });

  loginWindow.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/');

  const send = (payload) => mainWindow?.webContents.send('auth:status', payload);
  send({ status: 'opened' });

  let finished = false;
  const finish = async (status, message) => {
    if (finished) return;
    finished = true;
    clearInterval(pollTimer);
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    loginWindow = null;
    send({ status, message });
  };

  // Poll for a strong "logged in" signal cookie rather than trying to parse
  // Google's ever-changing login page DOM.
  const pollTimer = setInterval(async () => {
    try {
      const cookies = await loginSession.cookies.get({ domain: '.youtube.com' });
      const loggedIn = cookies.some((c) => c.name === 'LOGIN_INFO' || c.name === 'SAPISID');
      if (loggedIn) {
        // Give the rest of the session cookies a moment to settle.
        await new Promise((r) => setTimeout(r, 1200));
        const allCookies = await loginSession.cookies.get({ url: 'https://www.youtube.com' });
        const cookiesTxt = cookiesToNetscape(allCookies);
        const outPath = path.join(USER_DATA, 'youtube-cookies.txt');
        fs.writeFileSync(outPath, cookiesTxt);

        settings.cookiesFilePath = outPath;
        settings.cookiesFromBrowser = '';
        writeJSON(SETTINGS_FILE, settings);

        await finish('success', 'Signed in to YouTube');
      }
    } catch (e) {
      // Session might be mid-navigation; ignore and try again next tick.
    }
  }, 1500);

  loginWindow.on('closed', () => {
    loginWindow = null;
    if (!finished) { finished = true; clearInterval(pollTimer); send({ status: 'cancelled' }); }
  });

  return { started: true };
});

ipcMain.handle('auth:youtube-signout', () => {
  settings.cookiesFilePath = '';
  settings.cookiesFromBrowser = '';
  writeJSON(SETTINGS_FILE, settings);
  const cookiesFile = path.join(USER_DATA, 'youtube-cookies.txt');
  try { if (fs.existsSync(cookiesFile)) fs.unlinkSync(cookiesFile); } catch {}
  return settings;
});

// ---------------------------------------------------------------------------
// Optional local PO Token provider sidecar (bgutil-ytdlp-pot-provider) —
// installed on first enable from npm, then run as a plain Node child
// process using Electron's own bundled Node runtime (no separate Node.js
// install required on the user's machine).
// ---------------------------------------------------------------------------
const POT_PORT = 4416;
const POT_DIR = path.join(USER_DATA, 'pot-provider');
let potProcess = null;

async function fetchNpmTarballUrl(pkgName) {
  const meta = await binaryManager.httpsGetJSON(`https://registry.npmjs.org/${pkgName}/latest`);
  if (!meta.dist || !meta.dist.tarball) throw new Error(`No tarball found for ${pkgName}`);
  return meta.dist.tarball;
}

async function ensurePotProviderInstalled() {
  const existing = binaryManager.findFileRecursive(POT_DIR, 'main.js')
    || binaryManager.findFileRecursive(POT_DIR, 'server.js');
  if (existing) return existing;

  fs.mkdirSync(POT_DIR, { recursive: true });
  const tarballUrl = await fetchNpmTarballUrl('bgutil-ytdlp-pot-provider');
  const tgzPath = path.join(POT_DIR, 'package.tgz');
  await binaryManager.downloadToFile(tarballUrl, tgzPath, () => {});
  // npm tarballs are plain gzipped tar files — `tar` handles this natively
  // on macOS/Linux, and on Windows 10+ the built-in tar.exe (bsdtar) does too.
  await binaryManager.runCmd('tar', ['-xzf', tgzPath, '-C', POT_DIR]);
  fs.unlinkSync(tgzPath);

  // NOTE: npm package internal layout can change between releases — if the
  // provider's entry file isn't named main.js/server.js/index.js anymore,
  // update this lookup (or hardcode the path from its package.json "main").
  const entry = binaryManager.findFileRecursive(POT_DIR, 'main.js')
    || binaryManager.findFileRecursive(POT_DIR, 'server.js')
    || binaryManager.findFileRecursive(POT_DIR, 'index.js');
  if (!entry) throw new Error('Could not locate the PO Token provider entry script after install');
  return entry;
}

async function startPotProvider() {
  if (potProcess) return { running: true };
  const entry = await ensurePotProviderInstalled();
  potProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(POT_PORT), ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  });
  potProcess.on('exit', () => { potProcess = null; });
  potProcess.on('error', () => { potProcess = null; });
  // Give it a moment to boot before yt-dlp starts relying on it.
  await new Promise((r) => setTimeout(r, 1500));
  return { running: !!potProcess };
}

function stopPotProvider() {
  if (potProcess) { potProcess.kill(); potProcess = null; }
}

function potProviderIsRunning() {
  return !!potProcess;
}

ipcMain.handle('pot:toggle', async (_evt, enabled) => {
  settings.potProviderEnabled = enabled;
  writeJSON(SETTINGS_FILE, settings);
  try {
    if (enabled) return await startPotProvider();
    stopPotProvider();
    return { running: false };
  } catch (e) {
    settings.potProviderEnabled = false;
    writeJSON(SETTINGS_FILE, settings);
    return { running: false, error: e.message };
  }
});

ipcMain.handle('pot:status', () => ({ running: potProviderIsRunning(), enabled: settings.potProviderEnabled }));

// ---------------------------------------------------------------------------
// Download engine — one child process per queued job, tracked by jobId.
// Automatically retries through CLIENT_CHAIN on SABR-shaped failures before
// giving up; a final failure is reported as retryable so the queue item can
// be retried individually without disturbing the rest of the queue.
// ---------------------------------------------------------------------------
const activeJobs = new Map(); // jobId -> ChildProcess

// Accepts "90", "1:30", "01:30", "1:02:03" etc. Returns a yt-dlp-friendly
// timecode string, or null if the input isn't a recognizable time.
function normalizeTimecode(raw) {
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return v; // plain seconds
  if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(v)) return v; // mm:ss or hh:mm:ss
  return null;
}

function buildArgs(job) {
  const { url, mode, height, audioFormat, audioQuality, container, subtitles, subLangs,
    trimStart, trimEnd, sponsorBlock, rateLimit } = job;

  const args = ['--newline', '--no-warnings', '--ignore-config'];

  if (settings.cookiesFilePath) args.push('--cookies', settings.cookiesFilePath);
  else if (settings.cookiesFromBrowser) args.push('--cookies-from-browser', settings.cookiesFromBrowser);
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
    const start = normalizeTimecode(trimStart) || '0';
    const end = normalizeTimecode(trimEnd) || 'inf';
    args.push('--download-sections', `*${start}-${end}`);
    // Without this, yt-dlp cuts on the nearest keyframe *before* the
    // requested time instead of the exact timestamp — clips end up
    // starting early / running long. This re-encodes the cut points so the
    // trim is actually accurate (slightly slower, but correct).
    args.push('--force-keyframes-at-cuts');
  }

  if (sponsorBlock && mode !== 'audio') {
    args.push('--sponsorblock-remove', 'all');
  }

  args.push('--ffmpeg-location', settings.ffmpegPath);
  // Print the REAL final path after merging/converting/embedding — this is
  // what makes "click title to open in file explorer" always accurate.
  args.push('--print', 'after_move:NEXGRAB_FINAL_PATH::%(filepath)s');
  args.push('-o', path.join(job.outputDir, '%(title)s.%(ext)s'));
  args.push(url);
  return args;
}

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\w+)\s+at\s+([\d.]+\w+\/s|Unknown)\s+ETA\s+([\d:]+|Unknown)/;
const DEST_RE = /\[download\] Destination: (.+)/;
const ALREADY_RE = /\[download\] (.+) has already been downloaded/;
const MERGE_RE = /\[Merger\]|Merging formats/;
const FINAL_PATH_RE = /^NEXGRAB_FINAL_PATH::(.+)$/;

ipcMain.handle('download:start', async (_evt, job) => {
  const send = (channel, payload) => mainWindow?.webContents.send(channel, { jobId: job.jobId, ...payload });
  let clientIdx = 0;

  function attempt() {
    const client = CLIENT_CHAIN[clientIdx];
    const args = [...buildExtractorArgs(client), ...buildArgs(job)];
    const proc = spawn(settings.ytdlpPath, args, { cwd: job.outputDir });
    activeJobs.set(job.jobId, { proc, destination: null });

    let destination = null;
    let stdoutBuffer = '';
    let sabrSeen = false;
    let stderrBuf = '';

    function processLine(line) {
      if (!line.trim()) return;

      const finalPath = line.match(FINAL_PATH_RE);
      if (finalPath) {
        destination = finalPath[1].trim();
        activeJobs.get(job.jobId).destination = destination;
        return;
      }

      const dest = line.match(DEST_RE);
      if (dest) { destination = dest[1]; activeJobs.get(job.jobId).destination = destination; }

      if (MERGE_RE.test(line)) {
        send('download:progress', { status: 'merging', percent: 99 });
        return;
      }
      if (ALREADY_RE.test(line)) {
        const already = line.match(ALREADY_RE);
        if (already) { destination = already[1]; activeJobs.get(job.jobId).destination = destination; }
        send('download:progress', { status: 'exists', percent: 100, path: destination });
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
    }

    proc.stdout.on('data', (chunk) => {
      // Buffer partial lines across chunk boundaries — a single line (especially
      // the long final-path marker) can otherwise split across two 'data'
      // events and silently fail to match any regex.
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r\n|\r|\n/);
      stdoutBuffer = lines.pop();
      lines.forEach(processLine);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (SABR_ERROR_RE.test(text)) sabrSeen = true;
    });

    proc.on('close', (code) => {
      if (stdoutBuffer.trim()) { processLine(stdoutBuffer); stdoutBuffer = ''; }
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
        return;
      }

      // SABR-shaped failure and clients left to try — silently retry with
      // the next one instead of surfacing an error to the user.
      if (sabrSeen && clientIdx < CLIENT_CHAIN.length - 1) {
        clientIdx++;
        send('download:progress', {
          status: 'retrying',
          message: `Blocked — retrying with the ${CLIENT_CHAIN[clientIdx]} client…`
        });
        attempt();
        return;
      }

      send('download:progress', {
        status: 'error',
        error: stderrBuf.slice(-500) || `yt-dlp exited with code ${code}`,
        retryable: true
      });
    });

    proc.on('error', (err) => {
      activeJobs.delete(job.jobId);
      send('download:progress', { status: 'error', error: err.message, retryable: true });
    });
  }

  attempt();
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
