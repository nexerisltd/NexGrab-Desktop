'use strict';

/**
 * binaryManager.js
 * ---------------------------------------------------------------------------
 * Replaces the old "bundled in assets/bin" approach. NexGrab no longer ships
 * yt-dlp/ffmpeg inside the installer — instead, on first launch (and
 * periodically after that) this module downloads the latest builds straight
 * from their upstream sources and keeps them in:
 *
 *   app.getPath('userData')/bin/
 *     ├─ yt-dlp(.exe)
 *     ├─ ffmpeg(.exe)
 *     └─ manifest.json      (records what we installed + when)
 *
 * Sources used:
 *   - yt-dlp:  https://github.com/yt-dlp/yt-dlp/releases/latest
 *              (asset picked per-platform, verified against the release's
 *              SHA2-256SUMS file when available)
 *   - ffmpeg:  Windows/Linux -> https://github.com/BtbN/FFmpeg-Builds (static,
 *              GPL builds, verified against the asset's .sha256 sidecar)
 *              macOS       -> https://evermeet.cx/ffmpeg (official static
 *              builds JSON API, includes a sha256 for every release)
 *
 * Everything here is intentionally dependency-free (no extra npm packages).
 * Zip extraction (yt-dlp needs none; ffmpeg on Windows/macOS ships as .zip)
 * is done with a small built-in unzipSync() rather than shelling out to
 * PowerShell's Expand-Archive or macOS's unzip — spawning an external
 * process for this turned out to hang indefinitely on some machines
 * (most likely real-time antivirus scanning stalling the child process),
 * with no way to recover short of force-quitting the app. Pure-JS
 * extraction removes that whole failure class. Linux's ffmpeg build is a
 * .tar.xz, which we still extract via the system `tar` (implementing an
 * XZ/LZMA decompressor from scratch isn't worth the risk) — but that call,
 * like every other spawned command in this file, now has a hard timeout
 * so a hang there fails loudly instead of freezing the app forever.
 * ---------------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');

const CMD_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes — generous, but finite
const YTDLP_RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const FFMPEG_RELEASE_API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest';
const FFMPEG_MAC_API = 'https://evermeet.cx/ffmpeg/info/ffmpeg/release';
const USER_AGENT = 'NexGrab-Desktop (+https://github.com/nexerisltd/NexGrab-Desktop)';
const MIN_YTDLP_SIZE = 1_000_000; // sanity floor — a real yt-dlp binary is several MB

class BinaryManager extends EventEmitter {
  /**
   * @param {string} userDataDir  app.getPath('userData') — passed in rather
   *   than read from `electron` here so this module has zero dependency on
   *   Electron being ready yet, and is trivially unit-testable.
   */
  constructor(userDataDir) {
    super();
    this.platform = process.platform; // 'win32' | 'darwin' | 'linux'
    this.binDir = path.join(userDataDir, 'bin');
    this.manifestPath = path.join(this.binDir, 'manifest.json');

    this.ytdlpPath = path.join(this.binDir, this.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    this.ffmpegPath = path.join(this.binDir, this.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

    this.ready = false;

    // Serializes ensureBinaries() / checkForUpdates() / redownloadAll() —
    // all three touch the exact same files on disk, and a background
    // update check firing while the initial install is still running (or a
    // manual "Check for updates" click during either) used to be able to
    // race against it: two downloads/extracts writing the same paths at
    // once. Every call now waits its turn instead of running concurrently.
    this._opLock = Promise.resolve();
  }

  _withLock(fn) {
    const run = this._opLock.then(fn, fn);
    this._opLock = run.then(() => {}, () => {});
    return run;
  }

  // -------------------------------------------------------------------
  // Manifest (small JSON file tracking installed versions / build ids so
  // update checks don't have to guess from an unreliable `ffmpeg -version`
  // string)
  // -------------------------------------------------------------------
  readManifest() {
    try { return JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8')); }
    catch { return {}; }
  }

  writeManifest(manifest) {
    fs.mkdirSync(this.binDir, { recursive: true });
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  emitProgress(component, phase, extra = {}) {
    this.emit('progress', { component, phase, ...extra });
  }

  // -------------------------------------------------------------------
  // Startup entry point — call once, early, before any download can start.
  // Resolves once both binaries are present (downloading whatever is
  // missing). Does NOT check for updates — that's a separate, explicit step
  // so first-launch setup stays as fast as possible.
  // -------------------------------------------------------------------
  async ensureBinaries() {
    return this._withLock(() => this._ensureBinariesInner());
  }

  async _ensureBinariesInner() {
    fs.mkdirSync(this.binDir, { recursive: true });

    if (!fs.existsSync(this.ytdlpPath)) {
      await this.downloadYtDlp();
    }
    if (!fs.existsSync(this.ffmpegPath)) {
      await this.downloadFfmpeg();
    }

    if (this.platform !== 'win32') {
      try { fs.chmodSync(this.ytdlpPath, 0o755); } catch { /* best effort */ }
      try { fs.chmodSync(this.ffmpegPath, 0o755); } catch { /* best effort */ }
    }

    this.ready = fs.existsSync(this.ytdlpPath) && fs.existsSync(this.ffmpegPath);
    return { ytdlpPath: this.ytdlpPath, ffmpegPath: this.ffmpegPath, ready: this.ready };
  }

  async getStatus() {
    const manifest = this.readManifest();
    const ytdlpInstalled = fs.existsSync(this.ytdlpPath);
    const ffmpegInstalled = fs.existsSync(this.ffmpegPath);
    const ytdlpVersion = ytdlpInstalled ? await this.getInstalledYtDlpVersion() : null;

    return {
      ytdlp: {
        installed: ytdlpInstalled,
        version: ytdlpVersion || (manifest.ytdlp && manifest.ytdlp.version) || null,
        path: this.ytdlpPath
      },
      ffmpeg: {
        installed: ffmpegInstalled,
        version: (manifest.ffmpeg && manifest.ffmpeg.version) || null,
        path: this.ffmpegPath
      }
    };
  }

  getInstalledYtDlpVersion() {
    if (!fs.existsSync(this.ytdlpPath)) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(this.ytdlpPath, ['--version'], (err, stdout) => resolve(err ? null : stdout.trim()));
    });
  }

  // -------------------------------------------------------------------
  // Update check — safe to call at startup and on a daily interval.
  // Silent by default (no UI interruption unless something is actually
  // downloaded); pass { silent: false } to surface progress events for a
  // user-initiated "Check for updates" click.
  // -------------------------------------------------------------------
  async checkForUpdates({ silent = true } = {}) {
    return this._withLock(() => this._checkForUpdatesInner({ silent }));
  }

  async _checkForUpdatesInner({ silent = true } = {}) {
    const result = { ytdlp: { updated: false }, ffmpeg: { updated: false }, error: null };

    try {
      const [installedYtdlp, latestYtdlp] = await Promise.all([
        this.getInstalledYtDlpVersion(),
        this.fetchLatestYtDlpRelease()
      ]);
      if (!installedYtdlp || installedYtdlp !== latestYtdlp.tag_name) {
        if (!silent) this.emitProgress('yt-dlp', 'update-found', { latest: latestYtdlp.tag_name });
        await this.downloadYtDlp(latestYtdlp);
        result.ytdlp = { updated: true, version: latestYtdlp.tag_name };
      }
    } catch (e) {
      result.error = `yt-dlp update check failed: ${e.message}`;
    }

    try {
      const manifest = this.readManifest();
      const latestFfmpegMeta = await this.fetchLatestFfmpegMeta();
      const currentBuildId = manifest.ffmpeg && manifest.ffmpeg.buildId;
      if (!currentBuildId || currentBuildId !== latestFfmpegMeta.buildId) {
        if (!silent) this.emitProgress('ffmpeg', 'update-found', { latest: latestFfmpegMeta.buildId });
        await this.downloadFfmpeg(latestFfmpegMeta);
        result.ffmpeg = { updated: true, version: latestFfmpegMeta.buildId };
      }
    } catch (e) {
      result.error = (result.error ? result.error + ' | ' : '') + `ffmpeg update check failed: ${e.message}`;
    }

    return result;
  }

  // Troubleshooting: wipe and redownload both, unconditionally.
  async redownloadAll() {
    return this._withLock(() => this._redownloadAllInner());
  }

  async _redownloadAllInner() {
    try { if (fs.existsSync(this.ytdlpPath)) fs.unlinkSync(this.ytdlpPath); } catch { /* ignore */ }
    try { if (fs.existsSync(this.ffmpegPath)) fs.unlinkSync(this.ffmpegPath); } catch { /* ignore */ }
    await this.downloadYtDlp();
    await this.downloadFfmpeg();
    return this.getStatus();
  }

  // -------------------------------------------------------------------
  // yt-dlp
  // -------------------------------------------------------------------
  async fetchLatestYtDlpRelease() {
    return this.httpsGetJSON(YTDLP_RELEASE_API);
  }

  async downloadYtDlp(release) {
    this.emitProgress('yt-dlp', 'downloading', { percent: 0 });
    if (!release) release = await this.fetchLatestYtDlpRelease();

    const assetName = this.platform === 'win32'
      ? 'yt-dlp.exe'
      : this.platform === 'darwin'
        ? 'yt-dlp_macos'
        : 'yt-dlp';

    const asset = (release.assets || []).find((a) => a.name === assetName);
    if (!asset) throw new Error(`Could not find a "${assetName}" asset in the latest yt-dlp release`);

    const tmpPath = `${this.ytdlpPath}.part`;
    await this.downloadToFile(asset.browser_download_url, tmpPath, (percent) => {
      this.emitProgress('yt-dlp', 'downloading', { percent });
    });

    // Best-effort checksum verification against the release's SHA2-256SUMS
    // file. If that file is missing or unparseable we fall back to the size
    // sanity check below rather than blocking install entirely.
    const sumsAsset = (release.assets || []).find((a) => a.name === 'SHA2-256SUMS');
    if (sumsAsset) {
      this.emitProgress('yt-dlp', 'verifying', {});
      try {
        const sums = await this.downloadText(sumsAsset.browser_download_url);
        const line = sums.split('\n').find((l) => l.trim().endsWith(assetName));
        if (line) {
          const expected = line.trim().split(/\s+/)[0];
          const actual = await this.sha256File(tmpPath);
          if (expected.toLowerCase() !== actual.toLowerCase()) {
            fs.unlinkSync(tmpPath);
            throw new Error('yt-dlp checksum mismatch — the download may be corrupted');
          }
        }
      } catch (e) {
        if (/checksum mismatch/.test(e.message)) throw e;
        // else: SHA2-256SUMS unreachable/unparseable, continue to size check
      }
    }

    const stat = fs.statSync(tmpPath);
    if (stat.size < MIN_YTDLP_SIZE) {
      fs.unlinkSync(tmpPath);
      throw new Error('Downloaded yt-dlp binary looks too small — the download likely failed');
    }

    fs.renameSync(tmpPath, this.ytdlpPath);
    if (this.platform !== 'win32') fs.chmodSync(this.ytdlpPath, 0o755);

    const manifest = this.readManifest();
    manifest.ytdlp = { version: release.tag_name, downloadedAt: new Date().toISOString() };
    this.writeManifest(manifest);
    this.emitProgress('yt-dlp', 'done', { version: release.tag_name });
  }

  // -------------------------------------------------------------------
  // ffmpeg
  // -------------------------------------------------------------------
  async fetchLatestFfmpegMeta() {
    if (this.platform === 'darwin') {
      const info = await this.httpsGetJSON(FFMPEG_MAC_API); // { name, version, size, sha256, url, ... }
      return { url: info.url, sha256: info.sha256, buildId: info.version };
    }

    const release = await this.httpsGetJSON(FFMPEG_RELEASE_API);
    const wantRe = this.platform === 'win32'
      ? /win64.*gpl.*\.zip$/i
      : /linux64.*gpl.*\.tar\.xz$/i;

    const asset = (release.assets || []).find((a) => wantRe.test(a.name));
    if (!asset) throw new Error('Could not find a matching ffmpeg build in the latest BtbN/FFmpeg-Builds release');
    const shaAsset = (release.assets || []).find((a) => a.name === `${asset.name}.sha256`);

    return { asset, shaAsset, buildId: String(release.id) };
  }

  async downloadFfmpeg(meta) {
    this.emitProgress('ffmpeg', 'downloading', { percent: 0 });
    if (!meta) meta = await this.fetchLatestFfmpegMeta();

    if (this.platform === 'darwin') {
      const tmpZip = path.join(this.binDir, 'ffmpeg-mac.part.zip');
      await this.downloadToFile(meta.url, tmpZip, (percent) => this.emitProgress('ffmpeg', 'downloading', { percent }));

      if (meta.sha256) {
        const actual = await this.sha256File(tmpZip);
        if (actual.toLowerCase() !== meta.sha256.toLowerCase()) {
          fs.unlinkSync(tmpZip);
          throw new Error('ffmpeg checksum mismatch — the download may be corrupted');
        }
      }

      this.emitProgress('ffmpeg', 'extracting', { percent: 0 });
      const macExtractDir = path.join(this.binDir, '_ffmpeg_extract_mac');
      fs.rmSync(macExtractDir, { recursive: true, force: true });
      fs.mkdirSync(macExtractDir, { recursive: true });
      this.unzipSync(tmpZip, macExtractDir, (percent) => this.emitProgress('ffmpeg', 'extracting', { percent }));

      const foundMac = this.findFileRecursive(macExtractDir, 'ffmpeg');
      if (!foundMac) throw new Error('ffmpeg binary not found inside the downloaded archive');
      fs.copyFileSync(foundMac, this.ffmpegPath);
      fs.chmodSync(this.ffmpegPath, 0o755);

      fs.unlinkSync(tmpZip);
      fs.rmSync(macExtractDir, { recursive: true, force: true });

      const manifest = this.readManifest();
      manifest.ffmpeg = { version: meta.buildId, buildId: meta.buildId, downloadedAt: new Date().toISOString() };
      this.writeManifest(manifest);
      this.emitProgress('ffmpeg', 'done', { version: meta.buildId });
      return;
    }

    // Windows + Linux: static archives from BtbN/FFmpeg-Builds
    const tmpArchive = path.join(
      this.binDir,
      this.platform === 'win32' ? 'ffmpeg-win.part.zip' : 'ffmpeg-linux.part.tar.xz'
    );
    await this.downloadToFile(meta.asset.browser_download_url, tmpArchive, (percent) => {
      this.emitProgress('ffmpeg', 'downloading', { percent });
    });

    if (meta.shaAsset) {
      try {
        const shaText = await this.downloadText(meta.shaAsset.browser_download_url);
        const expected = shaText.trim().split(/\s+/)[0];
        const actual = await this.sha256File(tmpArchive);
        if (expected.toLowerCase() !== actual.toLowerCase()) {
          fs.unlinkSync(tmpArchive);
          throw new Error('ffmpeg checksum mismatch — the download may be corrupted');
        }
      } catch (e) {
        if (/checksum mismatch/.test(e.message)) throw e;
        // else: sidecar sha file unreachable/unparseable, continue anyway
      }
    }

    this.emitProgress('ffmpeg', 'extracting', { percent: 0 });
    const extractDir = path.join(this.binDir, '_ffmpeg_extract');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    if (this.platform === 'win32') {
      this.unzipSync(tmpArchive, extractDir, (percent) => this.emitProgress('ffmpeg', 'extracting', { percent }));
    } else {
      // Linux ships as .tar.xz — no pure-JS XZ decompressor here, so this
      // one still shells out to the system `tar` (present on virtually
      // every distro). It's timeout-guarded like every other spawned
      // command in this file, so a hang here fails loudly instead of
      // freezing the app.
      await this.runCmd('tar', ['-xJf', tmpArchive, '-C', extractDir]);
    }

    const found = this.findFileRecursive(extractDir, this.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!found) throw new Error('ffmpeg binary not found inside the downloaded archive');
    fs.copyFileSync(found, this.ffmpegPath);
    if (this.platform !== 'win32') fs.chmodSync(this.ffmpegPath, 0o755);

    fs.unlinkSync(tmpArchive);
    fs.rmSync(extractDir, { recursive: true, force: true });

    const manifest = this.readManifest();
    manifest.ffmpeg = { version: meta.buildId, buildId: meta.buildId, downloadedAt: new Date().toISOString() };
    this.writeManifest(manifest);
    this.emitProgress('ffmpeg', 'done', { version: meta.buildId });
  }

  // -------------------------------------------------------------------
  // Small utilities (also reused by potProvider in main.js)
  // -------------------------------------------------------------------
  findFileRecursive(dir, name) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = this.findFileRecursive(full, name);
        if (found) return found;
      } else if (entry.name.toLowerCase() === name.toLowerCase()) {
        return full;
      }
    }
    return null;
  }

  runCmd(cmd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { windowsHide: true });
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        reject(new Error(`${cmd} timed out after ${CMD_TIMEOUT_MS / 1000}s (possibly stuck behind antivirus scanning) — try again, or check your security software`));
      }, CMD_TIMEOUT_MS);

      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-300)}`));
      });
    });
  }

  /**
   * Minimal, dependency-free ZIP extractor. Supports the two compression
   * methods every real-world zip we deal with uses — 0 (stored) and 8
   * (deflate) — which covers both BtbN/FFmpeg-Builds' Windows zips and
   * evermeet.cx's macOS zips. Does NOT support Zip64, encryption, or
   * multi-part archives — none of our known sources use those.
   */
  unzipSync(zipPath, destDir, onProgress) {
    const buf = fs.readFileSync(zipPath);

    const EOCD_SIG = 0x06054b50;
    const searchStart = Math.max(0, buf.length - 22 - 65535);
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= searchStart; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) throw new Error('Not a valid zip file (end-of-central-directory record not found)');

    const totalEntries = buf.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

    const entries = [];
    let pos = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Corrupt zip central directory');
      const method = buf.readUInt16LE(pos + 10);
      const compressedSize = buf.readUInt32LE(pos + 20);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localHeaderOffset = buf.readUInt32LE(pos + 42);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
      entries.push({ name, method, compressedSize, localHeaderOffset });
      pos += 46 + nameLen + extraLen + commentLen;
    }

    entries.forEach((entry, idx) => {
      const outPath = path.join(destDir, entry.name);
      if (entry.name.endsWith('/')) {
        fs.mkdirSync(outPath, { recursive: true });
        return;
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      const lh = entry.localHeaderOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`Corrupt local file header for ${entry.name}`);
      const lhNameLen = buf.readUInt16LE(lh + 26);
      const lhExtraLen = buf.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      const compData = buf.subarray(dataStart, dataStart + entry.compressedSize);

      let outData;
      if (entry.method === 0) outData = compData;
      else if (entry.method === 8) outData = zlib.inflateRawSync(compData);
      else throw new Error(`Unsupported zip compression method (${entry.method}) for ${entry.name}`);

      fs.writeFileSync(outPath, outData);
      if (onProgress) onProgress(Math.round(((idx + 1) / entries.length) * 100));
    });
  }

  sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * GitHub's API returns plain HTTP 403 for rate-limiting (not 429), which
   * otherwise looks like a generic, unhelpful failure. When the response
   * headers show this is specifically a rate limit, surface the actual
   * reset time instead of a vague "check your connection" message.
   */
  describeHttpFailure(res, url, body) {
    const isGitHubApi = /^https:\/\/api\.github\.com\//.test(url);
    const remaining = res.headers['x-ratelimit-remaining'];
    const resetHeader = res.headers['x-ratelimit-reset'];

    if (isGitHubApi && res.statusCode === 403 && remaining === '0' && resetHeader) {
      const resetDate = new Date(parseInt(resetHeader, 10) * 1000);
      const minutesLeft = Math.max(1, Math.ceil((resetDate.getTime() - Date.now()) / 60000));
      return `GitHub's API rate limit was hit while checking for updates. This resets at ${resetDate.toLocaleTimeString()} (about ${minutesLeft} min from now) — please try again after that.`;
    }

    return `Request failed: HTTP ${res.statusCode} for ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`;
  }

  httpsGetJSON(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const req = https.get(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json, application/json' }
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return resolve(this.httpsGetJSON(res.headers.location, redirects + 1));
        }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(this.describeHttpFailure(res, url, body)));
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Could not parse JSON response from ${url}: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    });
  }

  downloadText(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return resolve(this.downloadText(res.headers.location, redirects + 1));
        }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Request failed: HTTP ${res.statusCode} for ${url}`));
          resolve(body);
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
    });
  }

  downloadToFile(url, destPath, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));

      const file = fs.createWriteStream(destPath);
      const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          file.close();
          fs.unlink(destPath, () => {});
          res.resume();
          return resolve(this.downloadToFile(res.headers.location, destPath, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total && onProgress) onProgress(Math.min(100, Math.round((received / total) * 100)));
        });
        res.on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      });
      req.on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
      req.setTimeout(30000, () => req.destroy(new Error('Download timed out')));
    });
  }
}

module.exports = { BinaryManager };
