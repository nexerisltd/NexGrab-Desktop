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
    $('#concurrency').value = settings.concurrency;
    $('#concurrency-val').textContent = settings.concurrency;
    $('#rate-limit').value = settings.rateLimit || '';
    $('#toggle-thumbnail').checked = settings.embedThumbnail;
    $('#toggle-metadata').checked = settings.embedMetadata;
    $('#toggle-clipboard').checked = settings.clipboardWatch;
    $('#toggle-sponsorblock').checked = settings.sponsorBlock;
    sponsorBlockOn = settings.sponsorBlock;
  }

  async function checkYtDlp() {
    const status = $('#ytdlp-status');
    const res = await window.nex.checkYtDlp();
    if (res.ok) {
      status.textContent = `yt-dlp ${res.version} ready`;
      status.className = 'hint-line ok';
    } else {
      status.textContent = `Bundled yt-dlp not found — reinstall NexGrab or check the assets/bin folder.`;
      status.className = 'hint-line err';
    }
  }

  initSettings().then(checkYtDlp);

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
  if (filePath) { $('#cookies-file').value = filePath; settings.cookiesFilePath = filePath; }
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
   ['toggle-clipboard', 'clipboardWatch']].forEach(([id, key]) => {
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

  async function fetchInfo() {
    const url = $('#url-input').value.trim();
    if (!url) { toast('Paste a YouTube link first'); return; }

    setFetching(true);
    const res = await window.nex.fetchInfo(url);
    setFetching(false);

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
        <input type="text" id="opt-trim-start" placeholder="00:00"/>
        <span>to</span>
        <input type="text" id="opt-trim-end" placeholder="end"/>
        <span>(optional — leave blank for full video)</span>
      </div>
    `;
    $('#opt-subs').addEventListener('change', (e) => { subtitlesOn = e.target.checked; });
    $('#opt-sponsorblock').addEventListener('change', (e) => { sponsorBlockOn = e.target.checked; });
  }

  function enqueueSingle(info, forcedOutputDir) {
    const trimStart = $('#opt-trim-start')?.value.trim() || '';
    const trimEnd = $('#opt-trim-end')?.value.trim() || '';

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
      const trimStart = '', trimEnd = '';
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
        stateEl.textContent = `Error: ${(data.error || '').slice(0, 90)}`;
        fill.classList.add('error');
        finishJob(data.jobId);
        break;
    }
  });

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
