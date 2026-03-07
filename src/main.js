const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const net = require("net");

const APP_NAME = "Jumpstart";
const APP_ICON_PATH = path.join(__dirname, "..", "icons", "icon.png");
const MEDIA_PERMISSIONS = new Set(["media", "camera", "microphone"]);

app.setName(APP_NAME);

if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(APP_ICON_PATH);
}

function getOriginFromUrl(rawUrl) {
    try {
        return new URL(rawUrl).origin;
    } catch (error) {
        return null;
    }
}

function setMediaPermissionHandler(electronSession, trustedOrigin) {
    electronSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
            if (!MEDIA_PERMISSIONS.has(permission)) {
                callback(false);
                return;
            }

            const requestingUrl =
                details?.requestingUrl ||
                details?.embeddingOrigin ||
                webContents.getURL();
            const requestingOrigin = getOriginFromUrl(requestingUrl);
            const shouldAllow = Boolean(
                trustedOrigin && requestingOrigin === trustedOrigin,
            );

            if (!shouldAllow) {
                console.log(
                    `Denying ${permission} permission for origin: ${requestingOrigin || "unknown"}`,
                );
                callback(false);
                return;
            }

            console.log(
                `Allowing ${permission} permission for trusted origin: ${requestingOrigin}`,
            );
            callback(true);
        },
    );
}

function setupLinuxCameraPermissions() {
    if (process.platform !== "linux") {
        return;
    }

    try {
        app.commandLine.appendSwitch(
            "enable-features",
            "WebRTCPipeWireCapturer",
        );
        console.log("Enabled Linux WebRTC camera compatibility flags");
    } catch (error) {
        console.error(
            "Failed to configure Linux camera compatibility flags:",
            error,
        );
    }
}

// Function to enable camera access on Linux
function enableCameraAccess(browserWindow, trustedOrigin) {
    // Check if we're on Linux
    if (process.platform === "linux") {
        console.log("Setting up additional camera access for Linux");

        // Add required preferences to the session
        browserWindow.webContents.session.webRequest.onHeadersReceived(
            { urls: ["*://*/*"] },
            (details, callback) => {
                const requestOrigin = getOriginFromUrl(details.url);
                if (!trustedOrigin || requestOrigin !== trustedOrigin) {
                    callback({ responseHeaders: details.responseHeaders });
                    return;
                }

                callback({
                    responseHeaders: {
                        ...details.responseHeaders,
                        "Permissions-Policy": [
                            "camera=(self), microphone=(self)",
                        ],
                    },
                });
            },
        );

        // When page has loaded, inject a script to ensure camera API is ready
        browserWindow.webContents.on("did-finish-load", () => {
            browserWindow.webContents
                .executeJavaScript(
                    `
        // Check if mediaDevices exists
        if (!navigator.mediaDevices) {
          console.log('mediaDevices not found, creating...');
          navigator.mediaDevices = {};
        }

        // Check if getUserMedia exists
        if (!navigator.mediaDevices.getUserMedia) {
          console.log('getUserMedia not found, creating...');
          navigator.mediaDevices.getUserMedia = function(constraints) {
            // First try the new style
            var getUserMedia = navigator.webkitGetUserMedia || navigator.mozGetUserMedia;

            if (!getUserMedia) {
              console.error('getUserMedia is not available in this browser');
              return Promise.reject(new Error('getUserMedia is not implemented in this browser'));
            }

            // Wrap the old API in a Promise
            return new Promise(function(resolve, reject) {
              getUserMedia.call(navigator, constraints, resolve, reject);
            });
          };
        }

        // Report camera status
        console.log('Camera API status: navigator.mediaDevices =',
                    navigator.mediaDevices ? 'available' : 'not available');
        console.log('getUserMedia =',
                    navigator.mediaDevices.getUserMedia ? 'available' : 'not available');
      `,
                )
                .then(() => {
                    console.log("Camera access script injected successfully");
                })
                .catch((err) => {
                    console.error(
                        "Failed to inject camera access script:",
                        err,
                    );
                });
        });
    }
}

// Ensure only one instance of the app runs
console.log("Requesting single instance lock...");
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    console.log("Another instance is already running. Quitting...");
    app.quit();
    return; // Important: stop execution here
} else {
    console.log("This is the first instance of the app");
    // This is the first instance - continue with app initialization
    app.on("second-instance", (event, commandLine, workingDirectory) => {
        console.log("Second instance detected, focusing existing window");
        // Someone tried to run a second instance, focus our window instead
        if (mainWindow && !mainWindow.isDestroyed()) {
            console.log("Focusing main window");
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        } else if (browserWindow && !browserWindow.isDestroyed()) {
            console.log("Focusing browser window");
            if (browserWindow.isMinimized()) browserWindow.restore();
            browserWindow.focus();
        }
    });
}

let mainWindow, browserWindow;
let refreshTimer = null;
let failedUrl = null;

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        icon: APP_ICON_PATH,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function createBrowserWindow(
    url,
    isKiosk,
    isFullscreen,
    refreshMinutes,
    networkRefresh,
) {
    // Create browser window with initial size
    browserWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        show: false, // Don't show until we're ready
        icon: APP_ICON_PATH,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
        },
    });

    const trustedOrigin = getOriginFromUrl(url);
    setMediaPermissionHandler(browserWindow.webContents.session, trustedOrigin);

    // Explicitly enable camera access for Linux
    if (process.platform === "linux") {
        // Enable camera specific features
        enableCameraAccess(browserWindow, trustedOrigin);
    }

    // Set up event to show settings page when browser window is closed
    browserWindow.on("closed", () => {
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
    browserWindow.once("ready-to-show", () => {
        if (isKiosk) {
            browserWindow.setKiosk(true);
        } else if (isFullscreen) {
            browserWindow.setFullScreen(true);
        }
        browserWindow.show();
    });

    // Register global shortcut for exiting kiosk mode
    const { globalShortcut } = require("electron");
    globalShortcut.register("CommandOrControl+Shift+Q", () => {
        if (browserWindow && !browserWindow.isDestroyed()) {
            browserWindow.close();
        }
    });

    // Clean up shortcut when window is closed
    browserWindow.on("closed", () => {
        globalShortcut.unregisterAll();
    });

    // Load the URL directly
    failedUrl = null;
    browserWindow.loadURL(url).catch((err) => {
        console.error("Failed to load URL:", err);

        // Store the original URL so we can access it from error.html
        if (browserWindow && !browserWindow.isDestroyed()) {
            failedUrl = url;
        }

        browserWindow.loadFile(path.join(__dirname, "error.html"));
    });

    // Set up auto-refresh timer if enabled
    if (refreshMinutes && refreshMinutes > 0) {
        console.log(`Setting up auto-refresh every ${refreshMinutes} minutes`);
        // Convert minutes to milliseconds
        const refreshInterval = refreshMinutes * 60 * 1000;
        refreshTimer = setInterval(() => {
            if (browserWindow && !browserWindow.isDestroyed()) {
                console.log("Auto-refreshing page...");
                browserWindow.reload();
            } else {
                clearInterval(refreshTimer);
                refreshTimer = null;
            }
        }, refreshInterval);
    }

    // Set up network status monitoring if enabled
    console.log("Network refresh setting:", networkRefresh);
    if (networkRefresh) {
        console.log("Enabling network status monitoring");
        monitorNetworkStatus(browserWindow, url);
    } else {
        console.log("Network status monitoring is disabled");
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
        parsedUrl = new URL("https://www.google.com"); // Fallback to Google if URL is invalid
    }

    // Check if the URL is pointing to localhost
    const isLocalhostUrl =
        parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname === "127.0.0.1";

    // Extract port from URL
    const port = parsedUrl.port
        ? parseInt(parsedUrl.port, 10)
        : parsedUrl.protocol === "https:"
          ? 443
          : 80;

    console.log(
        `URL analysis: ${parsedUrl.hostname}:${port} (Localhost URL: ${isLocalhostUrl})`,
    );

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
            socket.connect(port, "127.0.0.1", () => {
                clearTimeout(timeout);
                socket.destroy();
                console.log(`Successfully connected to port ${port}`);
                resolve(true);
            });

            // Handle connection errors
            socket.on("error", (err) => {
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
            const protocol =
                parsedUrl.protocol === "https:"
                    ? require("https")
                    : require("http");

            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname || "/",
                method: "HEAD", // Use HEAD request for efficiency - we only care about connection, not content
                timeout: 5000,
            };

            console.log(`Testing connection to: ${parsedUrl.hostname}...`);

            const request = protocol.request(options, (response) => {
                // Any response means we're online (even if it's a redirect or error code)
                console.log(
                    `Connection test to ${parsedUrl.hostname}: HTTP ${response.statusCode}`,
                );
                response.destroy(); // Properly close the connection
                resolve(true);
            });

            // Set a timeout to avoid hanging
            request.setTimeout(5000, () => {
                console.log(
                    `Connection test to ${parsedUrl.hostname} timed out`,
                );
                request.destroy();
                resolve(false);
            });

            // Handle connection errors
            request.on("error", (err) => {
                console.log(
                    `Connection test to ${parsedUrl.hostname} error: ${err.message}`,
                );
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
            const wasPortAvailable = isLocalPortAvailable;

            // Get current connection status
            isCurrentlyOnline = await testConnection();

            // Update port status only if it's a localhost URL
            if (isLocalhostUrl) {
                isLocalPortAvailable = isCurrentlyOnline;
                console.log(
                    `Localhost port ${port} status check - Previous: ${wasPortAvailable ? "available" : "unavailable"}, Current: ${isLocalPortAvailable ? "available" : "unavailable"}`,
                );

                // Detect port becoming available
                if (isLocalPortAvailable && !wasPortAvailable) {
                    console.log(
                        `Localhost port ${port} is now available! Scheduling page refresh...`,
                    );

                    // Wait a moment for the service to fully initialize before refreshing
                    setTimeout(() => {
                        if (window && !window.isDestroyed()) {
                            console.log(
                                `Executing page refresh after localhost port ${port} became available`,
                            );
                            window.reload();
                        }
                    }, 2000);
                }
            } else {
                // Regular network status handling for non-localhost URLs
                console.log(
                    `Network status check - Previous: ${wasOnline ? "online" : "offline"}, Current: ${isCurrentlyOnline ? "online" : "offline"}`,
                );

                // Detect reconnection (went from offline to online)
                if (isCurrentlyOnline && !wasOnline) {
                    console.log(
                        "Network reconnected! Scheduling page refresh...",
                    );

                    // Wait a moment for the connection to stabilize before refreshing
                    setTimeout(() => {
                        if (window && !window.isDestroyed()) {
                            console.log(
                                "Executing page refresh after network reconnection",
                            );
                            window.reload();
                        }
                    }, 3000);
                }
            }
        } catch (error) {
            console.error("Error checking network status:", error);
            // If we hit an exception, assume we're offline
            isCurrentlyOnline = false;
            if (isLocalhostUrl) {
                isLocalPortAvailable = false;
            }
        }
    }, 5000); // Check more frequently (every 5 seconds) to better detect localhost ports becoming available

    // Perform an immediate check
    testConnection().then((online) => {
        console.log(`Initial network status: ${online ? "online" : "offline"}`);
        isCurrentlyOnline = online;
    });

    // Clean up interval when window is closed
    window.on("closed", () => {
        console.log("Cleaning up network monitoring");
        clearInterval(networkCheckInterval);
    });
}

app.whenReady().then(() => {
    // Check for Linux camera permission issues on first run
    setupLinuxCameraPermissions();

    // Check if we have saved settings with a URL
    const settings = loadSettings();
    console.log("Loaded settings:", settings);

    if (settings && settings.url) {
        console.log("Starting with saved URL:", settings.url);
        // Start directly with the saved URL
        let validUrl = settings.url;
        if (
            !validUrl.startsWith("http://") &&
            !validUrl.startsWith("https://")
        ) {
            validUrl = "https://" + validUrl;
        }
        console.log("Opening browser window with URL:", validUrl);
        createBrowserWindow(
            validUrl,
            settings.kiosk,
            settings.fullscreen,
            settings.refreshMinutes,
            settings.networkRefresh,
        );
    } else {
        console.log("No saved URL found, showing settings page");
        // No saved URL, show settings page
        createMainWindow();
    }

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            // Check again for saved settings when activating
            const settings = loadSettings();
            if (settings && settings.url) {
                let validUrl = settings.url;
                if (
                    !validUrl.startsWith("http://") &&
                    !validUrl.startsWith("https://")
                ) {
                    validUrl = "https://" + validUrl;
                }
                createBrowserWindow(
                    validUrl,
                    settings.kiosk,
                    settings.fullscreen,
                    settings.refreshMinutes,
                    settings.networkRefresh,
                );
            } else {
                createMainWindow();
            }
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

// Store settings in a file

// Get the app data path based on platform
function getAppDataPath() {
    const appName = APP_NAME.toLowerCase();
    switch (process.platform) {
        case "win32":
            return path.join(process.env.APPDATA, appName);
        case "darwin":
            return path.join(
                os.homedir(),
                "Library",
                "Application Support",
                appName,
            );
        case "linux":
            return path.join(os.homedir(), ".config", appName);
        default:
            return path.join(os.homedir(), ".config", appName);
    }
}

// Ensure app data directory exists
const appDataPath = getAppDataPath();
if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
}

const settingsPath = path.join(appDataPath, "settings.json");

// Save settings to file
function saveSettings(settings) {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (error) {
        console.error("Failed to save settings:", error);
    }
}

// Load settings from file
function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        }
    } catch (error) {
        console.error("Failed to load settings:", error);
    }
    return {};
}

// Configure auto-start based on platform
function configureAutoStart(enable) {
    const appPath = app.getPath("exe");
    const appName = APP_NAME;

    switch (process.platform) {
        case "win32":
            // Windows: Create shortcut in startup folder
            const { execSync } = require("child_process");
            const startupFolderPath = path.join(
                process.env.APPDATA,
                "Microsoft",
                "Windows",
                "Start Menu",
                "Programs",
                "Startup",
            );
            const shortcutPath = path.join(startupFolderPath, `${appName}.lnk`);

            if (enable) {
                // Create Windows shortcut using PowerShell
                try {
                    const powershellCommand = `
            $WshShell = New-Object -ComObject WScript.Shell
            $Shortcut = $WshShell.CreateShortcut("${shortcutPath.replace(/\\/g, "\\\\")}")
            $Shortcut.TargetPath = "${appPath.replace(/\\/g, "\\\\")}"
            $Shortcut.Save()
          `;

                    execSync(`powershell -command "${powershellCommand}"`, {
                        windowsHide: true,
                    });
                    console.log(`Created startup shortcut at: ${shortcutPath}`);
                } catch (error) {
                    console.error("Failed to create startup shortcut:", error);
                }
            } else {
                // Remove shortcut if it exists
                if (fs.existsSync(shortcutPath)) {
                    try {
                        fs.unlinkSync(shortcutPath);
                        console.log(
                            `Removed startup shortcut: ${shortcutPath}`,
                        );
                    } catch (error) {
                        console.error(
                            "Failed to remove startup shortcut:",
                            error,
                        );
                    }
                }
            }
            break;

        case "darwin":
            // macOS: Use Launch Agents
            const launchAgentsDir = path.join(
                os.homedir(),
                "Library",
                "LaunchAgents",
            );
            const plistPath = path.join(
                launchAgentsDir,
                `com.${appName}.plist`,
            );

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

        case "linux":
            // Linux: Use .desktop file in autostart directory
            const autoStartDir = path.join(
                os.homedir(),
                ".config",
                "autostart",
            );
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

ipcMain.on("save-settings", (event, settings) => {
    console.log("Saving settings:", settings);

    if (!settings || typeof settings !== "object") {
        console.error("Invalid settings payload: expected an object");
        return;
    }

    const rawUrl = typeof settings.url === "string" ? settings.url.trim() : "";
    if (!rawUrl) {
        console.error("Invalid settings payload: URL is required");
        return;
    }

    const kiosk = Boolean(settings.kiosk);
    const fullscreen = !kiosk && Boolean(settings.fullscreen);
    const startup = Boolean(settings.startup);
    const refreshMinutesNumber = Number(settings.refreshMinutes);
    const refreshMinutes = Number.isFinite(refreshMinutesNumber)
        ? Math.max(0, Math.floor(refreshMinutesNumber))
        : 0;
    const networkRefresh = Boolean(settings.networkRefresh);

    const normalizedSettings = {
        url: rawUrl,
        kiosk,
        fullscreen,
        startup,
        refreshMinutes,
        networkRefresh,
    };

    // Save settings to file
    saveSettings(normalizedSettings);

    // Configure auto-start based on platform
    try {
        // Use Electron's built-in method for development
        app.setLoginItemSettings({ openAtLogin: startup });

        // For production builds, use platform-specific methods
        if (!app.isPackaged) {
            console.log("Using Electron login item settings for development");
        } else {
            configureAutoStart(startup);
        }
    } catch (error) {
        console.error("Failed to set startup settings:", error);
    }

    // Make sure URL has http:// or https:// prefix
    let validUrl = rawUrl;
    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
        validUrl = "https://" + rawUrl;
    }

    if (mainWindow) {
        mainWindow.close();
    }

    // Pass all settings to browser window creation
    createBrowserWindow(
        validUrl,
        kiosk,
        fullscreen,
        refreshMinutes,
        networkRefresh,
    );

    // Log the configured settings for debugging
    console.log("Browser configured with settings:", {
        url: validUrl,
        kiosk,
        fullscreen,
        startup,
        refreshMinutes,
        networkRefresh,
    });
});

ipcMain.on("exit-kiosk", () => {
    if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.close();
    }
});

// Handle get-settings request from renderer
ipcMain.on("get-settings", (event) => {
    const settings = loadSettings();
    event.sender.send("settings-loaded", settings);
});

// Handle get-failed-url request from renderer (used in error.html)
ipcMain.handle("get-failed-url", async (event) => {
    return failedUrl;
});

// Handle retry-url request from renderer (used in error.html)
ipcMain.on("retry-url", (event) => {
    if (!browserWindow || browserWindow.isDestroyed() || !failedUrl) {
        return;
    }

    const urlToRetry = failedUrl;
    console.log("Retrying connection to URL:", urlToRetry);
    browserWindow
        .loadURL(urlToRetry)
        .then(() => {
            failedUrl = null;
        })
        .catch((err) => {
            console.error("Failed to load URL again:", err);
        });
});
