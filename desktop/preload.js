// Bridge between the app shell page and the main process (port chooser, language, menu commands).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rfiecApp', {
  settings: () => ipcRenderer.invoke('rfiec:settings'),
  setLang: lang => ipcRenderer.send('rfiec:lang', lang),
  choose: id => ipcRenderer.send('rfiec:chosen', id),
  onChoose: cb => ipcRenderer.on('rfiec:choose', (e, req) => cb(req)),
  onTab: cb => ipcRenderer.on('rfiec:tab', (e, tab) => cb(tab)),
  onLang: cb => ipcRenderer.on('rfiec:setlang', (e, lang) => cb(lang)),
  platform: process.platform
});
