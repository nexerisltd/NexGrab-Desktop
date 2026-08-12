const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nex', {
  checkYtDlp: () => ipcRenderer.invoke('ytdlp:check'),
  fetchInfo: (url) => ipcRenderer.invoke('ytdlp:fetch-info', url),

  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  chooseFolderOnce: () => ipcRenderer.invoke('dialog:choose-folder-once'),
  chooseCookiesFile: () => ipcRenderer.invoke('dialog:choose-cookies-file'),

  startYoutubeSignIn: () => ipcRenderer.invoke('auth:youtube-signin'),
  youtubeSignOut: () => ipcRenderer.invoke('auth:youtube-signout'),
  onAuthStatus: (cb) => ipcRenderer.on('auth:status', (_e, data) => cb(data)),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),

  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  openFolder: (filePath) => ipcRenderer.invoke('shell:open-folder', filePath),
  openPath: (filePath) => ipcRenderer.invoke('shell:open-path', filePath),

  startDownload: (job) => ipcRenderer.invoke('download:start', job),
  cancelDownload: (jobId) => ipcRenderer.invoke('download:cancel', jobId),

  onProgress: (cb) => ipcRenderer.on('download:progress', (_e, data) => cb(data)),
  onClipboardUrl: (cb) => ipcRenderer.on('clipboard:youtube-url', (_e, url) => cb(url))
});
