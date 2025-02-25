const { app, BrowserWindow, ipcMain, session } = require('electron');
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

function createBrowserWindow(url, isKiosk, isFullscreen) {
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
    createBrowserWindow(validUrl, settings.kiosk, settings.fullscreen);
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
        createBrowserWindow(validUrl, settings.kiosk, settings.fullscreen);
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
  const appName = 'SimpleBrowser';
  
  switch (process.platform) {
    case 'win32':
      // Windows: Use registry
      const Registry = require('winreg');
      const startupKey = new Registry({
        hive: Registry.HKCU,
        key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      });
      
      if (enable) {
        startupKey.set(appName, Registry.REG_SZ, `"${appPath}"`);
      } else {
        startupKey.remove(appName);
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

ipcMain.on('save-settings', (event, { url, kiosk, fullscreen, startup }) => {
  // Save settings to file
  saveSettings({ url, kiosk, fullscreen, startup });
  
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
  createBrowserWindow(validUrl, kiosk, fullscreen);
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

// Auto-allow camera and microphone permissions
app.on('web-contents-created', (event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true); // Allow camera and microphone
    } else {
      callback(false);
    }
  });
});
