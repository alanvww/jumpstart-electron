const { app, BrowserWindow, ipcMain, powerSaveBlocker, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const net = require('net');
const { pathToFileURL } = require('url');

const APP_NAME = 'Jumpstart';
const APP_ICON_PATH = path.join(__dirname, '..', 'icons', 'icon.png');
const INDEX_FILE_PATH = path.join(__dirname, 'index.html');
const ERROR_FILE_PATH = path.join(__dirname, 'error.html');
const INDEX_FILE_URL = pathToFileURL(INDEX_FILE_PATH).href;
const ERROR_FILE_URL = pathToFileURL(ERROR_FILE_PATH).href;
const EXIT_ACCELERATOR = 'CommandOrControl+Shift+Q';
const MEDIA_PERMISSIONS = new Set(['media', 'camera', 'microphone']);

app.setName(APP_NAME);

// In-memory state
let mainWindow = null;
let browserWindow = null;
let refreshTimer = null;
let lastFailedUrl = null;
let powerSaveBlockerId = null;
let isQuitting = false;

app.on('before-quit', () => {
  isQuitting = true;
});

// Parse the HTTP/HTTPS origin (scheme + host + port) from a URL, or null if non-HTTP(S) / unparseable.
function getOriginFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.origin || parsed.origin === 'null') {
      return null;
    }
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

// Chromium rejects loadURL with ERR_ABORTED (-3) when a navigation is superseded by
// an HTTP/JS redirect or a newer loadURL call; this is not a load failure.
function isAbortError(err) {
  return Boolean(err && (err.code === 'ERR_ABORTED' || err.errno === -3));
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
    execFile('xset', ['s', 'off', '-dpms'], (err) => {
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
    execFile('xset', ['s', 'on', '+dpms'], (err) => {
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
  app.on('second-instance', () => {
    console.log('Second instance detected, focusing existing window');
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (browserWindow && !browserWindow.isDestroyed()) {
      if (browserWindow.isMinimized()) browserWindow.restore();
      browserWindow.focus();
    }
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(INDEX_FILE_PATH);
}

// Exit kiosk/fullscreen cleanly before closing the browser window so macOS
// NSApplicationPresentationOptions (Dock, Menu Bar, Cmd+Tab) are restored and
// mainWindow is created before the last window closes on Windows/Linux.
function closeBrowserWindowToSettings() {
  if (!browserWindow || browserWindow.isDestroyed()) {
    return;
  }
  const win = browserWindow;
  if (win.isKiosk()) {
    win.setKiosk(false);
  }
  if (win.isFullScreen()) {
    win.setFullScreen(false);
  }
  if (!isQuitting && (!mainWindow || mainWindow.isDestroyed())) {
    createMainWindow();
  }
  win.close();
}

function createBrowserWindow(url, isKiosk, isFullscreen, refreshMinutes, networkRefresh, preventSleep, hideCursor) {
  if (preventSleep) {
    startPreventSleep();
  } else {
    stopPreventSleep();
  }

  // Create browser window with initial size. Uses a MINIMAL preload that only exposes
  // error recovery methods when on file:// (error.html), never to remote pages.
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload-content.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged
    }
  });
  browserWindow = win;

  // Camera/mic are auto-granted only to the operator-configured HTTP(S) origin.
  // The trusted origin follows top-level HTTP(S) navigations/redirects so a www/https
  // redirect of the configured site keeps working, while file:// (error.html),
  // cross-origin iframes, and unrelated origins are denied.
  let trustedOrigin = getOriginFromUrl(url);
  const contentSession = win.webContents.session;

  const isTrustedMedia = (webContents, permission, requestingUrl) => {
    if (!win || win.isDestroyed() || webContents !== win.webContents) {
      return false;
    }
    if (!MEDIA_PERMISSIONS.has(permission)) {
      return false;
    }
    const requestingOrigin = getOriginFromUrl(requestingUrl);
    return Boolean(trustedOrigin && requestingOrigin === trustedOrigin);
  };

  contentSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = (details && (details.requestingUrl || details.embeddingOrigin)) || webContents.getURL();
    const allow = isTrustedMedia(webContents, permission, requestingUrl);
    console.log(`${allow ? 'Allowing' : 'Denying'} ${permission} for origin: ${getOriginFromUrl(requestingUrl) || 'unknown'}`);
    callback(allow);
  });

  contentSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = (details && details.requestingUrl) || requestingOrigin;
    return isTrustedMedia(webContents, permission, requestingUrl);
  });

  win.webContents.on('did-navigate', (_event, navigateUrl) => {
    const origin = getOriginFromUrl(navigateUrl);
    if (origin) {
      trustedOrigin = origin;
    }
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
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'permissions-policy') {
          delete headers[key];
        }
      }
      headers['Permissions-Policy'] = ['camera=(self), microphone=(self)'];
      callback({ responseHeaders: headers });
    });
  }

  // Harden navigation, redirects, and popups
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockNonHttpNavigation = (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        event.preventDefault();
      }
    } catch (_) {
      event.preventDefault();
    }
  };
  win.webContents.on('will-navigate', blockNonHttpNavigation);
  win.webContents.on('will-redirect', blockNonHttpNavigation);

  // Handle exit shortcut inside the window via before-input-event (works across
  // Wayland, X11, macOS, and Windows without OS-wide shortcut hijacking).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return;
    }
    const isExitCombo = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'q';
    const isEscapeOnErrorPage = input.key === 'Escape' && win.webContents.getURL() === ERROR_FILE_URL;
    if (isExitCombo || isEscapeOnErrorPage) {
      event.preventDefault();
      closeBrowserWindowToSettings();
    }
  });

  // Also register globalShortcut ONLY while the browserWindow is focused as a fallback
  // for kiosk sessions where webContents focus may be absent, unregistering on blur/close.
  const registerExitShortcut = () => {
    if (!globalShortcut.isRegistered(EXIT_ACCELERATOR)) {
      globalShortcut.register(EXIT_ACCELERATOR, () => {
        closeBrowserWindowToSettings();
      });
    }
  };
  const unregisterExitShortcut = () => {
    if (globalShortcut.isRegistered(EXIT_ACCELERATOR)) {
      globalShortcut.unregister(EXIT_ACCELERATOR);
    }
  };
  win.on('focus', registerExitShortcut);
  win.on('blur', unregisterExitShortcut);

  // Ensure macOS presentation options (kiosk/fullscreen) are cleared if the window
  // is closed via OS window controls or Alt+F4.
  win.on('close', () => {
    if (!win.isDestroyed()) {
      if (win.isKiosk()) win.setKiosk(false);
      if (win.isFullScreen()) win.setFullScreen(false);
    }
  });

  // Recover from renderer crashes by showing the error page. Record the URL that was
  // displayed so the error page's "Try Again" can retry it.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer process gone:', details);
    if (!win.isDestroyed()) {
      const currentUrl = win.webContents.getURL();
      lastFailedUrl = (currentUrl && currentUrl !== ERROR_FILE_URL) ? currentUrl : (lastFailedUrl || url);
      win.loadFile(ERROR_FILE_PATH).catch((err) => {
        console.error('Failed to load error page after crash:', err.message);
      });
    }
  });

  // Clean up timers, session handlers, shortcuts, and sleep blocker when browser closes
  win.on('closed', () => {
    unregisterExitShortcut();
    if (browserWindow === win) {
      browserWindow = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    contentSession.setPermissionRequestHandler(null);
    contentSession.setPermissionCheckHandler(null);
    if (process.platform === 'linux') {
      contentSession.webRequest.onHeadersReceived(null);
    }
    stopPreventSleep();
    if (!isQuitting && (!mainWindow || mainWindow.isDestroyed())) {
      createMainWindow();
    }
  });

  // Maximize window first before setting kiosk or fullscreen mode
  win.maximize();

  // Apply kiosk or fullscreen mode after window is ready
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (isKiosk) {
      win.setKiosk(true);
    } else if (isFullscreen) {
      win.setFullScreen(true);
    }
    win.show();
  });

  // Hide the cursor on every load/navigation (CSS injected via insertCSS applies only
  // to the current document, so re-apply after each load rather than once).
  if (hideCursor) {
    win.webContents.on('dom-ready', () => {
      if (!win.isDestroyed()) {
        win.webContents.insertCSS('html, body, * { cursor: none !important; }');
      }
    });
  }

  // Helper to load the target URL and transition to error.html on non-abort failures
  const loadTargetUrl = (targetUrl) => {
    if (win.isDestroyed()) return Promise.resolve(false);
    return win.loadURL(targetUrl).then(() => {
      lastFailedUrl = null;
      return true;
    }).catch((err) => {
      if (isAbortError(err)) {
        return false;
      }
      console.error('Failed to load URL:', err);
      if (win.isDestroyed()) {
        return false;
      }
      lastFailedUrl = targetUrl;
      win.loadFile(ERROR_FILE_PATH).catch((loadErr) => {
        console.error('Failed to show error page:', loadErr.message);
      });
      return false;
    });
  };

  // Load the URL directly
  lastFailedUrl = null;
  loadTargetUrl(url);

  // Set up auto-refresh timer if enabled
  if (refreshMinutes && refreshMinutes > 0) {
    console.log(`Setting up auto-refresh every ${refreshMinutes} minutes`);
    const refreshInterval = refreshMinutes * 60 * 1000;
    refreshTimer = setInterval(() => {
      if (win && !win.isDestroyed()) {
        console.log('Auto-refreshing page...');
        if (lastFailedUrl) {
          loadTargetUrl(url);
        } else {
          win.reload();
        }
      } else {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }, refreshInterval);
  }

  // Set up network status monitoring if enabled.
  console.log('Network refresh setting:', networkRefresh);
  if (networkRefresh) {
    console.log('Enabling network status monitoring');
    monitorNetworkStatus(win, url);
  } else {
    console.log('Network status monitoring is disabled');
  }
}

// Function to monitor network connectivity with the target URL
function monitorNetworkStatus(window, targetUrl) {
  console.log(`Starting network status monitoring for: ${targetUrl}`);

  let isCurrentlyOnline = true;
  let isLocalPortAvailable = true;
  let isChecking = false;
  let recoveryTimeout = null;

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (_) {
    console.error(`Invalid URL for network monitoring: ${targetUrl}`);
    parsedUrl = new URL('https://www.google.com');
  }

  const normalizedHost = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const isLocalhostUrl = normalizedHost === 'localhost' ||
                         normalizedHost === '127.0.0.1' ||
                         normalizedHost === '::1';

  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) :
              (parsedUrl.protocol === 'https:' ? 443 : 80);

  console.log(`URL analysis: ${normalizedHost}:${port} (Localhost URL: ${isLocalhostUrl})`);

  const recoverToTarget = () => {
    if (window && !window.isDestroyed()) {
      console.log(`Navigating back to target URL: ${targetUrl}`);
      window.loadURL(targetUrl).then(() => {
        lastFailedUrl = null;
      }).catch((err) => {
        if (!isAbortError(err)) {
          console.error('Recovery navigation failed:', err.message);
          lastFailedUrl = targetUrl;
        }
      });
    }
  };

  // Attempt TCP connection to a single host address
  const tryConnectHost = (targetPort, hostAddress) => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finish(false);
      }, 1000);

      socket.connect(targetPort, hostAddress, () => {
        finish(true);
      });

      socket.on('error', () => {
        finish(false);
      });
    });
  };

  // Check if a localhost port is available across IPv4 (127.0.0.1) and IPv6 (::1)
  const checkLocalPort = async (targetPort, host) => {
    if (host === '127.0.0.1' || host === '::1') {
      return await tryConnectHost(targetPort, host);
    }
    // For 'localhost', servers may bind only to 127.0.0.1 (IPv4) or only to ::1 (IPv6)
    const ipv4Up = await tryConnectHost(targetPort, '127.0.0.1');
    if (ipv4Up) {
      return true;
    }
    return await tryConnectHost(targetPort, '::1');
  };

  // Use the appropriate method to test connectivity based on URL type
  const testConnection = async () => {
    if (isLocalhostUrl) {
      return await checkLocalPort(port, normalizedHost);
    }

    return new Promise((resolve) => {
      const protocol = parsedUrl.protocol === 'https:' ? require('https') : require('http');
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const options = {
        hostname: parsedUrl.hostname,
        port: port,
        path: parsedUrl.pathname || '/',
        method: 'HEAD',
        timeout: 4000
      };

      const request = protocol.request(options, (response) => {
        console.log(`Connection test to ${parsedUrl.hostname}: HTTP ${response.statusCode}`);
        response.destroy();
        finish(true);
      });

      request.setTimeout(4000, () => {
        console.log(`Connection test to ${parsedUrl.hostname} timed out`);
        request.destroy();
        finish(false);
      });

      request.on('error', (err) => {
        console.log(`Connection test to ${parsedUrl.hostname} error: ${err.message}`);
        request.destroy();
        finish(false);
      });

      request.end();
    });
  };

  const scheduleRecovery = (delayMs, reasonLog) => {
    if (recoveryTimeout !== null) {
      return;
    }
    console.log(reasonLog);
    recoveryTimeout = setTimeout(() => {
      recoveryTimeout = null;
      recoverToTarget();
    }, delayMs);
  };

  const runNetworkCheck = async (isInitial = false) => {
    if (isChecking || !window || window.isDestroyed()) {
      return;
    }
    isChecking = true;
    try {
      const wasOnline = isCurrentlyOnline;
      const wasPortAvailable = isLocalPortAvailable;

      const online = await testConnection();
      isCurrentlyOnline = online;
      if (isLocalhostUrl) {
        isLocalPortAvailable = online;
      }

      if (isInitial) {
        console.log(`Initial network status: ${online ? 'online' : 'offline'}`);
        if (online && lastFailedUrl !== null) {
          scheduleRecovery(
            isLocalhostUrl ? 1000 : 2000,
            'Target is already reachable while on error page; scheduling recovery...'
          );
        }
        return;
      }

      const needsErrorPageRecovery = online && lastFailedUrl !== null;

      if (isLocalhostUrl) {
        console.log(`Localhost port ${port} status check - Previous: ${wasPortAvailable ? 'available' : 'unavailable'}, Current: ${isLocalPortAvailable ? 'available' : 'unavailable'}`);
        if ((isLocalPortAvailable && !wasPortAvailable) || needsErrorPageRecovery) {
          scheduleRecovery(2000, `Localhost port ${port} is available! Scheduling recovery...`);
        }
      } else {
        console.log(`Network status check - Previous: ${wasOnline ? 'online' : 'offline'}, Current: ${isCurrentlyOnline ? 'online' : 'offline'}`);
        if ((isCurrentlyOnline && !wasOnline) || needsErrorPageRecovery) {
          scheduleRecovery(3000, 'Network reconnected! Scheduling recovery...');
        }
      }
    } catch (error) {
      console.error('Error checking network status:', error);
      isCurrentlyOnline = false;
      if (isLocalhostUrl) {
        isLocalPortAvailable = false;
      }
    } finally {
      isChecking = false;
    }
  };

  // Perform an immediate check, then poll every 5 seconds
  runNetworkCheck(true);
  const networkCheckInterval = setInterval(() => {
    runNetworkCheck(false);
  }, 5000);

  // Clean up interval and pending timeout when window is closed
  window.on('closed', () => {
    console.log('Cleaning up network monitoring');
    clearInterval(networkCheckInterval);
    if (recoveryTimeout !== null) {
      clearTimeout(recoveryTimeout);
      recoveryTimeout = null;
    }
  });
}

// Validate and normalize a settings object; returns null if URL is missing or invalid.
function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!rawUrl) {
    return null;
  }
  let validUrl = rawUrl;
  if (!/^https?:\/\//i.test(rawUrl)) {
    validUrl = 'https://' + rawUrl;
  }
  try {
    const parsed = new URL(validUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch (_) {
    return null;
  }

  const kiosk = Boolean(raw.kiosk);
  const fullscreen = !kiosk && Boolean(raw.fullscreen);
  const startup = Boolean(raw.startup);
  const preventSleep = Boolean(raw.preventSleep);
  const hideCursor = Boolean(raw.hideCursor);
  const refreshMinutesNumber = Number(raw.refreshMinutes);
  const refreshMinutes = Number.isFinite(refreshMinutesNumber) ? Math.max(0, Math.floor(refreshMinutesNumber)) : 0;
  const networkRefresh = raw.networkRefresh === undefined ? true : Boolean(raw.networkRefresh);

  return {
    settings: {
      url: rawUrl,
      kiosk,
      fullscreen,
      startup,
      preventSleep,
      hideCursor,
      refreshMinutes,
      networkRefresh
    },
    validUrl
  };
}

function getSettingsPath() {
  const userDataPath = app.getPath('userData');
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }
  return path.join(userDataPath, 'settings.json');
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const normalized = normalizeSettings(raw);
      return normalized ? normalized.settings : {};
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  return {};
}

function launchFromSavedSettingsOrShowMain() {
  const saved = loadSettings();
  console.log('Loaded settings:', saved);
  const normalized = normalizeSettings(saved);
  if (normalized) {
    const { settings, validUrl } = normalized;
    console.log('Opening browser window with saved URL:', validUrl);
    createBrowserWindow(
      validUrl,
      settings.kiosk,
      settings.fullscreen,
      settings.refreshMinutes,
      settings.networkRefresh,
      settings.preventSleep,
      settings.hideCursor
    );
  } else {
    console.log('No valid saved URL found, showing settings page');
    createMainWindow();
  }
}

app.whenReady().then(() => {
  launchFromSavedSettingsOrShowMain();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      launchFromSavedSettingsOrShowMain();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Configure auto-start based on platform without registering duplicate login items:
// - macOS: Uses Electron's native app.setLoginItemSettings and removes any legacy LaunchAgent plist.
// - Windows (Portable): Creates/removes a .lnk in the Startup folder (passed via env vars to avoid shell injection).
// - Windows (Installed NSIS): Uses Electron's app.setLoginItemSettings and removes any stale Startup .lnk.
// - Linux: Creates/removes ~/.config/autostart/Jumpstart.desktop (resolving APPIMAGE path when running from AppImage).
function configureAutoStart(enable) {
  const appPath = process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  const appName = APP_NAME;

  switch (process.platform) {
    case 'win32': {
      const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
      const startupFolderPath = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      const shortcutPath = path.join(startupFolderPath, `${appName}.lnk`);

      if (isPortable) {
        if (enable) {
          const psScript = [
            '$WshShell = New-Object -ComObject WScript.Shell;',
            '$Shortcut = $WshShell.CreateShortcut($env:JUMPSTART_SHORTCUT_PATH);',
            '$Shortcut.TargetPath = $env:JUMPSTART_TARGET_PATH;',
            '$Shortcut.Save()'
          ].join(' ');
          execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', psScript],
            {
              windowsHide: true,
              env: {
                ...process.env,
                JUMPSTART_SHORTCUT_PATH: shortcutPath,
                JUMPSTART_TARGET_PATH: appPath
              }
            },
            (error) => {
              if (error) {
                console.error('Failed to create startup shortcut:', error);
              } else {
                console.log(`Created startup shortcut at: ${shortcutPath}`);
              }
            }
          );
        } else if (fs.existsSync(shortcutPath)) {
          try {
            fs.unlinkSync(shortcutPath);
            console.log(`Removed startup shortcut: ${shortcutPath}`);
          } catch (error) {
            console.error('Failed to remove startup shortcut:', error);
          }
        }
      } else {
        app.setLoginItemSettings({
          openAtLogin: enable,
          path: appPath,
          name: appName
        });
        if (!enable && fs.existsSync(shortcutPath)) {
          try {
            fs.unlinkSync(shortcutPath);
          } catch (_) {}
        }
      }
      break;
    }

    case 'darwin': {
      app.setLoginItemSettings({
        openAtLogin: enable,
        path: appPath,
        name: appName
      });
      // Clean up legacy LaunchAgent plist from older versions so the app does not launch twice
      const legacyPlistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `com.${appName}.plist`);
      if (fs.existsSync(legacyPlistPath)) {
        execFile('launchctl', ['unload', legacyPlistPath], () => {
          try {
            if (fs.existsSync(legacyPlistPath)) {
              fs.unlinkSync(legacyPlistPath);
            }
          } catch (_) {}
        });
      }
      break;
    }

    case 'linux': {
      if (!app.isPackaged) {
        break;
      }
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
Name=${appName}
`;
        fs.writeFileSync(desktopPath, desktopContent);
      } else if (fs.existsSync(desktopPath)) {
        fs.unlinkSync(desktopPath);
      }
      break;
    }
  }
}

function isMainSettingsSender(event) {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    (!event.senderFrame || event.senderFrame.url === INDEX_FILE_URL)
  );
}

function isErrorPageSender(event) {
  return Boolean(
    browserWindow &&
    !browserWindow.isDestroyed() &&
    event.sender === browserWindow.webContents &&
    (!event.senderFrame || event.senderFrame.url === ERROR_FILE_URL)
  );
}

ipcMain.on('save-settings', (event, rawSettings) => {
  console.log('Saving settings:', rawSettings);

  if (!isMainSettingsSender(event)) {
    console.warn('Ignoring save-settings from unexpected sender');
    return;
  }

  const normalized = normalizeSettings(rawSettings);
  if (!normalized) {
    console.error('Invalid settings payload');
    return;
  }

  const { settings: normalizedSettings, validUrl } = normalized;

  // Save settings to file
  saveSettings(normalizedSettings);

  // Configure auto-start based on platform
  try {
    configureAutoStart(normalizedSettings.startup);
    console.log(`Startup settings updated: openAtLogin=${normalizedSettings.startup}`);
  } catch (error) {
    console.error('Failed to set startup settings:', error);
  }

  // Create the browser window BEFORE closing mainWindow so window-all-closed never
  // fires during the window transition on Windows and Linux.
  const oldMainWindow = mainWindow;
  createBrowserWindow(
    validUrl,
    normalizedSettings.kiosk,
    normalizedSettings.fullscreen,
    normalizedSettings.refreshMinutes,
    normalizedSettings.networkRefresh,
    normalizedSettings.preventSleep,
    normalizedSettings.hideCursor
  );

  if (oldMainWindow && !oldMainWindow.isDestroyed()) {
    oldMainWindow.close();
  }

  console.log('Browser configured with settings:', normalizedSettings);
});

ipcMain.on('exit-kiosk', (event) => {
  if (!isErrorPageSender(event)) {
    console.warn('Ignoring exit-kiosk from unexpected sender');
    return;
  }
  closeBrowserWindowToSettings();
});

ipcMain.on('get-settings', (event) => {
  if (!isMainSettingsSender(event)) {
    console.warn('Ignoring get-settings from unexpected sender');
    return;
  }
  const settings = loadSettings();
  event.sender.send('settings-loaded', settings);
});

ipcMain.handle('get-failed-url', async (event) => {
  if (!isErrorPageSender(event)) {
    console.warn('Ignoring get-failed-url from unexpected sender');
    return null;
  }
  return lastFailedUrl || null;
});

ipcMain.on('retry-url', (event) => {
  if (!isErrorPageSender(event) || !lastFailedUrl) {
    return;
  }
  const urlToRetry = lastFailedUrl;
  console.log('Retrying connection to URL:', urlToRetry);
  browserWindow.loadURL(urlToRetry).then(() => {
    lastFailedUrl = null;
  }).catch((err) => {
    if (!isAbortError(err)) {
      console.error('Failed to load URL again:', err);
    }
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
