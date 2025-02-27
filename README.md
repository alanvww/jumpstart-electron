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
  - Choose whether the app starts automatically with the system
  - Set auto-refresh interval in minutes
  - Enable automatic refresh when network reconnects

- **Browser Page**: Display the specified URL

  - Automatic camera and microphone permissions
  - Exit button to return to settings
  - Keyboard shortcut `Ctrl+Shift+Q` or `Cmd+Shift+Q` to exit kiosk mode
  - Automatic page refresh on network reconnection
  - Timed auto-refresh based on user settings

- **Cross-Platform Support**: Works on Windows, macOS, and Linux (including Raspberry Pi)

## Installation

1. Go to the [Releases](https://github.com/alanvww/jumpstart-electron/releases/latest) page of this repository

2. Download the appropriate version for your operating system:

   - **Windows**: Download portable version (.exe)
   - **macOS**: Download the DMG file (.dmg)
   - **Linux**: Select the AppImage (.AppImage), Debian package (.deb), or RPM package (.rpm) - coming soon!

3. Install the application:
   - **Windows**: Extract the portable version and run the executable
   - **macOS**: Open the DMG file and drag the application to your Applications folder
   - **Linux**: Make the AppImage executable (`chmod +x *.AppImage`) or install the deb/rpm package using your package manager

## Usage

1. Launch the Jumpstart application from your applications menu or desktop

2. On the settings page:

   - Enter the URL you want to open (e.g., `https://example.com`)
   - Select your desired options:
     - **Kiosk Mode**: Fullscreen without window controls (useful for kiosks or presentations)
     - **Fullscreen**: Regular fullscreen mode with window controls (disabled when kiosk mode is on)
     - **Start with System**: Application will start automatically when your computer boots

3. Click "Launch Browser" to open the specified URL

4. To exit kiosk mode and return to settings:
   - Click the "Exit" button in the top-right corner
   - Press the keyboard shortcut `Ctrl+Shift+Q`(Windows), `Cmd+Shift+Q`(Mac OS)

## Technical Details

- Built with Electron for cross-platform compatibility
- Uses plain JavaScript, HTML, and CSS (no additional frameworks)
- Implements secure practices with contextIsolation and preload scripts
- Uses Electron's IPC for communication between main and renderer processes
- Automatically grants camera and microphone permissions for the browser page
- Implements reliable network connectivity monitoring

## Project Structure

```
├── src
│   ├── main.js          # Electron main process
│   ├── preload.js       # Preload script for IPC communication
│   ├── index.html       # Settings page
│   ├── browser.html     # Browser page
│   └── style.css        # Styling for both pages
├── package.json         # Dependencies and scripts
└── README.md            # This file
```

## Cross-Platform Features

### Auto-Start with System

The application supports starting automatically with the system on all major platforms:

- **Windows**: Uses the Windows Registry to configure auto-start
- **macOS**: Creates a Launch Agent in the user's Library folder
- **Linux**: Creates a .desktop file in the autostart directory

### Building for Production

The application can be built for Windows, macOS, and Linux using electron-builder, which is included as a development dependency.

#### Build Commands

Build for all platforms (requires appropriate environment):

```
npm run build:all
```

Build for specific platforms:

```
npm run build:win   # Windows
npm run build:mac   # macOS
npm run build:linux # Linux
```

Or just build for the current platform:

```
npm run build
```

#### Build Outputs

The built applications will be available in the `dist` directory:

- **Windows**:

  - NSIS Installer (.exe)
  - Portable version (.exe)

- **macOS**:

  - DMG disk image (.dmg)
  - ZIP archive (.zip)

- **Linux**:
  - AppImage (.AppImage)
  - Debian package (.deb)
  - RPM package (.rpm)

#### Customizing Builds

You can customize the build configuration in the `build` section of `package.json`. See the [electron-builder documentation](https://www.electron.build/) for more options.

## Development

If you want to contribute to Jumpstart or build it from source, follow these steps:

1. Make sure you have [Node.js](https://nodejs.org/) installed (version 14 or higher recommended)

2. Clone this repository:

   ```
   git clone https://github.com/alanvww/jumpstart-electron.git
   cd jumpstart-electron
   ```

3. Install dependencies:

   ```
   npm install
   ```

4. Start the application in development mode:

   ```
   npm start
   ```

5. Make your changes and test them

6. Build the application using one of the build commands mentioned in the "Building for Production" section

## License

MIT License

Copyright (c) 2025 Alan Ren
