const { contextBridge, ipcRenderer } = require('electron');

// Only expose the error-recovery IPC bridge to the local bundled error.html (file:).
// Untrusted remote HTTP/HTTPS pages loaded in the browser window receive no electronAPI
// surface, preventing remote pages from closing kiosk mode or querying main-process state.
if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('electronAPI', {
    // Return to the settings window (used by error.html)
    exitKiosk: () => ipcRenderer.send('exit-kiosk'),

    // Get the URL that failed to load (used by error.html)
    getFailedUrl: () => ipcRenderer.invoke('get-failed-url'),

    // Retry loading the failed URL (used by error.html)
    retryUrl: () => ipcRenderer.send('retry-url')
  });
}
