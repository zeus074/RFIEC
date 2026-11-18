// RFIEC desktop – Electron main process
// The drive and printer programs are the same ones used on retrofixer.it (Web Serial for RFIEC, WebUSB for the
// xum1541): Electron ships Chromium, so they run offline on Windows, Linux and macOS. This file adds what a
// browser normally provides: the port/device chooser, file downloads, external links and the CSDb proxy.
'use strict';
const { app, BrowserWindow, Menu, ipcMain, protocol, net, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const csdb = require('./csdb');

const APP_DIR = path.join(__dirname, 'app');
const SCHEME = 'rfiec';
const HOME = SCHEME + '://app/index.html';

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

// ---------- settings (language) ----------
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true }); fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 1)); } catch {}
}
let settings = {};

// ---------- app:// files and the CSDb proxy ----------
function serve(req) {
  const u = new URL(req.url);
  if (u.pathname === '/csdb-proxy' || u.pathname === '/wp-json/retrofixer/v1/csdb') return csdb.handle(u.searchParams);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

// ---------- port / device chooser (the page shows the list, see app/shell.js) ----------
let win = null;
let pending = null;            // { kind, callback }
function askChooser(kind, items, callback) {
  if (pending) { try { pending.callback(''); } catch {} }
  pending = { kind, callback };
  win.webContents.send('rfiec:choose', { kind, items });
}
ipcMain.on('rfiec:chosen', (e, id) => {
  if (!pending) return;
  const p = pending; pending = null;
  p.callback(id || '');
});
ipcMain.handle('rfiec:settings', () => settings);
ipcMain.on('rfiec:lang', (e, lang) => { settings.lang = lang; saveSettings(settings); buildMenu(); });

const KNOWN_VID = new Set(['2341', '1b4f', '2a03', '16d0']);   // Arduino/Leonardo/Pro Micro (RFIEC, bootloader), SparkFun, xum1541
function hex4(v) { return (typeof v === 'number' ? v.toString(16) : String(v || '')).toLowerCase().padStart(4, '0'); }

function setupSession(ses) {
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    const items = portList.map(p => ({
      id: p.portId,
      name: p.portName || p.displayName || p.portId,
      label: p.displayName || p.productName || '',
      vid: hex4(p.vendorId), pid: hex4(p.productId),
      known: KNOWN_VID.has(hex4(p.vendorId))
    }));
    items.sort((a, b) => (b.known - a.known) || a.name.localeCompare(b.name));
    askChooser('serial', items, callback);
  });
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const items = details.deviceList.map(d => ({
      id: d.deviceId, name: d.productName || 'USB ' + hex4(d.vendorId) + ':' + hex4(d.productId),
      label: d.manufacturerName || '', vid: hex4(d.vendorId), pid: hex4(d.productId), known: hex4(d.vendorId) === '16d0'
    }));
    askChooser('usb', items, callback);
  });
  ses.setPermissionCheckHandler((wc, permission) => ['serial', 'usb', 'clipboard-sanitized-write', 'fullscreen'].includes(permission) || permission === 'media');
  ses.setDevicePermissionHandler(details => details.deviceType === 'serial' || details.deviceType === 'usb');
  ses.on('will-download', (e, item) => {
    // a native "Save as" dialog, starting in the Downloads folder
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
}

// ---------- window and menu ----------
function tr(it, en) { return settings.lang === 'en' ? en : it; }
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tmpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: tr('File', 'File'), submenu: [isMac ? { role: 'close' } : { role: 'quit', label: tr('Esci', 'Quit') }] },
    { label: tr('Modifica', 'Edit'), submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: tr('Vista', 'View'), submenu: [
      { label: 'Drive', accelerator: 'CmdOrCtrl+1', click: () => win && win.webContents.send('rfiec:tab', 'drive') },
      { label: tr('Stampante', 'Printer'), accelerator: 'CmdOrCtrl+2', click: () => win && win.webContents.send('rfiec:tab', 'printer') },
      { type: 'separator' },
      { label: 'Italiano', type: 'radio', checked: settings.lang !== 'en', click: () => setLang('it') },
      { label: 'English', type: 'radio', checked: settings.lang === 'en', click: () => setLang('en') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'reload', label: tr('Ricarica (scollega tutto)', 'Reload (disconnects everything)') }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }
    ] },
    { label: tr('Aiuto', 'Help'), submenu: [
      { label: tr('Guida XUM1541 e RFIEC', 'XUM1541 and RFIEC guide'), click: () => shell.openExternal(settings.lang === 'en' ? 'https://retrofixer.it/en/xum1541/' : 'https://retrofixer.it/xum1541/') },
      { label: tr('Guida della stampante', 'Printer guide'), click: () => shell.openExternal(settings.lang === 'en' ? 'https://retrofixer.it/en/stampante-commodore/' : 'https://retrofixer.it/stampante-commodore/') },
      { label: tr('Progetto su GitHub', 'Project on GitHub'), click: () => shell.openExternal('https://github.com/zeus074/RFIEC') },
      { type: 'separator' },
      { label: tr('Versione ', 'Version ') + app.getVersion(), enabled: false }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tmpl));
}
function setLang(lang) {
  settings.lang = lang; saveSettings(settings); buildMenu();
  if (win) win.webContents.send('rfiec:setlang', lang);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 920, minWidth: 760, minHeight: 560,
    backgroundColor: '#0f0c24', title: 'RFIEC',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(SCHEME + '://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('did-create-window', w => w.close());
  win.loadURL(HOME);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  settings = loadSettings();
  if (!settings.lang) settings.lang = /^it/i.test(app.getLocale()) ? 'it' : 'en';
  protocol.handle(SCHEME, serve);
  setupSession(session.defaultSession);
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
