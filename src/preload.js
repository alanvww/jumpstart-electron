const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send settings to main process
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),

  // Load settings from main process
  loadSettings: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.once('settings-loaded', (_event, settings) => callback(settings));
    ipcRenderer.send('get-settings');
  }
});
