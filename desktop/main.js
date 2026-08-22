// DSH Win7 desktop client — Electron 22 (Chromium 108, last version
// supporting Windows 7). Loads the remote DSH web UI in a fixed app window.
'use strict'

const { app, BrowserWindow, shell, session } = require('electron')
const path = require('path')

// The remote DSH web URL. Change here or via env DSH_URL.
const DSH_URL = process.env.DSH_URL || 'http://122.51.55.180:3080/'

// Single instance: focus the existing window instead of opening a second one.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// Win7 compatibility: disable features that misbehave on old systems.
app.disableHardwareAcceleration()

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'DSH',
    autoHideMenuBar: true,
    backgroundColor: '#101014',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // External links (http(s) not on our target host) open in the system
  // browser; everything else stays inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(DSH_URL)) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(DSH_URL)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.loadURL(DSH_URL)
  mainWindow.on('closed', () => { mainWindow = null })
}

app.on('ready', () => {
  // Chromium 108 on Win7: keep the UA close to a Win7-era Chrome so nothing
  // mis-detects the platform.
  const ua = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = ua
    callback({ requestHeaders: details.requestHeaders })
  })
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
