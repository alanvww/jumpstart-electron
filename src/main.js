const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const net = require('net');

const APP_NAME = 'Jumpstart';
const APP_ICON_PATH = path.join(__dirname, '..', 'icons', 'icon.png');
const MEDIA_PERMISSIONS = new Set(['media', 'camera', 'microphone']);

app.setName(APP_NAME);

// In-memory storage for last failed URL
let lastFailedUrl = null;
let powerSaveBlockerId = null;

// Parse the origin (scheme + host + port) from a URL, or null if unparseable.
function getOriginFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch (_) {
    return null;
  }
}

// Enable PipeWire-based WebRTC capture on Linux/Wayland (Raspberry Pi OS Bookworm,
// modern Ubuntu). Command-line switches must be appended BEFORE the app 'ready'
// event, so this runs at module load — not inside whenReady().
function setupLinuxCameraPermissions() {
  if (process.platform !== 'linux') {
    return;
  }
  try {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
    console.log('Enabled Linux WebRTC camera compatibility flags');
  } catch (error) {
    console.error('Failed to configure Linux camera compatibility flags:', error);
  }
}

setupLinuxCameraPermissions();

// Prevent-sleep: powerSaveBlocker alone is a no-op on many Linux/Pi kiosk sessions
// (its D-Bus inhibitors are often absent), so also disable X11 screen blanking / DPMS
// as a best-effort fallback. On Wayland, disable blanking via raspi-config (see README).
function startPreventSleep() {
  if (powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('Prevent Sleep enabled, ID:', powerSaveBlockerId);
  }
  if (process.platform === 'linux') {
    exec('xset s off -dpms', (err) => {
      if (err) console.log('xset screen-blanking disable unavailable:', err.message);
    });
  }
}

function stopPreventSleep() {
  if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    console.log('Prevent Sleep disabled, ID:', powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
  if (process.platform === 'linux') {
    exec('xset s on +dpms', (err) => {
      if (err) console.log('xset screen-blanking restore unavailable:', err.message);
    });
  }
}

// Ensure only one instance of the app runs
console.log('Requesting single instance lock...');
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('Another instance is already running. Quitting...');
  app.quit();
  return; // Important: stop execution here
} else {
  console.log('This is the first instance of the app');
  // This is the first instance - continue with app initialization
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('Second instance detected, focusing existing window');
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('Focusing main window');
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (browserWindow && !browserWindow.isDestroyed()) {
      console.log('Focusing browser window');
      if (browserWindow.isMinimized()) browserWindow.restore();
      browserWindow.focus();
    }
  });
}

let mainWindow, browserWindow;
let refreshTimer = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  // Null the reference on close so stale-window checks elsewhere don't call
  // methods on a destroyed BrowserWindow.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function createBrowserWindow(url, isKiosk, isFullscreen, refreshMinutes, networkRefresh, preventSleep, hideCursor) {
  // Handle Prevent Sleep
  if (preventSleep) {
    startPreventSleep();
  } else {
    stopPreventSleep();
  }

  // Create browser window with initial size. Uses a MINIMAL preload that does not
  // expose saveSettings/loadSettings, so remote page content cannot persist settings
  // or configure OS autostart.
  browserWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false, // Don't show until we're ready
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload-content.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  // Camera/mic are auto-granted only to the operator-configured origin. The trusted
  // origin follows top-level (main-frame) navigations/redirects so that a www/https
  // redirect of the configured site keeps working, while cross-origin iframes and
  // unrelated origins are denied.
  let trustedOrigin = getOriginFromUrl(url);
  const contentSession = browserWindow.webContents.session;

  const isTrustedMedia = (permission, requestingUrl) => {
    if (!MEDIA_PERMISSIONS.has(permission)) return false;
    const requestingOrigin = getOriginFromUrl(requestingUrl);
    return Boolean(trustedOrigin && requestingOrigin === trustedOrigin);
  };

  contentSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = (details && (details.requestingUrl || details.embeddingOrigin)) || webContents.getURL();
    const allow = isTrustedMedia(permission, requestingUrl);
    console.log(`${allow ? 'Allowing' : 'Denying'} ${permission} for origin: ${getOriginFromUrl(requestingUrl) || 'unknown'}`);
    callback(allow);
  });

  contentSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = (details && details.requestingUrl) || requestingOrigin;
    return isTrustedMedia(permission, requestingUrl);
  });

  browserWindow.webContents.on('did-navigate', (event, navigateUrl) => {
    const origin = getOriginFromUrl(navigateUrl);
    if (origin) trustedOrigin = origin;
  });

  // On Linux, add a Permissions-Policy header for the trusted origin so getUserMedia
  // is allowed by the platform policy (helps Raspberry Pi camera setups).
  if (process.platform === 'linux') {
    contentSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      const requestOrigin = getOriginFromUrl(details.url);
      if (!trustedOrigin || requestOrigin !== trustedOrigin) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Permissions-Policy': ['camera=(self), microphone=(self)']
        }
      });
    });
  }

  // Harden navigation and popups
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.webContents.on('will-navigate', (event, navigateUrl) => {
    try {
      const parsed = new URL(navigateUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        event.preventDefault();
      }
    } catch (_) {
      event.preventDefault();
    }
  });

  // Recover from renderer crashes by showing the error page. Record the URL that was
  // displayed so the error page's "Try Again" can retry it.
  browserWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('Renderer process gone:', details);
    if (browserWindow && !browserWindow.isDestroyed()) {
      lastFailedUrl = browserWindow.webContents.getURL() || lastFailedUrl;
      browserWindow.loadFile(path.join(__dirname, 'error.html'));
    }
  });

  // Set up event to show settings page when browser window is closed
  browserWindow.on('closed', () => {
    browserWindow = null;
    // Clear any existing refresh timer when browser is closed
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    // Stop preventing sleep when the kiosk window closes
    stopPreventSleep();
    createMainWindow(); // Show settings page when browser is closed
  });

  // Maximize window first before setting kiosk or fullscreen mode
  browserWindow.maximize();

  // Apply kiosk or fullscreen mode after window is ready
  browserWindow.once('ready-to-show', () => {
    if (isKiosk) {
      browserWindow.setKiosk(true);
    } else if (isFullscreen) {
      browserWindow.setFullScreen(true);
    }
    browserWindow.show();
  });

  // Hide the cursor on every load/navigation (CSS injected via insertCSS applies only
  // to the current document, so re-apply after each load rather than once).
  if (hideCursor) {
    browserWindow.webContents.on('dom-ready', () => {
      if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.webContents.insertCSS('html, body, * { cursor: none !important; }');
      }
    });
  }

  // Register global shortcut for exiting kiosk mode
  const { globalShortcut } = require('electron');
  const exitAccelerator = 'CommandOrControl+Shift+Q';
  const registered = globalShortcut.register(exitAccelerator, () => {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.close();
    }
  });
  if (!registered) {
    console.warn('Failed to register global shortcut for exiting kiosk mode');
  }

  // Clean up shortcut when window is closed
  browserWindow.on('closed', () => {
    globalShortcut.unregister(exitAccelerator);
  });

  // Load the URL directly
  lastFailedUrl = null;
  browserWindow.loadURL(url).catch(err => {
    console.error('Failed to load URL:', err);
    if (!browserWindow || browserWindow.isDestroyed()) {
      return;
    }
    // Store the original URL in memory so we can access it from error.html
    lastFailedUrl = url;

    try {
      browserWindow.loadFile(path.join(__dirname, 'error.html'));
    } catch (loadErr) {
      // Window may have been torn down between the guard and this call (e.g. on quit)
      console.error('Failed to show error page:', loadErr.message);
    }
    // Network monitoring is started unconditionally below (when enabled); the single
    // monitor handles recovery whether or not the initial load succeeded.
  });

  // Set up auto-refresh timer if enabled
  if (refreshMinutes && refreshMinutes > 0) {
    console.log(`Setting up auto-refresh every ${refreshMinutes} minutes`);
    // Convert minutes to milliseconds
    const refreshInterval = refreshMinutes * 60 * 1000;
    refreshTimer = setInterval(() => {
      if (browserWindow && !browserWindow.isDestroyed()) {
        console.log('Auto-refreshing page...');
        browserWindow.reload();
      } else {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }, refreshInterval);
  }

  // Set up network status monitoring if enabled. Started exactly once here (the failed-
  // load path no longer starts its own), so there is never a duplicate monitor.
  console.log('Network refresh setting:', networkRefresh);
  if (networkRefresh) {
    console.log('Enabling network status monitoring');
    monitorNetworkStatus(browserWindow, url);
  } else {
    console.log('Network status monitoring is disabled');
  }
}

// Function to monitor network connectivity with the target URL
function monitorNetworkStatus(window, targetUrl) {
  console.log(`Starting network status monitoring for: ${targetUrl}`);

  // Track online status
  let isCurrentlyOnline = true; // Assume online initially
  let isLocalPortAvailable = true; // Track localhost port availability

  // Parse the URL to get the protocol, host, and port
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (error) {
    console.error(`Invalid URL for network monitoring: ${targetUrl}`);
    parsedUrl = new URL('https://www.google.com'); // Fallback to Google if URL is invalid
  }

  // Check if the URL is pointing to localhost
  const isLocalhostUrl = parsedUrl.hostname === 'localhost' ||
                        parsedUrl.hostname === '127.0.0.1' ||
                        parsedUrl.hostname === '::1';

  // Extract port from URL
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) :
              (parsedUrl.protocol === 'https:' ? 443 : 80);

  console.log(`URL analysis: ${parsedUrl.hostname}:${port} (Localhost URL: ${isLocalhostUrl})`);

  // Re-navigate the window back to the target URL. After a failed initial load the
  // window is showing error.html, so a plain reload would just re-render the error
  // page — we must loadURL(targetUrl) to actually recover.
  const recoverToTarget = () => {
    if (window && !window.isDestroyed()) {
      console.log(`Navigating back to target URL: ${targetUrl}`);
      window.loadURL(targetUrl).catch(err => {
        console.error('Recovery navigation failed:', err.message);
      });
    }
  };

  // Function to check if a localhost port is available
  const checkLocalPort = (port) => {
    return new Promise((resolve) => {
      const socket = new net.Socket();

      // Set a timeout for the connection attempt
      const timeout = setTimeout(() => {
        socket.destroy();
        console.log(`Port ${port} connection attempt timed out`);
        resolve(false);
      }, 1000);

      // Attempt to connect to the port
      socket.connect(port, '127.0.0.1', () => {
        clearTimeout(timeout);
        socket.destroy();
        console.log(`Successfully connected to port ${port}`);
        resolve(true);
      });

      // Handle connection errors
      socket.on('error', (err) => {
        clearTimeout(timeout);
        socket.destroy();
        console.log(`Port ${port} connection error: ${err.message}`);
        resolve(false);
      });
    });
  };

  // Use the appropriate method to test connectivity based on URL type
  const testConnection = async () => {
    // For localhost URLs, check port availability using TCP
    if (isLocalhostUrl) {
      console.log(`Testing localhost port ${port} availability...`);
      return await checkLocalPort(port);
    }

    // For regular URLs, use HTTP/HTTPS request
    return new Promise((resolve) => {
      const protocol = parsedUrl.protocol === 'https:' ? require('https') : require('http');

      const options = {
        hostname: parsedUrl.hostname,
        port: port, // Include the configured port so custom-port hosts probe correctly
        path: parsedUrl.pathname || '/',
        method: 'HEAD', // Use HEAD request for efficiency - we only care about connection, not content
        timeout: 5000
      };

      console.log(`Testing connection to: ${parsedUrl.hostname}:${port}...`);

      const request = protocol.request(options, (response) => {
        // Any response means we're online (even if it's a redirect or error code)
        console.log(`Connection test to ${parsedUrl.hostname}: HTTP ${response.statusCode}`);
        response.destroy(); // Properly close the connection
        resolve(true);
      });

      // Set a timeout to avoid hanging
      request.setTimeout(5000, () => {
        console.log(`Connection test to ${parsedUrl.hostname} timed out`);
        request.destroy();
        resolve(false);
      });

      // Handle connection errors
      request.on('error', (err) => {
        console.log(`Connection test to ${parsedUrl.hostname} error: ${err.message}`);
        request.destroy();
        resolve(false);
      });

      // End the request
      request.end();
    });
  };

  // Check network status every 5 seconds
  const networkCheckInterval = setInterval(async () => {
    try {
      const wasOnline = isCurrentlyOnline;
      const wasPortAvailable = isLocalPortAvailable;

      // Get current connection status
      isCurrentlyOnline = await testConnection();

      // Update port status only if it's a localhost URL
      if (isLocalhostUrl) {
        isLocalPortAvailable = isCurrentlyOnline;
        console.log(`Localhost port ${port} status check - Previous: ${wasPortAvailable ? 'available' : 'unavailable'}, Current: ${isLocalPortAvailable ? 'available' : 'unavailable'}`);

        // Detect port becoming available
        if (isLocalPortAvailable && !wasPortAvailable) {
          console.log(`Localhost port ${port} is now available! Scheduling recovery...`);

          // Wait a moment for the service to fully initialize before recovering
          setTimeout(() => {
            console.log(`Executing recovery after localhost port ${port} became available`);
            recoverToTarget();
          }, 2000);
        }
      } else {
        // Regular network status handling for non-localhost URLs
        console.log(`Network status check - Previous: ${wasOnline ? 'online' : 'offline'}, Current: ${isCurrentlyOnline ? 'online' : 'offline'}`);

        // Detect reconnection (went from offline to online)
        if (isCurrentlyOnline && !wasOnline) {
          console.log('Network reconnected! Scheduling recovery...');

          // Wait a moment for the connection to stabilize before recovering
          setTimeout(() => {
            console.log('Executing recovery after network reconnection');
            recoverToTarget();
          }, 3000);
        }
      }
    } catch (error) {
      console.error('Error checking network status:', error);
      // If we hit an exception, assume we're offline
      isCurrentlyOnline = false;
      if (isLocalhostUrl) {
        isLocalPortAvailable = false;
      }
    }
  }, 5000); // Check more frequently (every 5 seconds) to better detect localhost ports becoming available

  // Perform an immediate check
  testConnection().then(online => {
    console.log(`Initial network status: ${online ? 'online' : 'offline'}`);
    isCurrentlyOnline = online;
  });

  // Clean up interval when window is closed
  window.on('closed', () => {
    console.log('Cleaning up network monitoring');
    clearInterval(networkCheckInterval);
  });
}

app.whenReady().then(() => {

  // Check if we have saved settings with a URL
  const settings = loadSettings();
  console.log('Loaded settings:', settings);

  if (settings && settings.url) {
    console.log('Starting with saved URL:', settings.url);
    // Start directly with the saved URL
    let validUrl = settings.url;
    if (!validUrl.startsWith('http://') && !validUrl.startsWith('https://')) {
      validUrl = 'https://' + validUrl;
    }
    console.log('Opening browser window with URL:', validUrl);
    createBrowserWindow(validUrl, settings.kiosk, settings.fullscreen, settings.refreshMinutes, settings.networkRefresh, settings.preventSleep, settings.hideCursor);
  } else {
    console.log('No saved URL found, showing settings page');
    // No saved URL, show settings page
    createMainWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Check again for saved settings when activating
      const settings = loadSettings();
      if (settings && settings.url) {
        let validUrl = settings.url;
        if (!validUrl.startsWith('http://') && !validUrl.startsWith('https://')) {
          validUrl = 'https://' + validUrl;
        }
        createBrowserWindow(validUrl, settings.kiosk, settings.fullscreen, settings.refreshMinutes, settings.networkRefresh, settings.preventSleep, settings.hideCursor);
      } else {
        createMainWindow();
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Store settings in a file under Electron userData
const userDataPath = app.getPath('userData');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}
const settingsPath = path.join(userDataPath, 'settings.json');

// Save settings to file
function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

// Load settings from file
function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  return {};
}

// Configure auto-start based on platform. Resolves the real executable path for
// portable Windows builds (PORTABLE_EXECUTABLE_FILE) and AppImage Linux builds
// (APPIMAGE), since app.getPath('exe') points at a transient extraction dir for both.
function configureAutoStart(enable) {
  const appPath = process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  const appName = APP_NAME;

  switch (process.platform) {
    case 'win32': {
      // Windows: Create shortcut in startup folder
      // This is useful for portable apps that don't use the installer
      const { execSync } = require('child_process');
      const startupFolderPath = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      const shortcutPath = path.join(startupFolderPath, `${appName}.lnk`);

      if (enable) {
        // Always (re)create the shortcut so a stale target path self-heals.
        try {
          const powershellCommand = [
            '$WshShell = New-Object -ComObject WScript.Shell;',
            `$Shortcut = $WshShell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}');`,
            `$Shortcut.TargetPath = '${appPath.replace(/'/g, "''")}';`,
            '$Shortcut.Save()'
          ].join(' ');
          execSync(`powershell -NoProfile -Command "${powershellCommand}"`, { windowsHide: true });
          console.log(`Created startup shortcut at: ${shortcutPath}`);
        } catch (error) {
          console.error('Failed to create startup shortcut:', error);
        }
      } else {
        // Remove shortcut if it exists
        if (fs.existsSync(shortcutPath)) {
          try {
            fs.unlinkSync(shortcutPath);
            console.log(`Removed startup shortcut: ${shortcutPath}`);
          } catch (error) {
            console.error('Failed to remove startup shortcut:', error);
          }
        }
      }
      break;
    }

    case 'darwin': {
      // macOS: Use a LaunchAgent plist so disabling actually removes autostart.
      const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      const plistPath = path.join(launchAgentsDir, `com.${appName}.plist`);

      if (enable) {
        if (!fs.existsSync(launchAgentsDir)) {
          fs.mkdirSync(launchAgentsDir, { recursive: true });
        }
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.${appName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${appPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
        fs.writeFileSync(plistPath, plistContent);
        exec(`launchctl load "${plistPath}"`);
      } else {
        if (fs.existsSync(plistPath)) {
          exec(`launchctl unload "${plistPath}"`);
          fs.unlinkSync(plistPath);
        }
      }
      break;
    }

    case 'linux': {
      // Linux: Use .desktop file in autostart directory
      const autoStartDir = path.join(os.homedir(), '.config', 'autostart');
      const desktopPath = path.join(autoStartDir, `${appName}.desktop`);

      if (enable) {
        if (!fs.existsSync(autoStartDir)) {
          fs.mkdirSync(autoStartDir, { recursive: true });
        }
        const escapedAppPath = appPath.replace(/"/g, '\\"');
        const desktopContent = `[Desktop Entry]
Type=Application
Exec="${escapedAppPath}"
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=${appName}`;
        fs.writeFileSync(desktopPath, desktopContent);
      } else {
        if (fs.existsSync(desktopPath)) {
          fs.unlinkSync(desktopPath);
        }
      }
      break;
    }
  }
}

ipcMain.on('save-settings', (event, settings) => {
  console.log('Saving settings:', settings);

  // Only the settings window may change settings/autostart. Remote page content uses
  // a minimal preload without saveSettings, but gate on the sender as defense in depth.
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    console.warn('Ignoring save-settings from unexpected sender');
    return;
  }

  // Validate and normalize the payload
  if (!settings || typeof settings !== 'object') {
    console.error('Invalid settings payload: expected an object');
    return;
  }

  const rawUrl = typeof settings.url === 'string' ? settings.url.trim() : '';
  if (!rawUrl) {
    console.error('Invalid settings payload: URL is required');
    return;
  }

  const kiosk = Boolean(settings.kiosk);
  const fullscreen = !kiosk && Boolean(settings.fullscreen);
  const startup = Boolean(settings.startup);
  const preventSleep = Boolean(settings.preventSleep);
  const hideCursor = Boolean(settings.hideCursor);
  const refreshMinutesNumber = Number(settings.refreshMinutes);
  const refreshMinutes = Number.isFinite(refreshMinutesNumber) ? Math.max(0, Math.floor(refreshMinutesNumber)) : 0;
  const networkRefresh = Boolean(settings.networkRefresh);

  // Make sure URL has http:// or https:// prefix
  let validUrl = rawUrl;
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    validUrl = 'https://' + rawUrl;
  }
  // Basic validation: only allow http/https URLs
  try {
    const parsed = new URL(validUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported URL protocol');
    }
  } catch (e) {
    console.error('Invalid URL provided in settings:', e.message);
    return;
  }

  const normalizedSettings = {
    url: rawUrl,
    kiosk,
    fullscreen,
    startup,
    preventSleep,
    hideCursor,
    refreshMinutes,
    networkRefresh
  };

  // Save settings to file
  saveSettings(normalizedSettings);

  // Configure auto-start based on platform
  try {
    // Electron's built-in method covers development runs and Windows/macOS login items.
    app.setLoginItemSettings({
      openAtLogin: startup,
      path: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe'),
      name: APP_NAME
    });
    console.log(`Electron login item settings updated: openAtLogin=${startup}`);

    // For packaged builds, also manage a platform-native autostart entry (Startup
    // shortcut / LaunchAgent / .desktop) so autostart works and can be fully disabled.
    if (app.isPackaged) {
      configureAutoStart(startup);
    }
  } catch (error) {
    console.error('Failed to set startup settings:', error);
  }

  if (mainWindow) {
    mainWindow.close();
  }

  // Pass all settings to browser window creation
  createBrowserWindow(validUrl, kiosk, fullscreen, refreshMinutes, networkRefresh, preventSleep, hideCursor);

  // Log the configured settings for debugging
  console.log('Browser configured with settings:', normalizedSettings);
});

ipcMain.on('exit-kiosk', () => {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.close();
  }
});

// Handle get-settings request from renderer
ipcMain.on('get-settings', (event) => {
  const settings = loadSettings();
  event.sender.send('settings-loaded', settings);
});

// Handle get-failed-url request from renderer (used in error.html)
ipcMain.handle('get-failed-url', async (event) => {
  return lastFailedUrl || null;
});

// Handle retry-url request from renderer (used in error.html)
ipcMain.on('retry-url', (event) => {
  if (!browserWindow || browserWindow.isDestroyed() || !lastFailedUrl) {
    return;
  }
  const urlToRetry = lastFailedUrl;
  console.log('Retrying connection to URL:', urlToRetry);
  browserWindow.loadURL(urlToRetry).then(() => {
    lastFailedUrl = null;
  }).catch(err => {
    console.error('Failed to load URL again:', err);
    // No need to reload error.html as we're already there
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
