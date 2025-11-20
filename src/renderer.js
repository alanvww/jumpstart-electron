// Load saved settings when the page loads
window.addEventListener('DOMContentLoaded', () => {
  // Request saved settings from main process
  window.electronAPI.loadSettings((settings) => {
    if (settings) {
      // Populate form with saved settings
      const urlInput = document.getElementById('url');
      if (urlInput) urlInput.value = settings.url || 'https://google.com';
      
      const kioskInput = document.getElementById('kiosk');
      if (kioskInput) kioskInput.checked = settings.kiosk || false;
      
      const fullscreenInput = document.getElementById('fullscreen');
      if (fullscreenInput) fullscreenInput.checked = settings.fullscreen || false;
      
      const preventSleepInput = document.getElementById('preventSleep');
      if (preventSleepInput) preventSleepInput.checked = settings.preventSleep || false;
      
      const hideCursorInput = document.getElementById('hideCursor');
      if (hideCursorInput) hideCursorInput.checked = settings.hideCursor || false;
      
      const startupInput = document.getElementById('startup');
      if (startupInput) startupInput.checked = settings.startup || false;
      
      const refreshMinutesInput = document.getElementById('refreshMinutes');
      if (refreshMinutesInput) refreshMinutesInput.value = settings.refreshMinutes || 0;
      
      const networkRefreshInput = document.getElementById('networkRefresh');
      if (networkRefreshInput && settings.networkRefresh !== undefined) {
        networkRefreshInput.checked = settings.networkRefresh;
      }
      
      // Update UI based on loaded settings
      if (settings.kiosk && fullscreenInput) {
        fullscreenInput.disabled = true;
      }
    }
  });
});

// Handle form submission
const settingsForm = document.getElementById('settings-form');
if (settingsForm) {
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const urlInput = document.getElementById('url');
    let url = urlInput.value.trim();
    
    // Add https:// prefix if missing
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
      urlInput.value = url;
    }
    
    // Get refresh minutes and ensure it's a valid number
    let refreshMinutes = parseInt(document.getElementById('refreshMinutes').value, 10);
    if (isNaN(refreshMinutes) || refreshMinutes < 0) {
      refreshMinutes = 0; // Default to disabled if invalid
    }
    
    const settings = {
      url: url,
      kiosk: document.getElementById('kiosk').checked,
      fullscreen: document.getElementById('fullscreen').checked,
      preventSleep: document.getElementById('preventSleep').checked,
      hideCursor: document.getElementById('hideCursor').checked,
      startup: document.getElementById('startup').checked,
      refreshMinutes: refreshMinutes,
      networkRefresh: document.getElementById('networkRefresh').checked
    };
    
    window.electronAPI.saveSettings(settings);
  });
}

// Disable fullscreen option when kiosk is checked
const kioskInput = document.getElementById('kiosk');
if (kioskInput) {
  kioskInput.addEventListener('change', (e) => {
    const fullscreenCheckbox = document.getElementById('fullscreen');
    if (fullscreenCheckbox) {
      if (e.target.checked) {
        fullscreenCheckbox.checked = false;
        fullscreenCheckbox.disabled = true;
      } else {
        fullscreenCheckbox.disabled = false;
      }
    }
  });
}

