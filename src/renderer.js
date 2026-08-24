(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let settings = {};
  let currentInfo = null;
  let currentMode = 'video';
  let selectedHeight = null;
  let selectedAudioFormat = 'mp3';
  let selectedAudioQuality = '0';
  let subtitlesOn = false;
  let sponsorBlockOn = false;
  let selectedPlaylistIds = new Set();
  let trimStartVal = '';
  let trimEndVal = '';

  const pendingQueue = [];
  let activeCount = 0;
  const jobRegistry = new Map();

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

  function uid() { return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

  function fmtDuration(sec) {
    if (!sec && sec !== 0) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function toast(message, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`.trim();
    el.textContent = message;
    $('#toast-container').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3800);
  }

  function buildPulsebar() {
    const track = $('#pulsebar-track');
    track.innerHTML = '';
    const bars = 42;
    for (let i = 0; i < bars; i++) {
      const s = document.createElement('span');
      const h = 6 + Math.round(Math.sin(i * 0.7) * 4 + 8);
      s.style.height = `${h}px`;
      s.style.animationDelay = `${(i % 12) * 0.08}s`;
      track.appendChild(s);
    }
  }
  buildPulsebar();

  // ---------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nexgrab-theme', theme);
  }
  $('#btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    window.nex.setSettings({ theme: next });
  });

  // ---------------------------------------------------------------------
  // Init settings
  // ---------------------------------------------------------------------
  async function initSettings() {
    settings = await window.nex.getSettings();
    applyTheme(localStorage.getItem('nexgrab-theme') || settings.theme || 'dark');

    $('#output-dir').value = settings.outputDir;
    $('#cookies-browser').value = settings.cookiesFromBrowser || '';
    $('#cookies-file').value = settings.cookiesFilePath || '';
    updateSignInStatus();
    $('#concurrency').value = settings.concurrency;
    $('#concurrency-val').textContent = settings.concurrency;
    $('#rate-limit').value = settings.rateLimit || '';
    $('#toggle-thumbnail').checked = settings.embedThumbnail;
    $('#toggle-metadata').checked = settings.embedMetadata;
    $('#toggle-clipboard').checked = settings.clipboardWatch;
    $('#toggle-sponsorblock').checked = settings.sponsorBlock;
    sponsorBlockOn = settings.sponsorBlock;
    $('#toggle-minimize-tray').checked = settings.minimizeToTray !== false;
    $('#toggle-close-tray').checked = settings.closeToTray !== false;
  }

  async function checkYtDlp() {
    const status = $('#ytdlp-status');
    const res = await window.nex.checkYtDlp();
    if (res.ok) {
      status.textContent = `yt-dlp ${res.version} ready`;
      status.className = 'hint-line ok';
    } else {
      status.textContent = `yt-dlp isn't ready yet — it may still be downloading (see the setup screen), or check your internet connection and retry from Settings → Dependencies.`;
      status.className = 'hint-line err';
    }
  }

  initSettings().then(() => { checkYtDlp(); refreshDepsStatus(); });
  refreshPotStatus();

  // ---------------------------------------------------------------------
  // Dependencies (auto-downloaded yt-dlp / ffmpeg) — first-launch overlay
  // + Settings → Dependencies panel
  // ---------------------------------------------------------------------
  let depsOverlayShown = false;
  let initialSetupDone = false;

  function showDepsOverlay() {
    depsOverlayShown = true;
    $('#deps-overlay').style.display = 'flex';
    bumpStuckWatchdog();
  }
  function hideDepsOverlay() {
    depsOverlayShown = false;
    $('#deps-overlay').style.display = 'none';
    $('#deps-overlay-error').hidden = true;
    $('#deps-overlay-retry').style.display = 'none';
    $('#deps-overlay-stuck-hint').hidden = true;
    clearTimeout(stuckTimer);
  }

  window.nex.onDepsProgress((data) => {
    // Once initial setup has completed, later progress events only come
    // from a background update check (daily, or after a manual "Check for
    // updates" click) — those already have their own toast via
    // onDepsAutoUpdated below, so they shouldn't pop the blocking
    // first-launch overlay back up with no matching "ready" signal to
    // close it again.
    if (initialSetupDone) return;

    // Any progress event at all means a real download/extract is happening
    // (already-installed binaries never emit these) — show the overlay.
    if (!depsOverlayShown) showDepsOverlay();
    const label = data.component === 'yt-dlp' ? 'yt-dlp' : 'ffmpeg';
    const text = $('#deps-overlay-text');
    const fill = $('#deps-overlay-fill');
    bumpStuckWatchdog();

    if (data.phase === 'downloading') {
      const pct = data.percent || 0;
      text.textContent = `Setting up dependencies… ${label} ${pct}%`;
      fill.style.width = `${pct}%`;
    } else if (data.phase === 'verifying') {
      text.textContent = `Verifying ${label}…`;
    } else if (data.phase === 'extracting') {
      // Real per-file percentage now (not an instant jump to 100%) — a zip
      // with hundreds of small files can still take a little while if
      // antivirus scans each one as it's written, so this keeps the bar
      // honestly reflecting progress instead of looking frozen at 100%.
      const pct = typeof data.percent === 'number' ? data.percent : 0;
      text.textContent = `Extracting ${label}… ${pct}%`;
      fill.style.width = `${pct}%`;
    } else if (data.phase === 'update-found') {
      text.textContent = `Updating ${label}…`;
    } else if (data.phase === 'done') {
      text.textContent = `${label} ready`;
      fill.style.width = '100%';
    }
  });

  // Safety net: if we haven't heard a progress update in a while, the user
  // shouldn't be left staring at a spinner with no idea whether it's still
  // working or has silently hung. Surface a reassurance message, then an
  // actual way out, rather than requiring a force-quit.
  let stuckTimer = null;
  function bumpStuckWatchdog() {
    clearTimeout(stuckTimer);
    $('#deps-overlay-stuck-hint').hidden = true;
    $('#deps-overlay-retry').style.display = 'none';
    stuckTimer = setTimeout(() => {
      $('#deps-overlay-stuck-hint').hidden = false;
      $('#deps-overlay-retry').style.display = 'inline-flex';
    }, 45000);
  }

  window.nex.onDepsReady((data) => {
    if (data.ok) {
      initialSetupDone = true;
      hideDepsOverlay();
      checkYtDlp();
      refreshDepsStatus();
    } else {
      // Keep the overlay up with a clear error + retry button rather than
      // letting the app proceed with no working yt-dlp/ffmpeg. Initial
      // setup has NOT succeeded yet, so progress events (e.g. from the
      // user clicking Retry) should still be able to drive this overlay.
      initialSetupDone = false;
      showDepsOverlay();
      $('#deps-overlay-text').textContent = 'Setup failed';
      $('#deps-overlay-error').hidden = false;
      $('#deps-overlay-error').textContent = data.error || "Couldn't download required components. Check your internet connection and retry.";
      $('#deps-overlay-retry').style.display = 'inline-flex';
    }
  });

  window.nex.onDepsAutoUpdated(() => {
    toast('yt-dlp / ffmpeg updated in the background', 'success');
    refreshDepsStatus();
  });

  $('#deps-overlay-retry').addEventListener('click', async () => {
    $('#deps-overlay-error').hidden = true;
    $('#deps-overlay-retry').style.display = 'none';
    $('#deps-overlay-text').textContent = 'Setting up dependencies…';
    $('#deps-overlay-fill').style.width = '0%';
    const res = await window.nex.redownloadDeps();
    if (res.ok) { initialSetupDone = true; hideDepsOverlay(); checkYtDlp(); refreshDepsStatus(); }
    else {
      $('#deps-overlay-text').textContent = 'Setup failed';
      $('#deps-overlay-error').hidden = false;
      $('#deps-overlay-error').textContent = res.error;
      $('#deps-overlay-retry').style.display = 'inline-flex';
    }
  });

  async function refreshDepsStatus() {
    const status = await window.nex.getDepsStatus();
    $('#dep-ytdlp-version').textContent = status.ytdlp.installed ? (status.ytdlp.version || 'installed') : 'not installed';
    $('#dep-ffmpeg-version').textContent = status.ffmpeg.installed ? (status.ffmpeg.version || 'installed') : 'not installed';
  }

  $('#deps-check-btn').addEventListener('click', async () => {
    const btn = $('#deps-check-btn');
    const line = $('#deps-status-line');
    btn.disabled = true;
    line.textContent = 'Checking for updates…';
    line.className = 'hint-line';
    const res = await window.nex.checkDepsUpdates();
    btn.disabled = false;
    if (!res.ok) {
      line.textContent = `Update check failed: ${res.error}`;
      line.className = 'hint-line err';
      return;
    }
    const updated = [];
    if (res.ytdlp.updated) updated.push(`yt-dlp → ${res.ytdlp.version}`);
    if (res.ffmpeg.updated) updated.push(`ffmpeg → ${res.ffmpeg.version}`);
    line.textContent = updated.length ? `Updated: ${updated.join(', ')}` : 'Already up to date';
    line.className = 'hint-line ok';
    refreshDepsStatus();
  });

  $('#deps-redownload-btn').addEventListener('click', async () => {
    const btn = $('#deps-redownload-btn');
    const line = $('#deps-status-line');
    btn.disabled = true;
    line.textContent = 'Re-downloading yt-dlp and ffmpeg…';
    line.className = 'hint-line';
    const res = await window.nex.redownloadDeps();
    btn.disabled = false;
    if (res.ok) {
      line.textContent = 'Re-download complete';
      line.className = 'hint-line ok';
      checkYtDlp();
    } else {
      line.textContent = res.error;
      line.className = 'hint-line err';
    }
    refreshDepsStatus();
  });

  // ---------------------------------------------------------------------
  // Optional local PO Token provider sidecar
  // ---------------------------------------------------------------------
  async function refreshPotStatus() {
    const res = await window.nex.getPotStatus();
    $('#toggle-pot-provider').checked = !!res.enabled;
    updatePotStatusLine(res);
  }

  function updatePotStatusLine(res) {
    const line = $('#pot-provider-status');
    if (!res.enabled) { line.textContent = ''; return; }
    if (res.error) { line.textContent = `Couldn't start the PO Token provider: ${res.error}`; line.className = 'hint-line err'; return; }
    line.textContent = res.running ? 'Provider running locally' : 'Starting…';
    line.className = 'hint-line ok';
  }

  $('#toggle-pot-provider').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    $('#pot-provider-status').textContent = enabled ? 'Starting…' : '';
    const res = await window.nex.togglePotProvider(enabled);
    if (enabled && res.error) e.target.checked = false;
    updatePotStatusLine({ enabled, ...res });
  });

  // ---------------------------------------------------------------------
  // Settings drawer
  // ---------------------------------------------------------------------
  function openDrawer(id) { $(`#${id}-backdrop`).hidden = false; $(`#${id}-drawer`).hidden = false; }
  function closeDrawer(id) { $(`#${id}-backdrop`).hidden = true; $(`#${id}-drawer`).hidden = true; }

  $('#btn-settings').addEventListener('click', () => openDrawer('settings'));
  $('#close-settings').addEventListener('click', () => closeDrawer('settings'));
  $('#settings-backdrop').addEventListener('click', () => closeDrawer('settings'));

  $('#btn-history').addEventListener('click', async () => { openDrawer('history'); await renderHistory(); });
  $('#close-history').addEventListener('click', () => closeDrawer('history'));
  $('#history-backdrop').addEventListener('click', () => closeDrawer('history'));

  $('#choose-folder-btn').addEventListener('click', async () => {
    const dir = await window.nex.chooseFolder();
    if (dir) { $('#output-dir').value = dir; settings.outputDir = dir; }
  });

  $('#cookies-browser').addEventListener('change', async (e) => {
    settings = await window.nex.setSettings({ cookiesFromBrowser: e.target.value });
  });

  $('#choose-cookies-file-btn').addEventListener('click', async () => {
    const filePath = await window.nex.chooseCookiesFile();
    if (filePath) {
      $('#cookies-file').value = filePath;
      settings.cookiesFilePath = filePath;
      updateSignInStatus();
    }
  });

  // ---------------------------------------------------------------------
  // "Sign in to YouTube" — embedded login window, no browser/cookies fiddling
  // ---------------------------------------------------------------------
  function updateSignInStatus() {
    const el = $('#youtube-signin-status');
    const btn = $('#youtube-signin-btn');
    if (settings.cookiesFilePath) {
      el.textContent = '✓ Signed in';
      el.className = 'hint-line ok';
      btn.textContent = 'Sign in again';
    } else {
      el.textContent = 'Not signed in — needed if downloads fail with "not a bot" errors.';
      el.className = 'hint-line';
      btn.textContent = 'Sign in to YouTube';
    }
  }

  $('#youtube-signin-btn').addEventListener('click', async () => {
    $('#youtube-signin-btn').disabled = true;
    $('#youtube-signin-status').textContent = 'Opening sign-in window…';
    $('#youtube-signin-status').className = 'hint-line';
    await window.nex.startYoutubeSignIn();
  });

  window.nex.onAuthStatus(async (data) => {
    const statusEl = $('#youtube-signin-status');
    const btn = $('#youtube-signin-btn');
    btn.disabled = false;

    if (data.status === 'opened') {
      statusEl.textContent = 'Log in with your Google account in the window that opened…';
    } else if (data.status === 'success') {
      settings = await window.nex.getSettings();
      $('#cookies-file').value = settings.cookiesFilePath || '';
      $('#cookies-browser').value = '';
      updateSignInStatus();
      toast('Signed in to YouTube', 'success');
    } else if (data.status === 'cancelled') {
      statusEl.textContent = 'Sign-in window closed — not signed in.';
      statusEl.className = 'hint-line';
    } else if (data.status === 'error') {
      statusEl.textContent = `Sign-in failed: ${data.message || 'unknown error'}. If Google keeps blocking the popup, use "Cookies from browser" below instead — sign in to YouTube in Chrome/Edge/Firefox normally, then pick that browser here.`;
      statusEl.className = 'hint-line err';
    }
  });

  $('#concurrency').addEventListener('input', (e) => { $('#concurrency-val').textContent = e.target.value; });
  $('#concurrency').addEventListener('change', async (e) => {
    settings = await window.nex.setSettings({ concurrency: parseInt(e.target.value, 10) });
    drainQueue();
  });

  $('#rate-limit').addEventListener('change', async (e) => {
    settings = await window.nex.setSettings({ rateLimit: e.target.value.trim() });
  });

  [['toggle-thumbnail', 'embedThumbnail'], ['toggle-metadata', 'embedMetadata'],
   ['toggle-clipboard', 'clipboardWatch'], ['toggle-minimize-tray', 'minimizeToTray'],
   ['toggle-close-tray', 'closeToTray']].forEach(([id, key]) => {
    $(`#${id}`).addEventListener('change', async (e) => {
      settings = await window.nex.setSettings({ [key]: e.target.checked });
    });
  });
  $('#toggle-sponsorblock').addEventListener('change', async (e) => {
    sponsorBlockOn = e.target.checked;
    settings = await window.nex.setSettings({ sponsorBlock: sponsorBlockOn });
  });

  $('#clear-history-btn').addEventListener('click', async () => {
    await window.nex.clearHistory();
    renderHistory();
    toast('History cleared');
  });

  // ---------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------
  async function renderHistory(filter = '') {
    const list = $('#history-list');
    const items = await window.nex.getHistory();
    const f = filter.trim().toLowerCase();
    const filtered = f ? items.filter((i) => i.title.toLowerCase().includes(f)) : items;

    if (!filtered.length) {
      list.innerHTML = `<div class="queue-empty">No downloads yet.</div>`;
      return;
    }
    list.innerHTML = filtered.map((i) => `
      <div class="history-item" data-path="${encodeURIComponent(i.path)}">
        <p class="h-title">${escapeHtml(i.title)}</p>
        <div class="h-meta"><span>${i.mode === 'audio' ? '🎧' : '🎬'} ${escapeHtml(i.quality)}</span><span>${new Date(i.date).toLocaleDateString()}</span></div>
      </div>
    `).join('');

    $$('.history-item').forEach((el) => {
      el.addEventListener('click', () => window.nex.openFolder(decodeURIComponent(el.dataset.path)));
      el.style.cursor = 'pointer';
    });
  }
  $('#history-search').addEventListener('input', (e) => renderHistory(e.target.value));

  function escapeHtml(str = '') {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------
  // Clipboard auto-detect
  // ---------------------------------------------------------------------
  window.nex.onClipboardUrl((url) => {
    if ($('#url-input').value.trim() === url) return;
    $('#url-input').value = url;
    toast('YouTube link detected from clipboard');
  });

  $('#paste-btn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) $('#url-input').value = text.trim();
    } catch { toast('Could not read clipboard', 'error'); }
  });

  // ---------------------------------------------------------------------
  // Fetch info
  // ---------------------------------------------------------------------
  $('#url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });
  $('#fetch-btn').addEventListener('click', fetchInfo);

  window.nex.onFetchProgress((data) => {
    $('#ytdlp-status').textContent = data.message;
  });

  async function fetchInfo() {
    const url = $('#url-input').value.trim();
    if (!url) { toast('Paste a YouTube link first'); return; }

    const statusBeforeFetch = $('#ytdlp-status').textContent;
    setFetching(true);
    const res = await window.nex.fetchInfo(url);
    setFetching(false);
    $('#ytdlp-status').textContent = statusBeforeFetch;

    if (!res.ok) {
      toast(`Could not fetch info: ${res.error.slice(0, 160)}`, 'error');
      return;
    }
    currentInfo = res;
    selectedPlaylistIds = new Set();

    if (res.kind === 'playlist') renderPlaylistPreview(res);
    else renderVideoPreview(res);
  }

  function setFetching(on) {
    $('#fetch-btn').disabled = on;
    $('.btn-label', $('#fetch-btn')).hidden = on;
    $('.btn-spinner', $('#fetch-btn')).hidden = !on;
    $('#pulsebar').classList.toggle('active', on);
  }

  // ---------------------------------------------------------------------
  // Video preview + config
  // ---------------------------------------------------------------------
  function renderVideoPreview(info) {
    currentMode = 'video';
    selectedHeight = info.availableHeights[0] || 'best';
    subtitlesOn = false;
    trimStartVal = '';
    trimEndVal = '';

    const preview = $('#preview');
    preview.hidden = false;
    preview.innerHTML = `
      <div class="video-card">
        <img class="video-thumb" src="${info.thumbnail || ''}" onerror="this.style.visibility='hidden'"/>
        <div class="video-meta">
          <p class="video-title">${escapeHtml(info.title)}</p>
          <p class="video-sub">${escapeHtml(info.uploader || '')}<span class="dot">•</span>${fmtDuration(info.duration)}</p>

          <div class="mode-switch">
            <button data-mode="video" class="active">🎬 Video</button>
            <button data-mode="audio">🎧 Audio only</button>
          </div>

          <div id="quality-area"></div>
          <div id="opts-area"></div>

          <div class="btn-row">
            <button class="primary-btn" id="download-now-btn">⬇ Download now</button>
            <button class="ghost-btn add-queue-btn" id="add-to-queue-btn">+ Add to queue</button>
          </div>
        </div>
      </div>
    `;

    renderQualityArea(info);
    renderOptsArea(info);

    $$('.mode-switch button', preview).forEach((btn) => {
      btn.addEventListener('click', () => {
        currentMode = btn.dataset.mode;
        $$('.mode-switch button', preview).forEach((b) => b.classList.toggle('active', b === btn));
        renderQualityArea(info);
        renderOptsArea(info);
      });
    });

    $('#add-to-queue-btn').addEventListener('click', () => enqueueSingle(info));

    $('#download-now-btn').addEventListener('click', async () => {
      const dir = await window.nex.chooseFolderOnce();
      if (!dir) { toast('Download cancelled — no folder selected'); return; }
      enqueueSingle(info, dir);
    });
  }

  function renderQualityArea(info) {
    const area = $('#quality-area');
    if (currentMode === 'video') {
      const heights = info.availableHeights.length ? info.availableHeights : [1080, 720, 480];
      area.innerHTML = `<div class="chip-row">${heights.map((h) => `
          <button class="chip ${h === selectedHeight ? 'selected' : ''}" data-h="${h}">${h}p${h >= 2160 ? ' 4K' : ''}</button>
        `).join('')}<button class="chip ${selectedHeight === 'best' ? 'selected' : ''}" data-h="best">Best available</button></div>`;
      $$('.chip', area).forEach((c) => c.addEventListener('click', () => {
        selectedHeight = c.dataset.h === 'best' ? 'best' : parseInt(c.dataset.h, 10);
        $$('.chip', area).forEach((x) => x.classList.remove('selected'));
        c.classList.add('selected');
      }));
    } else {
      const formats = [
        { id: 'mp3', label: 'MP3' }, { id: 'm4a', label: 'M4A' },
        { id: 'opus', label: 'Opus' }, { id: 'flac', label: 'FLAC (lossless)' }, { id: 'wav', label: 'WAV' }
      ];
      area.innerHTML = `<div class="chip-row">${formats.map((f) => `
          <button class="chip" data-audio="1" data-f="${f.id}" ${f.id === selectedAudioFormat ? 'style="background:var(--teal);border-color:var(--teal);color:#06201c"' : ''}>${f.label}</button>
        `).join('')}</div>
        <div class="chip-row">${['320', '256', '192', '128', '0'].map((q) => `
          <button class="chip" data-audio="1" data-q="${q}" ${q === selectedAudioQuality ? 'style="background:var(--teal);border-color:var(--teal);color:#06201c"' : ''}>${q === '0' ? 'Best' : q + ' kbps'}</button>
        `).join('')}</div>`;

      $$('.chip[data-f]', area).forEach((c) => c.addEventListener('click', () => {
        selectedAudioFormat = c.dataset.f;
        $$('.chip[data-f]', area).forEach((x) => { x.style.background = ''; x.style.borderColor = ''; x.style.color = ''; });
        c.style.background = 'var(--teal)'; c.style.borderColor = 'var(--teal)'; c.style.color = '#06201c';
      }));
      $$('.chip[data-q]', area).forEach((c) => c.addEventListener('click', () => {
        selectedAudioQuality = c.dataset.q;
        $$('.chip[data-q]', area).forEach((x) => { x.style.background = ''; x.style.borderColor = ''; x.style.color = ''; });
        c.style.background = 'var(--teal)'; c.style.borderColor = 'var(--teal)'; c.style.color = '#06201c';
      }));
    }
  }

  function renderOptsArea(info) {
    const area = $('#opts-area');
    const subLabel = info.hasSubtitles ? `Download subtitles (${info.subtitleLangs.slice(0, 3).join(', ')})` : 'Download subtitles (none found)';
    area.innerHTML = `
      <div class="opt-row">
        <label class="opt-pill ${subtitlesOn ? 'on' : ''}">
          <input type="checkbox" id="opt-subs" ${subtitlesOn ? 'checked' : ''} ${info.hasSubtitles ? '' : 'disabled'}/> ${subLabel}
        </label>
        <label class="opt-pill ${sponsorBlockOn ? 'on' : ''}" ${currentMode === 'audio' ? 'style="display:none"' : ''}>
          <input type="checkbox" id="opt-sponsorblock" ${sponsorBlockOn ? 'checked' : ''}/> Skip sponsor segments
        </label>
      </div>
      <div class="trim-row">
        <span>Clip:</span>
        <input type="text" id="opt-trim-start" placeholder="00:00" value="${escapeHtml(trimStartVal)}"/>
        <span>to</span>
        <input type="text" id="opt-trim-end" placeholder="end" value="${escapeHtml(trimEndVal)}"/>
        <span>(optional — leave blank for full video)</span>
      </div>
    `;
    $('#opt-subs').addEventListener('change', (e) => { subtitlesOn = e.target.checked; });
    $('#opt-sponsorblock').addEventListener('change', (e) => { sponsorBlockOn = e.target.checked; });
    $('#opt-trim-start').addEventListener('input', (e) => { trimStartVal = e.target.value.trim(); });
    $('#opt-trim-end').addEventListener('input', (e) => { trimEndVal = e.target.value.trim(); });
  }

  function enqueueSingle(info, forcedOutputDir) {
    const trimStart = trimStartVal;
    const trimEnd = trimEndVal;

    const job = {
      jobId: uid(),
      url: info.url,
      title: info.title,
      thumbnail: info.thumbnail,
      mode: currentMode,
      height: selectedHeight,
      container: 'mp4',
      audioFormat: selectedAudioFormat,
      audioQuality: selectedAudioQuality,
      subtitles: subtitlesOn,
      subLangs: (info.subtitleLangs && info.subtitleLangs[0]) || 'en.*',
      sponsorBlock: sponsorBlockOn,
      trimStart, trimEnd,
      outputDir: forcedOutputDir || settings.outputDir,
      embedThumbnail: settings.embedThumbnail,
      embedMetadata: settings.embedMetadata,
      rateLimit: settings.rateLimit
    };
    addJobToUI(job);
    pendingQueue.push(job);
    drainQueue();
    toast(forcedOutputDir ? `Downloading to ${forcedOutputDir}` : 'Added to queue', 'success');
  }

  // ---------------------------------------------------------------------
  // Playlist preview + config
  // ---------------------------------------------------------------------
  function renderPlaylistPreview(info) {
    currentMode = 'video';
    subtitlesOn = false;
    trimStartVal = '';
    trimEndVal = '';
    const preview = $('#preview');
    preview.hidden = false;
    info.entries.forEach((e) => selectedPlaylistIds.add(e.id));

    preview.innerHTML = `
      <div class="video-card">
        <div class="video-meta" style="width:100%">
          <p class="video-title">${escapeHtml(info.title)}</p>
          <p class="video-sub">Playlist<span class="dot">•</span>${info.entries.length} videos</p>

          <div class="playlist-actions">
            <span class="video-sub" style="margin:0">Select which videos to download</span>
            <button class="link-btn" id="pl-select-all">Select all / none</button>
          </div>

          <div class="playlist-list">
            ${info.entries.map((e) => `
              <label class="playlist-item">
                <input type="checkbox" data-id="${e.id}" checked />
                <img src="${e.thumbnail || ''}" onerror="this.style.visibility='hidden'"/>
                <span class="pl-title">${escapeHtml(e.title)}</span>
                <span class="hint-line" style="margin:0">${fmtDuration(e.duration)}</span>
              </label>
            `).join('')}
          </div>

          <div class="mode-switch">
            <button data-mode="video" class="active">🎬 Video</button>
            <button data-mode="audio">🎧 Audio only</button>
          </div>

          <div id="quality-area"></div>
          <div id="opts-area"></div>

          <button class="primary-btn add-queue-btn" id="add-playlist-btn">+ Add selected to queue (each video downloads separately)</button>
        </div>
      </div>
    `;

    const fakeInfoForOptions = { hasSubtitles: false, subtitleLangs: [] };
    renderQualityArea({ availableHeights: [1080, 720, 480, 360] });
    renderOptsArea(fakeInfoForOptions);

    $$('.mode-switch button', preview).forEach((btn) => {
      btn.addEventListener('click', () => {
        currentMode = btn.dataset.mode;
        $$('.mode-switch button', preview).forEach((b) => b.classList.toggle('active', b === btn));
        renderQualityArea({ availableHeights: [1080, 720, 480, 360] });
        renderOptsArea(fakeInfoForOptions);
      });
    });

    $$('.playlist-item input', preview).forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedPlaylistIds.add(cb.dataset.id);
        else selectedPlaylistIds.delete(cb.dataset.id);
      });
    });

    let allSelected = true;
    $('#pl-select-all').addEventListener('click', () => {
      allSelected = !allSelected;
      $$('.playlist-item input', preview).forEach((cb) => {
        cb.checked = allSelected;
        if (allSelected) selectedPlaylistIds.add(cb.dataset.id); else selectedPlaylistIds.delete(cb.dataset.id);
      });
    });

    $('#add-playlist-btn').addEventListener('click', () => {
      const chosen = info.entries.filter((e) => selectedPlaylistIds.has(e.id));
      if (!chosen.length) { toast('Select at least one video'); return; }
      const trimStart = trimStartVal, trimEnd = trimEndVal;
      chosen.forEach((e) => {
        const job = {
          jobId: uid(),
          url: e.url,
          title: e.title,
          thumbnail: e.thumbnail,
          mode: currentMode,
          height: selectedHeight,
          container: 'mp4',
          audioFormat: selectedAudioFormat,
          audioQuality: selectedAudioQuality,
          subtitles: subtitlesOn,
          subLangs: 'en.*',
          sponsorBlock: sponsorBlockOn,
          trimStart, trimEnd,
          outputDir: settings.outputDir,
          embedThumbnail: settings.embedThumbnail,
          embedMetadata: settings.embedMetadata,
          rateLimit: settings.rateLimit
        };
        addJobToUI(job);
        pendingQueue.push(job);
      });
      drainQueue();
      toast(`Added ${chosen.length} videos to queue`, 'success');
    });
  }

  // ---------------------------------------------------------------------
  // Queue engine (respects settings.concurrency)
  // ---------------------------------------------------------------------
  function addJobToUI(job) {
    $('#queue-empty').hidden = true;
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.id = job.jobId;
    el.innerHTML = `
      <img src="${job.thumbnail || ''}" onerror="this.style.visibility='hidden'"/>
      <div class="qi-body">
        <p class="qi-title" id="title-${job.jobId}">${escapeHtml(job.title)}</p>
        <div class="qi-status">
          <span class="qi-tag ${job.mode}">${job.mode}</span>
          <span class="qi-state">Waiting…</span>
        </div>
        <div class="qi-bar"><div class="qi-bar-fill"></div></div>
      </div>
      <div class="qi-actions">
        <button class="qi-cancel" title="Cancel">✕</button>
      </div>
    `;
    // Retry button is inserted here on failure, see addRetryButton() below.
    $('#queue-list').prepend(el);
    jobRegistry.set(job.jobId, { el, job });

    el.querySelector('.qi-cancel').addEventListener('click', async () => {
      await window.nex.cancelDownload(job.jobId);
      const idx = pendingQueue.findIndex((j) => j.jobId === job.jobId);
      if (idx > -1) pendingQueue.splice(idx, 1);
      el.querySelector('.qi-state').textContent = 'Cancelled';
      el.querySelector('.qi-bar-fill').classList.add('error');
      updateQueueCount();
    });

    updateQueueCount();
  }

  function updateQueueCount() {
    $('#queue-count').textContent = `${activeCount} active · ${pendingQueue.length} waiting`;
  }

  async function drainQueue() {
    const limit = settings.concurrency || 2;
    while (activeCount < limit && pendingQueue.length) {
      const job = pendingQueue.shift();
      activeCount++;
      updateQueueCount();
      const reg = jobRegistry.get(job.jobId);
      if (reg) reg.el.querySelector('.qi-state').textContent = 'Starting…';
      await window.nex.startDownload(job);
    }
  }

  window.nex.onProgress((data) => {
    const reg = jobRegistry.get(data.jobId);
    if (!reg) return;
    const { el } = reg;
    const stateEl = el.querySelector('.qi-state');
    const fill = el.querySelector('.qi-bar-fill');

    switch (data.status) {
      case 'downloading':
        stateEl.textContent = `${data.percent.toFixed(1)}% · ${data.speed} · ETA ${data.eta}`;
        fill.style.width = `${data.percent}%`;
        break;
      case 'merging':
        stateEl.textContent = 'Merging audio & video…';
        fill.style.width = '99%';
        break;
      case 'retrying':
        stateEl.textContent = data.message || 'Retrying with a different client…';
        break;
      case 'exists':
        stateEl.textContent = 'Already downloaded — click title to open';
        fill.style.width = '100%';
        fill.classList.add('done');
        makeTitleClickable(data.jobId, data.path);
        finishJob(data.jobId);
        break;
      case 'done':
        stateEl.textContent = 'Done ✓ — click title to open';
        fill.style.width = '100%';
        fill.classList.add('done');
        makeTitleClickable(data.jobId, data.path);
        finishJob(data.jobId);
        break;
      case 'error':
        stateEl.textContent = `Failed — ${(data.error || '').slice(0, 90)}`;
        fill.classList.add('error');
        if (data.retryable) addRetryButton(data.jobId);
        finishJob(data.jobId);
        break;
    }
  });

  // Playlist/queue items that fail (e.g. an individual video still blocked
  // after exhausting every client fallback) get a retry button instead of
  // dead-ending — clicking it just re-queues the same job. The rest of the
  // queue is never stopped by one item's failure; each job already runs
  // independently in the queue engine above.
  function addRetryButton(jobId) {
    const reg = jobRegistry.get(jobId);
    if (!reg) return;
    const actions = reg.el.querySelector('.qi-actions');
    if (actions.querySelector('.qi-retry')) return;

    const btn = document.createElement('button');
    btn.className = 'qi-cancel qi-retry';
    btn.title = 'Retry';
    btn.textContent = '↻';
    btn.addEventListener('click', () => {
      btn.remove();
      const fill = reg.el.querySelector('.qi-bar-fill');
      fill.classList.remove('error', 'done');
      fill.style.width = '0%';
      reg.el.querySelector('.qi-state').textContent = 'Waiting…';
      pendingQueue.push(reg.job);
      updateQueueCount();
      drainQueue();
    });
    actions.prepend(btn);
  }

  function makeTitleClickable(jobId, filePath) {
    if (!filePath) return;
    const titleEl = document.getElementById(`title-${jobId}`);
    if (!titleEl) return;
    titleEl.style.cursor = 'pointer';
    titleEl.style.textDecoration = 'underline dotted';
    titleEl.title = filePath;
    titleEl.addEventListener('click', async () => {
      const res = await window.nex.openFolder(filePath);
      if (!res || !res.ok) toast("Couldn't locate that file — it may have been moved or renamed", 'error');
      else if (res.fallback) toast('Opened the folder (exact file not found)');
    });
  }

  function finishJob(jobId) {
    activeCount = Math.max(0, activeCount - 1);
    updateQueueCount();
    drainQueue();
  }

})();
