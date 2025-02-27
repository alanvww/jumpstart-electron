const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

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
    if (mainWindow) {
      console.log('Focusing main window');
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (browserWindow) {
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
    icon: path.join(__dirname, '..', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function createBrowserWindow(url, isKiosk, isFullscreen, refreshMinutes, networkRefresh) {
  // Create browser window with initial size
  browserWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false, // Don't show until we're ready
    icon: path.join(__dirname, '..', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
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

  // Register global shortcut for exiting kiosk mode
  const { globalShortcut } = require('electron');
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.close();
    }
  });

  // Clean up shortcut when window is closed
  browserWindow.on('closed', () => {
    globalShortcut.unregisterAll();
  });

  // Load the URL directly
  browserWindow.loadURL(url).catch(err => {
    console.error('Failed to load URL:', err);
    browserWindow.loadFile(path.join(__dirname, 'error.html'));
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

  // Set up network status monitoring if enabled
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

  // Parse the URL to get the protocol, host, and port
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (error) {
    console.error(`Invalid URL for network monitoring: ${targetUrl}`);
    parsedUrl = new URL('https://www.google.com'); // Fallback to Google if URL is invalid
  }

  // Use the user's URL to test connectivity
  const testConnection = () => {
    return new Promise((resolve) => {
      const protocol = parsedUrl.protocol === 'https:' ? require('https') : require('http');

      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname || '/',
        method: 'HEAD', // Use HEAD request for efficiency - we only care about connection, not content
        timeout: 5000
      };

      console.log(`Testing connection to: ${parsedUrl.hostname}...`);

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

  // Check network status every 15 seconds
  const networkCheckInterval = setInterval(async () => {
    try {
      const wasOnline = isCurrentlyOnline;
      isCurrentlyOnline = await testConnection();

      console.log(`Network status check - Previous: ${wasOnline ? 'online' : 'offline'}, Current: ${isCurrentlyOnline ? 'online' : 'offline'}`);

      // Detect reconnection (went from offline to online)
      if (isCurrentlyOnline && !wasOnline) {
        console.log('Network reconnected! Scheduling page refresh...');

        // Wait a moment for the connection to stabilize before refreshing
        setTimeout(() => {
          if (window && !window.isDestroyed()) {
            console.log('Executing page refresh after network reconnection');
            window.reload();
          }
        }, 3000);
      }
    } catch (error) {
      console.error('Error checking network status:', error);
      // If we hit an exception, assume we're offline
      isCurrentlyOnline = false;
    }
  }, 15000);

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

// Setup Linux-specific camera permissions for Raspberry Pi
function setupLinuxCameraPermissions() {
  if (process.platform === 'linux') {
    const appName = app.getName();

    // For Raspberry Pi OS which is Debian-based
    const userDataPath = app.getPath('userData');
    const permScript = path.join(userDataPath, 'setup_cam_permissions.sh');

    // Create a script to grant camera permissions
    const scriptContent = `#!/bin/bash
# Grant camera permissions for ${appName}
# This needs to run with sudo permissions

# Add user to video group if not already a member
if ! groups $USER | grep -q "\\bvideo\\b"; then
  sudo usermod -a -G video $USER
fi

# Set permissions for video devices
sudo chmod a+rw /dev/video*

# Ensure udev rules for camera access
UDEV_RULE_FILE="/etc/udev/rules.d/99-camera-permissions.rules"

if [ ! -f "$UDEV_RULE_FILE" ]; then
  echo 'SUBSYSTEM=="video4linux", GROUP="video", MODE="0666"' | sudo tee "$UDEV_RULE_FILE"
  sudo udevadm control --reload-rules
  sudo udevadm trigger
fi

echo "Camera permissions setup complete for ${appName}"
`;

    try {
      // Write the script to a file
      fs.writeFileSync(permScript, scriptContent, { mode: 0o755 });
      console.log(`Created camera permission script at: ${permScript}`);

      // Ask user for permission to run the script
      dialog.showMessageBox({
        type: 'question',
        title: 'Camera Permissions',
        message: 'Additional permissions are required for camera access on Linux.',
        detail: 'Would you like to set up camera permissions now? This will require sudo access.',
        buttons: ['Yes', 'No'],
        defaultId: 0
      }).then(result => {
        if (result.response === 0) {
          // User agreed, run the script with pkexec or gksudo
          const terminalCmd = `x-terminal-emulator -e "bash -c '${permScript}; echo Press Enter to close; read'"`;
          exec(terminalCmd, (error, stdout, stderr) => {
            if (error) {
              console.error('Error executing camera permissions script:', error);
              dialog.showMessageBox({
                type: 'error',
                title: 'Permission Setup Failed',
                message: 'Could not set up camera permissions.',
                detail: 'Please run the script manually: ' + permScript
              });
            } else {
              console.log('Camera permissions script executed successfully');
              dialog.showMessageBox({
                type: 'info',
                title: 'Camera Permissions',
                message: 'Camera permissions set up successfully.',
                detail: 'You may need to restart the application for changes to take effect.'
              });
            }
          });
        }
      });
    } catch (error) {
      console.error('Failed to create camera permissions script:', error);
    }
  }
}

app.whenReady().then(() => {
  // Check for Linux camera permission issues on first run
  setupLinuxCameraPermissions();

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
    createBrowserWindow(validUrl, settings.kiosk, settings.fullscreen, settings.refreshMinutes, settings.networkRefresh);
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
        createBrowserWindow(validUrl, settings.kiosk, settings.fullscreen, settings.refreshMinutes, settings.networkRefresh);
      } else {
        createMainWindow();
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Store settings in a file

// Get the app data path based on platform
function getAppDataPath() {
  const appName = 'jumpstart';
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA, appName);
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    case 'linux':
      return path.join(os.homedir(), '.config', appName);
    default:
      return path.join(os.homedir(), '.config', appName);
  }
}

// Ensure app data directory exists
const appDataPath = getAppDataPath();
if (!fs.existsSync(appDataPath)) {
  fs.mkdirSync(appDataPath, { recursive: true });
}

const settingsPath = path.join(appDataPath, 'settings.json');

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

// Configure auto-start based on platform
function configureAutoStart(enable) {
  const appPath = app.getPath('exe');
  const appName = 'Jumpstart';

  switch (process.platform) {
    case 'win32':
      // Windows: Create shortcut in startup folder
      const { execSync } = require('child_process');
      const startupFolderPath = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      const shortcutPath = path.join(startupFolderPath, `${appName}.lnk`);

      if (enable) {
        // Create Windows shortcut using PowerShell
        try {
          const powershellCommand = `
            $WshShell = New-Object -ComObject WScript.Shell
            $Shortcut = $WshShell.CreateShortcut("${shortcutPath.replace(/\\/g, '\\\\')}")
            $Shortcut.TargetPath = "${appPath.replace(/\\/g, '\\\\')}"
            $Shortcut.Save()
          `;

          execSync(`powershell -command "${powershellCommand}"`, { windowsHide: true });
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

    case 'darwin':
      // macOS: Use Launch Agents
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `com.${appName}.plist`);

      if (enable) {
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
        exec(`launchctl load ${plistPath}`);
      } else {
        if (fs.existsSync(plistPath)) {
          exec(`launchctl unload ${plistPath}`);
          fs.unlinkSync(plistPath);
        }
      }
      break;

    case 'linux':
      // Linux: Use .desktop file in autostart directory
      const autoStartDir = path.join(os.homedir(), '.config', 'autostart');
      const desktopPath = path.join(autoStartDir, `${appName}.desktop`);

      if (enable) {
        if (!fs.existsSync(autoStartDir)) {
          fs.mkdirSync(autoStartDir, { recursive: true });
        }

        const desktopContent = `[Desktop Entry]
Type=Application
Exec=${appPath}
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

ipcMain.on('save-settings', (event, settings) => {
  console.log('Saving settings:', settings);

  // Destructure settings
  const { url, kiosk, fullscreen, startup, refreshMinutes, networkRefresh } = settings;

  // Save settings to file
  saveSettings(settings);

  // Configure auto-start based on platform
  try {
    // Use Electron's built-in method for development
    app.setLoginItemSettings({ openAtLogin: startup });

    // For production builds, use platform-specific methods
    if (!app.isPackaged) {
      console.log('Using Electron login item settings for development');
    } else {
      configureAutoStart(startup);
    }
  } catch (error) {
    console.error('Failed to set startup settings:', error);
  }

  // Make sure URL has http:// or https:// prefix
  let validUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    validUrl = 'https://' + url;
  }

  if (mainWindow) {
    mainWindow.close();
  }

  // Pass all settings to browser window creation
  createBrowserWindow(validUrl, kiosk, fullscreen, refreshMinutes, networkRefresh);

  // Log the configured settings for debugging
  console.log('Browser configured with settings:', {
    url: validUrl,
    kiosk,
    fullscreen,
    startup,
    refreshMinutes,
    networkRefresh
  });
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

// Enhanced camera/microphone permissions handler
app.on('web-contents-created', (event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'camera' || permission === 'microphone') {
      console.log(`Allowing ${permission} permission`);
      callback(true);
    } else {
      callback(false);
    }
  });

  // For Linux/Raspberry Pi, we need additional handling
  if (process.platform === 'linux') {
    contents.on('did-start-navigation', () => {
      // Set user agent to a desktop browser to improve compatibility
      contents.setUserAgent(contents.getUserAgent() + ' JumpstartApp');

      // Inject script to handle camera permissions more aggressively
      contents.executeJavaScript(`
        // Override getUserMedia to auto-accept camera permissions
        navigator.mediaDevices.getUserMedia = (async (original) => {
          return async (constraints) => {
            try {
              console.log('Requesting media with constraints:', constraints);
              return await original.call(navigator.mediaDevices, constraints);
            } catch (err) {
              console.error('Media access error:', err);
              throw err;
            }
          };
        })(navigator.mediaDevices.getUserMedia);
        
        console.log('Camera permission handling enhanced');
      `);
    });
  }
});