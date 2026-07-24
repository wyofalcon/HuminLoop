// src/window-factory.js — shared BrowserWindow construction.
// Every HuminLoop window uses the same webPreferences (single preload,
// context isolation, no node integration); this helper is the one place that
// block lives so new windows don't copy it. Pass any BrowserWindow options
// plus `file` (basename under renderer/).

const { BrowserWindow } = require('electron');
const path = require('path');

function createAppWindow({ file, ...options }) {
  const win = new BrowserWindow({
    backgroundColor: '#13131f',
    ...options,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      ...(options.webPreferences || {}),
    },
  });
  if (file) win.loadFile(path.join(__dirname, '..', 'renderer', file));
  return win;
}

module.exports = { createAppWindow };
