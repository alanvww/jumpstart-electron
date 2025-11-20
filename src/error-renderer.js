let failedUrl = "";

// Get the failed URL from the main process using the getFailedUrl API
window.electronAPI.getFailedUrl().then(url => {
  if (url) {
    failedUrl = url;
    console.log("Retrieved failed URL:", failedUrl);
    
    // Check if URL is localhost
    const isLocalhost = failedUrl.includes('localhost:') || failedUrl.includes('127.0.0.1:');
    
    // Update message based on URL type
    if (!isLocalhost) {
      const localhostMessage = document.getElementById('localhost-message');
      if (localhostMessage) {
        localhostMessage.textContent = "The app will automatically reload when the network connection is restored.";
      }
    }
  } else {
    console.log("No failed URL was retrieved");
  }
}).catch(err => {
  console.error("Error retrieving failed URL:", err);
});

// Update retry button to use the retryUrl API
const retryBtn = document.getElementById('retry-btn');
if (retryBtn) {
  retryBtn.addEventListener('click', () => {
    console.log("Retrying URL");
    window.electronAPI.retryUrl();
  });
}

// Back button
const backBtn = document.getElementById('back-btn');
if (backBtn) {
  backBtn.addEventListener('click', () => {
    window.electronAPI.exitKiosk();
  });
}

// Also allow Escape key to return to settings
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.electronAPI.exitKiosk();
  }
});

