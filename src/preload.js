const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send settings to main process
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),

  // Load settings from main process
  loadSettings: (callback) => {
    ipcRenderer.send('get-settings');
    ipcRenderer.once('settings-loaded', (event, settings) => callback(settings));
  },

  // Exit kiosk mode
  exitKiosk: () => ipcRenderer.send('exit-kiosk'),

  // Receive URL to load in browser
  onLoadUrl: (callback) => ipcRenderer.on('load-url', (event, url) => callback(url)),

  // Network status methods
  getNetworkStatus: () => navigator.onLine,

  // Listen for online status changes
  onNetworkStatusChange: (callback) => {
    window.addEventListener('online', () => callback(true));
    window.addEventListener('offline', () => callback(false));
  },
  
  // Get the URL that failed to load (for error.html)
  getFailedUrl: () => ipcRenderer.invoke('get-failed-url'),
  
  // Try loading the URL again
  retryUrl: () => ipcRenderer.send('retry-url')
});
