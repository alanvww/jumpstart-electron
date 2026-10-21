<p align="center">
  <img src="./icons/icon.png" alt="Jumpstart Logo" width="128" height="128">
</p>

<h1 align="center">Jumpstart</h1>

<p align="center">
  <a href="https://github.com/alanvww/jumpstart-electron/releases/latest">
    <img src="https://img.shields.io/github/v/release/alanvww/jumpstart-electron?style=flat-square" alt="Latest Release">
  </a>
</p>

A simple cross-platform Electron wrapper lets you open any URL in a dedicated window with options for kiosk mode, full screen mode, and system startup, useful for setting up creative coding projects.

## Features

- **Settings Page**: Configure how the browser will run

  - Enter any URL to open in the browser window
  - Toggle kiosk mode (fullscreen without window controls)
  - Toggle regular fullscreen mode (disabled when kiosk mode is on)
  - Toggle prevent sleep (keeps display awake during exhibitions/installations)
  - Toggle hide cursor (hides mouse pointer on the loaded page)
  - Choose whether the app starts automatically with the system
  - Set auto-refresh interval in minutes
  - Enable automatic refresh when network reconnects (or when a `localhost` port becomes available)

- **Browser Page**: Display the specified URL

  - Automatic camera and microphone permissions for the configured origin
  - Keyboard shortcut `Ctrl+Shift+Q` (Windows/Linux) or `Cmd+Shift+Q` (macOS) to exit kiosk/browser mode and return to settings (`Esc` or "Back to Settings" on the error page)
  - Automatic page recovery on network reconnection or `localhost` port startup (IPv4 `127.0.0.1` and IPv6 `::1`)
  - Timed auto-refresh based on user settings

- **Cross-Platform Support**: Works on Windows, macOS (Apple Silicon `arm64` & Intel `x64`), and Linux, including 64-bit Raspberry Pi OS (`arm64`). 32-bit Raspberry Pi OS (`armv7l`) is not supported.

## Installation

1. Go to the [Releases](https://github.com/alanvww/jumpstart-electron/releases/latest) page of this repository

2. Download the appropriate version for your operating system:

   - **Windows**: Download the NSIS installer (`.exe`) or portable executable (`.exe`)
   - **macOS**: Download the DMG file (`.dmg`) or ZIP archive (`.zip`) for your architecture (`arm64` for Apple Silicon, `x64` for Intel)
   - **Linux**: Select the AppImage (`.AppImage`), Debian package (`.deb`), or RPM package (`.rpm`)

3. Install the application:
   - **Windows**: Run the NSIS installer or launch the portable executable directly
   - **macOS**: Open the DMG file and drag `Jumpstart.app` to your `Applications` folder.
     > **Important (macOS 15 Sequoia / macOS 26 Tahoe Gatekeeper):** Because release builds are ad-hoc signed rather than notarized with a paid Apple Developer ID, macOS may show `"Jumpstart.app is damaged and can't be opened"`. After dragging `Jumpstart.app` to `/Applications`, run the following command in Terminal to clear the quarantine attribute:
     > ```bash
     > xattr -cr /Applications/Jumpstart.app
     > ```
   - **Linux**: Make the AppImage executable (`chmod +x *.AppImage`) or install the `.deb`/`.rpm` package using your package manager

## Usage

1. Launch the Jumpstart application from your applications menu or desktop

2. On the settings page:

   - Enter the URL you want to open (e.g., `https://example.com` or `http://localhost:3000`)
   - Select your desired options:
     - **Kiosk Mode**: Fullscreen without window controls (useful for kiosks or presentations)
     - **Fullscreen Mode**: Regular fullscreen mode with window controls (disabled when kiosk mode is on)
     - **Prevent Sleep**: Keeps the screen awake while the browser window is open (on Linux/Wayland Raspberry Pi OS, you can also disable screen blanking globally via `sudo raspi-config` -> `Display Options` -> `Screen Blanking`)
     - **Hide Cursor**: Hides the mouse cursor over the displayed webpage
     - **Start with System**: Application will start automatically when your computer boots

3. Click "Launch Browser" to open the specified URL

4. To exit kiosk/browser mode and return to settings:
   - Press `Ctrl+Shift+Q` (Windows/Linux) or `Cmd+Shift+Q` (macOS)
   - If the error page is displayed, click **Back to Settings** or press `Esc`

## Technical Details

- Built with Electron for cross-platform compatibility
- Uses plain JavaScript, HTML, and CSS (no additional frameworks)
- Implements secure practices with `contextIsolation`, `sandbox`, strict CSP, and split preload scripts
- Uses Electron's IPC with sender and frame-origin validation
- Automatically grants camera and microphone permissions scoped to the operator-configured origin
- Implements dual-stack (`127.0.0.1` / `::1`) `localhost` port polling and remote HTTP/HTTPS connectivity recovery

## Project Structure

```
├── build
│   └── entitlements.mac.plist # macOS entitlements for ad-hoc signing & camera/mic
├── icons
│   └── icon.png               # Application icon (1024x1024)
├── scripts
│   └── after-sign.js          # macOS ad-hoc codesign & verification hook
├── src
│   ├── main.js                # Electron main process
│   ├── preload.js             # Preload script for local settings window
│   ├── preload-content.js     # Minimal preload script for error recovery page
│   ├── index.html             # Settings page
│   ├── renderer.js            # Settings page logic
│   ├── error.html             # Offline / failed-load recovery page
│   ├── error-renderer.js      # Error page logic
│   └── style.css              # Styling for pages
├── package.json               # Dependencies and build configuration
└── README.md                  # This file
```

## Cross-Platform Features

### Auto-Start with System

The application supports starting automatically with the system on all major platforms:

- **Windows**: Uses the Windows Registry Login Item for NSIS installed builds, or creates a shortcut (`.lnk`) in the user's `Startup` folder for Portable builds
- **macOS**: Registers a native macOS Login Item via Electron's `app.setLoginItemSettings`
- **Linux**: Creates a `.desktop` file in `~/.config/autostart/`

### Building for Production

The application can be built for Windows, macOS, and Linux using `electron-builder`, which is included as a development dependency.

#### Build Commands

Build for all platforms (requires appropriate environment):

```
bun run build:all
```

Build for specific platforms:

```
bun run build:win   # Windows (NSIS + Portable)
bun run build:mac   # macOS (arm64 + x64 DMG & ZIP)
bun run build:linux # Linux (x64 + arm64 AppImage, deb, rpm)
bun run build:pi    # 64-bit Raspberry Pi OS (arm64 deb & AppImage)
```

Or just build for the current platform:

```
bun run build
```

> Note: `build:all` and `build:pi` are shown with `bun run`; you can also use `npm run` if you prefer.

#### Build Outputs

The built applications will be available in the `dist` directory:

- **Windows**:

  - NSIS Installer (`.exe`)
  - Portable version (`.exe`)

- **macOS**:

  - DMG disk image (`.dmg`)
  - ZIP archive (`.zip`)

- **Linux** (built per architecture — `x64` and `arm64`):
  - AppImage (`.AppImage`)
  - Debian package (`.deb`)
  - RPM package (`.rpm`)

  For a Raspberry Pi, use the **arm64** artifacts (`bun run build:pi`) on 64-bit Raspberry Pi OS.

#### Customizing Builds

You can customize the build configuration in the `build` section of `package.json`. See the [electron-builder documentation](https://www.electron.build/) for more options.

## Development

If you want to contribute to Jumpstart or build it from source, follow these steps:

1. Make sure you have [Bun](https://bun.sh/) installed, plus [Node.js](https://nodejs.org/) 24 LTS (the pinned version is in `.nvmrc`; run `nvm use` if you use nvm). Note that Bun and Node 24 do not provide 32-bit ARM (`armv7l`) binaries, so building from source requires a 64-bit OS.

2. Clone this repository:

   ```
   git clone https://github.com/alanvww/jumpstart-electron.git
   cd jumpstart-electron
   ```

3. Install dependencies:

   ```
   bun install
   ```

4. Start the application in development mode:

   ```
   bun start
   ```

5. Make your changes and test them

6. Build the application using one of the build commands mentioned in the "Building for Production" section

## License

MIT License

Copyright (c) 2025 Alan Ren
