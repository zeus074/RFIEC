// Bridge between the window and the main process: PC folders, settings, port chooser, menu commands.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('host', {
  platform: process.platform,
  fs: {
    home: () => inv('fs:home'),
    roots: () => inv('fs:roots'),
    list: dir => inv('fs:list', dir),
    join: (a, b) => inv('fs:join', a, b),
    read: file => inv('fs:read', file),
    exists: file => inv('fs:exists', file),
    write: (file, data, unique) => inv('fs:write', file, data, unique),
    mkdir: dir => inv('fs:mkdir', dir),
    rename: (a, b) => inv('fs:rename', a, b),
    trash: file => inv('fs:trash', file),
    reveal: file => inv('fs:reveal', file),
    open: file => inv('fs:open', file),
    pickFolder: start => inv('fs:pickFolder', start)
  },
  settings: () => inv('settings:get'),
  setSettings: obj => ipcRenderer.send('settings:set', obj),
  onChooser: cb => ipcRenderer.on('chooser:open', (e, req) => cb(req)),
  chooserDone: id => ipcRenderer.send('chooser:done', id),
  onMenu: cb => ipcRenderer.on('menu', (e, cmd) => cb(cmd))
});
