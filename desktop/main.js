// RFIEC – Commodore floppy drives and printers on the PC (Electron main process)
// The window (app/index.html, app.js) talks to the RFIEC board through Web Serial and to the xum1541 through
// WebUSB, both built into Electron's Chromium. This process adds the port/device chooser, access to the PC's
// folders, the menu and settings.
'use strict';
const { app, BrowserWindow, Menu, ipcMain, protocol, net, shell, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const APP_DIR = path.join(__dirname, 'app');
const SCHEME = 'rfiec';
const MAX_READ = 64 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// ---------- settings ----------
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')); } catch { return {}; } }
function saveSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true }); fs.writeFileSync(SETTINGS(), JSON.stringify(settings, null, 1)); } catch {}
}

// ---------- rfiec://app/… → files of app/ ----------
function serve(req) {
  const u = new URL(req.url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

// ---------- PC folders ----------
ipcMain.handle('fs:home', () => os.homedir());
ipcMain.handle('fs:roots', async () => {
  const out = [{ name: '🏠', path: os.homedir() }];
  for (const k of ['desktop', 'documents', 'downloads']) { try { out.push({ name: k, path: app.getPath(k) }); } catch {} }
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { await fsp.access(l + ':\\'); out.push({ name: l + ':', path: l + ':\\' }); } catch {} }
  } else {
    out.push({ name: '/', path: '/' });
    for (const m of ['/Volumes', '/media/' + os.userInfo().username, '/mnt']) {
      try { for (const d of await fsp.readdir(m)) out.push({ name: d, path: path.join(m, d) }); } catch {}
    }
  }
  return out;
});
ipcMain.handle('fs:list', async (e, dir) => {
  dir = path.resolve(dir || os.homedir());
  const names = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const d of names) {
    if (d.name.startsWith('.')) continue;
    let st = null;
    try { st = await fsp.stat(path.join(dir, d.name)); } catch { continue; }
    entries.push({ name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, sep: path.sep, entries };
});
ipcMain.handle('fs:join', (e, a, b) => path.join(a, b));
ipcMain.handle('fs:read', async (e, file) => {
  const st = await fsp.stat(file);
  if (st.size > MAX_READ) throw new Error('file too large');
  return new Uint8Array(await fsp.readFile(file));
});
ipcMain.handle('fs:exists', async (e, file) => { try { await fsp.access(file); return true; } catch { return false; } });
// writes data; with unique=true picks "name (2).ext" instead of overwriting; returns the path written
ipcMain.handle('fs:write', async (e, file, data, unique) => {
  if (unique) {
    const ext = path.extname(file), base = file.slice(0, file.length - ext.length);
    for (let i = 2; i < 1000; i++) { try { await fsp.access(file); file = base + ' (' + i + ')' + ext; } catch { break; } }
  }
  await fsp.writeFile(file, Buffer.from(data));
  return file;
});
ipcMain.handle('fs:mkdir', async (e, dir) => { await fsp.mkdir(dir, { recursive: true }); return dir; });
ipcMain.handle('fs:rename', async (e, from, to) => { await fsp.rename(from, to); return to; });
ipcMain.handle('fs:trash', async (e, file) => { await shell.trashItem(file); return true; });
ipcMain.handle('fs:reveal', (e, file) => { shell.showItemInFolder(file); });
ipcMain.handle('fs:open', (e, file) => shell.openPath(file));
ipcMain.handle('fs:pickFolder', async (e, start) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: start, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('settings:get', () => settings);
ipcMain.on('settings:set', (e, obj) => { Object.assign(settings, obj); saveSettings(); if ('lang' in obj) buildMenu(); });

// ---------- port / device chooser (drawn by the page) ----------
let win = null, pending = null;
function askChooser(kind, items, callback) {
  if (pending) { try { pending.callback(''); } catch {} }
  pending = { kind, callback };
  win.webContents.send('chooser:open', { kind, items });
}
ipcMain.on('chooser:done', (e, id) => { if (!pending) return; const p = pending; pending = null; p.callback(id || ''); });
const KNOWN_VID = new Set(['2341', '1b4f', '2a03', '16d0']);
const hex4 = v => (typeof v === 'number' ? v.toString(16) : String(v || '')).toLowerCase().padStart(4, '0');

function setupSession(ses) {
  ses.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault();
    const items = portList.map(p => ({ id: p.portId, name: p.portName || p.displayName || p.portId, label: p.displayName || p.productName || '',
      vid: hex4(p.vendorId), pid: hex4(p.productId), known: KNOWN_VID.has(hex4(p.vendorId)) }));
    items.sort((a, b) => (b.known - a.known) || a.name.localeCompare(b.name));
    askChooser('serial', items, callback);
  });
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const items = details.deviceList.map(d => ({ id: d.deviceId, name: d.productName || 'USB ' + hex4(d.vendorId) + ':' + hex4(d.productId),
      label: d.manufacturerName || '', vid: hex4(d.vendorId), pid: hex4(d.productId), known: hex4(d.vendorId) === '16d0' }));
    askChooser('usb', items, callback);
  });
  ses.setPermissionCheckHandler((wc, permission) => ['serial', 'usb', 'clipboard-sanitized-write'].includes(permission));
  ses.setDevicePermissionHandler(d => d.deviceType === 'serial' || d.deviceType === 'usb');
}

// ---------- menu ----------
const tr = (it, en) => (settings.lang === 'en' ? en : it);
const send = (ch, ...a) => win && win.webContents.send(ch, ...a);
function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: tr('Apri cartella…', 'Open folder…'), accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'pickFolder') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: tr('Esci', 'Quit') }
    ] },
    { label: tr('Modifica', 'Edit'), submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: tr('Interfaccia', 'Interface'), submenu: [
      { label: tr('Collega la RFIEC', 'Connect the RFIEC'), accelerator: 'CmdOrCtrl+R', click: () => send('menu', 'connectRfiec') },
      { label: tr('Collega la xum1541', 'Connect the xum1541'), click: () => send('menu', 'connectXum') },
      { label: tr('Scollega', 'Disconnect'), click: () => send('menu', 'disconnect') },
      { type: 'separator' },
      { label: tr('Reset del bus', 'Bus reset'), click: () => send('menu', 'busReset') },
      { label: tr('Installa firmware sul Pro Micro…', 'Install firmware on the Pro Micro…'), click: () => send('menu', 'firmware') }
    ] },
    { label: tr('Vista', 'View'), submenu: [
      { label: tr('Floppy ⇄ PC', 'Floppy ⇄ PC'), accelerator: 'CmdOrCtrl+1', click: () => send('menu', 'tab:drive') },
      { label: tr('Il C64 usa il PC', 'C64 uses the PC'), accelerator: 'CmdOrCtrl+2', click: () => send('menu', 'tab:emu') },
      { label: tr('Stampa', 'Print'), accelerator: 'CmdOrCtrl+3', click: () => send('menu', 'tab:print') },
      { label: tr('Registro', 'Log'), accelerator: 'CmdOrCtrl+L', click: () => send('menu', 'log') },
      { type: 'separator' },
      { label: 'Italiano', type: 'radio', checked: settings.lang !== 'en', click: () => setLang('it') },
      { label: 'English', type: 'radio', checked: settings.lang === 'en', click: () => setLang('en') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'toggleDevTools' }, { role: 'togglefullscreen' }
    ] },
    { label: tr('Aiuto', 'Help'), submenu: [
      { label: tr('Guida XUM1541 e RFIEC', 'XUM1541 and RFIEC guide'), click: () => shell.openExternal(settings.lang === 'en' ? 'https://retrofixer.it/en/xum1541/' : 'https://retrofixer.it/xum1541/') },
      { label: tr('Progetto su GitHub', 'Project on GitHub'), click: () => shell.openExternal('https://github.com/zeus074/RFIEC') },
      { type: 'separator' },
      { label: tr('Versione ', 'Version ') + app.getVersion(), enabled: false }
    ] }
  ]));
}
function setLang(lang) { settings.lang = lang; saveSettings(); buildMenu(); send('menu', 'lang:' + lang); }

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1360, height: b.height || 900, x: b.x, y: b.y, minWidth: 980, minHeight: 620,
    backgroundColor: '#100d26', title: 'RFIEC', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(SCHEME + '://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.on('close', () => { settings.bounds = win.getBounds(); saveSettings(); });
  win.loadURL(SCHEME + '://app/index.html');
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
