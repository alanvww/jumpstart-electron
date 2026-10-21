let failedUrl = '';

function isLocalhostUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch (_) {
    return false;
  }
}

// Get the failed URL from the main process using the getFailedUrl API
if (window.electronAPI && typeof window.electronAPI.getFailedUrl === 'function') {
  window.electronAPI.getFailedUrl().then((url) => {
    if (url) {
      failedUrl = url;
      console.log('Retrieved failed URL:', failedUrl);

      // Update message based on URL type
      if (!isLocalhostUrl(failedUrl)) {
        const localhostMessage = document.getElementById('localhost-message');
        if (localhostMessage) {
          localhostMessage.textContent = 'The app will automatically reload when the network connection is restored.';
        }
      }
    } else {
      console.log('No failed URL was retrieved');
    }
  }).catch((err) => {
    console.error('Error retrieving failed URL:', err);
  });
}

// Update retry button to use the retryUrl API
const retryBtn = document.getElementById('retry-btn');
if (retryBtn) {
  retryBtn.addEventListener('click', () => {
    console.log('Retrying URL');
    if (window.electronAPI) {
      window.electronAPI.retryUrl();
    }
  });
}

// Back button
const backBtn = document.getElementById('back-btn');
if (backBtn) {
  backBtn.addEventListener('click', () => {
    if (window.electronAPI) {
      window.electronAPI.exitKiosk();
    }
  });
}

// Also allow Escape key to return to settings
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.electronAPI) {
    window.electronAPI.exitKiosk();
  }
});
