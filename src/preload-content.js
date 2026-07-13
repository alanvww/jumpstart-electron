const { contextBridge, ipcRenderer } = require('electron');

// Minimal API attached to the window that loads remote/user-entered content (and the
// bundled error.html). It deliberately OMITS saveSettings and loadSettings so a
// compromised or malicious remote page cannot persist settings, hijack the kiosk URL,
// or configure OS autostart. Only the local settings window uses the full preload.js.
contextBridge.exposeInMainWorld('electronAPI', {
  // Return to the settings window (used by error.html)
  exitKiosk: () => ipcRenderer.send('exit-kiosk'),

  // Get the URL that failed to load (used by error.html)
  getFailedUrl: () => ipcRenderer.invoke('get-failed-url'),

  // Retry loading the failed URL (used by error.html)
  retryUrl: () => ipcRenderer.send('retry-url'),

  // Network status helpers (read-only, backed by the renderer's own navigator)
  getNetworkStatus: () => navigator.onLine,
  onNetworkStatusChange: (callback) => {
    window.addEventListener('online', () => callback(true));
    window.addEventListener('offline', () => callback(false));
  }
});
