/* copiato da floppy-web/src/cbm.js da build.py: non modificare qui */
/* RetroFixer · Floppy C64 · xum1541 / ZoomFloppy via WebUSB
 * Xum1541: trasporto USB (stesso protocollo del plugin xum1541 di OpenCBM, vedi PROTOCOLLO-XUM1541.md).
 * Cbm:     le funzioni cbm_* di OpenCBM (listen, talk, open, close, raw_read, raw_write, exec_command, device_status…).
 * Drive:   operazioni ad alto livello (directory, formattazione, cancellazione, rinomina, validazione, PRG, blocchi, dischi interi).
 */
(function (RF) {
'use strict';

var X = {
  VID: 0x16D0, PID: 0x0504, EP_IN: 3, EP_OUT: 4, IFACE: 0,
  ECHO: 0, INIT: 1, RESET: 2, SHUTDOWN: 3, GITREV: 6,
  READ: 8, WRITE: 9, GET_EOI: 23, CLEAR_EOI: 24,
  CBM: 0x10, F_TALK: 0x01, F_ATN: 0x02,
  BUSY: 1, READY: 2, ERROR: 3, DOING_RESET: 0x01, MAX_XFER: 32768, MIN_VERSION: 7,
  CTRL_TIMEOUT: 1650,
  WATCHDOG: 8000   // un trasferimento senza risposta per così tanto: bus IEC bloccato (per esempio nessun drive acceso)
};
RF.XUM = X;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function withTimeout(p, ms, what) {
  return new Promise(function (res, rej) {
    var t = setTimeout(function () { rej(new Error('Timeout USB: ' + what)); }, ms);
    p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
  });
}
function u8(dv) { return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength); }
function hex(b) { return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join(' '); }
function concat(parts) {
  var n = 0, i; for (i = 0; i < parts.length; i++) n += parts[i].length;
  var out = new Uint8Array(n), p = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
  return out;
}
RF.util = {sleep: sleep, hex: hex, concat: concat};

/* ======================= trasporto USB ======================= */
function Xum1541(device, log) {
  this.dev = device; this.log = log || function () {}; this.version = 0; this.caps = 0; this.status = 0; this.gitrev = '';
  this.simulated = !!device.simulated;
  // pending: trasferimento in corso; dirty: la xum1541 è stata sbloccata a forza e va riaperta prima di riusarla
  this.pending = null; this.dirty = null; this.cancel = false; this.slowUntil = 0; this.watchdog = X.WATCHDOG;
}
Xum1541.supported = function () { return typeof navigator !== 'undefined' && !!navigator.usb; };
Xum1541.filters = [{vendorId: X.VID, productId: X.PID}];
// chiede all'utente di scegliere la xum1541 (finestra di Chrome / Edge)
Xum1541.request = function () { return navigator.usb.requestDevice({filters: Xum1541.filters}); };
// dispositivi già autorizzati in visite precedenti
Xum1541.known = function () {
  if (!Xum1541.supported()) return Promise.resolve([]);
  return navigator.usb.getDevices().then(function (l) { return l.filter(function (d) { return d.vendorId === X.VID && d.productId === X.PID; }); });
};
var XP = Xum1541.prototype;
XP.ctrlIn = function (req, len) {
  return withTimeout(this.dev.controlTransferIn({requestType: 'class', recipient: 'device', request: req, value: 0, index: 0}, len), X.CTRL_TIMEOUT, 'control ' + req)
    .then(function (r) { if (r.status !== 'ok') throw new Error('USB control ' + req + ': ' + r.status); return u8(r.data); });
};
XP.ctrlOut = function (req, timeout) {
  return withTimeout(this.dev.controlTransferOut({requestType: 'class', recipient: 'device', request: req, value: 0, index: 0}), timeout || X.CTRL_TIMEOUT, 'control ' + req)
    .then(function (r) { if (r.status !== 'ok') throw new Error('USB control ' + req + ': ' + r.status); });
};
/* Ogni trasferimento bulk passa da guard(): se il firmware resta fermo ad aspettare il bus (nessun drive, linee
 * scollegate) il trasferimento USB non finirebbe mai. Dopo il tempo massimo, o con "Interrompi", unstick() manda
 * il RESET di controllo (il firmware abbandona il comando) e la xum1541 viene poi riaperta da recover(). */
XP.guard = function (start, what) {
  var self = this;
  if (self.dirty) return Promise.reject(self.dirty);
  return new Promise(function (res, rej) {
    var done = false, ms = Math.max(self.watchdog, self.slowUntil - Date.now() + 5000), pend;
    function fin(f, v) { if (done) return; done = true; clearTimeout(pend.timer); if (self.pending === pend) self.pending = null; f(v); }
    pend = self.pending = {what: what, t0: Date.now(), fail: function (e) { fin(rej, e); }};
    pend.timer = setTimeout(function () { self.unstick(stuckError()); }, ms);
    start().then(function (v) { fin(res, v); }, function (e) { fin(rej, self.dirty || e); });
  });
};
function stuckError() { var e = new Error(tr('noBus')); e.noBus = true; return e; }
function abortError() { var e = new Error(tr('aborted')); e.aborted = true; return e; }
XP.abortError = abortError;
XP.unstick = async function (err) {
  var pend = this.pending;
  if (!pend || this.dirty) return;
  this.dirty = err;
  this.log('err', (err.aborted ? 'interrotto' : 'nessuna risposta dal bus') + ' durante ' + pend.what + ': RESET della xum1541');
  try { await this.ctrlOut(X.RESET, 2500); } catch (e) {}
  for (var i = 0; i < 10 && this.pending === pend; i++) await sleep(100);
  pend.fail(err); // se il trasferimento è ancora appeso lo abbandoniamo: recover() chiude il dispositivo
};
// dopo uno sblocco: chiude e riapre la xum1541 (la chiusura annulla i trasferimenti rimasti appesi)
XP.recover = async function () {
  if (!this.dirty) return;
  this.log('usb', 'riapro la xum1541');
  try { await this.dev.releaseInterface(X.IFACE); } catch (e) {}
  try { await this.dev.close(); } catch (e) {}
  this.pending = null; this.dirty = null; this.cancel = false;
  await this.open();
};
XP.bulkOut = function (data) {
  var self = this;
  return this.guard(function () { return self.dev.transferOut(X.EP_OUT, data); }, 'OUT').then(function (r) {
    if (r.status === 'stall') return self.dev.clearHalt('out', X.EP_OUT).then(function () { throw new Error('USB: endpoint OUT in stallo'); });
    if (r.status !== 'ok') throw new Error('USB OUT: ' + r.status);
    return r.bytesWritten;
  });
};
XP.bulkIn = function (len) {
  var self = this;
  return this.guard(function () { return self.dev.transferIn(X.EP_IN, len); }, 'IN').then(function (r) {
    if (r.status === 'stall') return self.dev.clearHalt('in', X.EP_IN).then(function () { throw new Error('USB: endpoint IN in stallo'); });
    if (r.status !== 'ok' && r.status !== 'babble') throw new Error('USB IN: ' + r.status);
    return r.data ? u8(r.data) : new Uint8Array(0);
  });
};
XP.open = async function () {
  var d = this.dev;
  if (!d.opened) await d.open();
  if (!d.configuration || d.configuration.configurationValue !== 1) await d.selectConfiguration(1);
  await d.claimInterface(X.IFACE);
  try { await d.selectAlternateInterface(X.IFACE, 0); } catch (e) { /* alcuni sistemi lo rifiutano se è già 0 */ }
  var info = await this.ctrlIn(X.INIT, 8);
  if (info.length < 2) throw new Error('La xum1541 non ha risposto a INIT');
  this.version = info[0]; this.caps = info[1]; this.status = info[2] || 0;
  this.log('usb', 'INIT → firmware v' + this.version + ', capacità 0x' + this.caps.toString(16) + ', stato 0x' + this.status.toString(16));
  if (this.version < X.MIN_VERSION) throw new Error('Firmware xum1541 troppo vecchio (v' + this.version + '): serve almeno la v' + X.MIN_VERSION + '.');
  if (this.status & X.DOING_RESET) {
    this.log('usb', 'la sessione precedente era stata interrotta: clear halt sugli endpoint');
    await d.clearHalt('in', X.EP_IN); await d.clearHalt('out', X.EP_OUT);
  }
  if (this.version >= 8) {
    try { var g = await this.ctrlIn(X.GITREV, 8); this.gitrev = String.fromCharCode.apply(null, g).replace(/\0.*$/, ''); } catch (e) {}
  }
};
XP.close = async function () {
  try { await this.ctrlOut(X.SHUTDOWN, 1000); } catch (e) {}
  try { await this.dev.releaseInterface(X.IFACE); } catch (e) {}
  try { await this.dev.close(); } catch (e) {}
};
XP.waitStatus = async function () {
  var t0 = Date.now();
  for (;;) {
    var s = await this.bulkIn(3);
    if (s.length !== 3) throw new Error('USB: stato di ' + s.length + ' byte');
    if (s[0] === X.BUSY) {
      // il firmware dice "occupato" senza fine: stesso trattamento di un trasferimento bloccato
      if (this.cancel || Date.now() - t0 > Math.max(this.watchdog, this.slowUntil - t0 + 5000)) {
        this.dirty = this.cancel ? abortError() : stuckError();
        try { await this.ctrlOut(X.RESET, 2500); } catch (e) {}
        throw this.dirty;
      }
      continue;
    }
    if (s[0] === X.READY) return s[1] | (s[2] << 8);
    if (s[0] === X.ERROR) return -1;
    throw new Error('USB: stato sconosciuto ' + s[0]);
  }
};
XP.ioctl = async function (cmd, addr, sec) {
  await this.bulkOut(new Uint8Array([cmd, addr || 0, sec || 0, 0]));
  return this.waitStatus();
};
// xum1541_write: restituisce i byte scritti sul bus (0 = nessun drive ha risposto)
XP.write = async function (mode, data) {
  var len = data.length;
  if (len > 0xFFFF) throw new Error('write: massimo 65535 byte per comando');
  await this.bulkOut(new Uint8Array([X.WRITE, mode, len & 255, len >> 8]));
  for (var p = 0; p < len; p += X.MAX_XFER) {
    var n = await this.bulkOut(data.subarray(p, Math.min(len, p + X.MAX_XFER)));
    if (n < Math.min(X.MAX_XFER, len - p)) break;
  }
  return (mode & 0xF0) === X.CBM ? this.waitStatus() : len;
};
// xum1541_read: legge fino a len byte; meno byte = EOI o timeout del bus
XP.read = async function (mode, len) {
  if (len > 0xFFFF) throw new Error('read: massimo 65535 byte per comando');
  await this.bulkOut(new Uint8Array([X.READ, mode, len & 255, len >> 8]));
  var parts = [], got = 0;
  while (got < len) {
    var want = Math.min(X.MAX_XFER, len - got), d = await this.bulkIn(want);
    parts.push(d); got += d.length;
    if (d.length < want) break;
  }
  return concat(parts);
};
XP.reset = function () { return this.ctrlOut(X.RESET, 4000); };
RF.Xum1541 = Xum1541;

/* ======================= cbm_* (come OpenCBM) ======================= */
function Cbm(xum, log) {
  this.x = xum; this.log = log || xum.log; this.queue = Promise.resolve(); this.abort = false;
}
var CP = Cbm.prototype;
// tutte le operazioni passano da qui, una alla volta (WebUSB è asincrono)
CP.exclusive = function (fn) {
  var run = this.queue.then(fn, fn);
  this.queue = run.catch(function () {});
  return run;
};
CP.atn = async function (bytes, talk) {
  var n = await this.x.write(X.CBM | X.F_ATN | (talk ? X.F_TALK : 0), new Uint8Array(bytes));
  return n > 0 ? 0 : 1; // come OpenCBM: 0 = riuscito
};
CP.listen = function (dev, sa) { this.log('bus', 'LISTEN ' + dev + ',' + sa); return this.atn([0x20 | dev, 0x60 | sa]); };
CP.talk = function (dev, sa) { this.log('bus', 'TALK ' + dev + ',' + sa); return this.atn([0x40 | dev, 0x60 | sa], true); };
CP.unlisten = function () { this.log('bus', 'UNLISTEN'); return this.atn([0x3F]); };
CP.untalk = function () { this.log('bus', 'UNTALK'); return this.atn([0x5F]); };
CP.rawWrite = function (data) { return this.x.write(X.CBM, data instanceof Uint8Array ? data : new Uint8Array(data)); };
CP.rawRead = function (len) { return this.x.read(X.CBM, len); };
CP.getEoi = function () { return this.x.ioctl(X.GET_EOI).then(function (v) { return v === 1; }); };
CP.clearEoi = function () { return this.x.ioctl(X.CLEAR_EOI); };
CP.reset = function () { this.log('bus', 'RESET del bus IEC'); return this.x.reset(); };
// cbm_open: OPEN sa + nome del file + UNLISTEN
CP.open = async function (dev, sa, name) {
  this.log('bus', 'OPEN ' + dev + ',' + sa + (name && name.length ? ',"' + RF.pet.toStr(name) + '"' : ''));
  if (await this.atn([0x20 | dev, 0xF0 | sa])) return 1;
  var rv = 0;
  if (name && name.length) {
    rv = (await this.rawWrite(name)) !== name.length ? 1 : 0;
  }
  await this.unlisten();
  return rv;
};
CP.close = async function (dev, sa) {
  this.log('bus', 'CLOSE ' + dev + ',' + sa);
  var rv = await this.atn([0x20 | dev, 0xE0 | sa]);
  await this.unlisten();
  return rv;
};
// cbm_exec_command: LISTEN dev,15 + comando + UNLISTEN
CP.execCommand = async function (dev, cmd) {
  var bytes = typeof cmd === 'string' ? RF.pet.fromStr(cmd) : cmd;
  this.log('cmd', '"' + RF.pet.toStr(bytes) + '"');
  var rv = await this.listen(dev, 15);
  if (rv === 0) rv = (await this.rawWrite(bytes)) !== bytes.length ? 1 : 0;
  await this.unlisten();
  return rv;
};
// cbm_device_status: TALK dev,15 + lettura fino al CR + UNTALK. Riprova finché il drive è occupato.
CP.deviceStatus = async function (dev, waitMs) {
  var deadline = Date.now() + (waitMs || 4000), buf = [];
  this.x.slowUntil = waitMs > 8000 ? deadline : 0; // formattazione, validazione: il drive può tacere a lungo
  try {
  if (await this.talk(dev, 15)) { await this.untalk(); return parseStatus(null); }
  for (;;) {
    var d = await this.rawRead(64);
    for (var i = 0; i < d.length; i++) buf.push(d[i]);
    if (buf.indexOf(13) >= 0) break;
    if (d.length < 64) { if (await this.getEoi()) break; }
    if (d.length === 0 && Date.now() > deadline) break;
    if (this.abort || buf.length > 200) break;
  }
  await this.untalk();
  } finally { this.x.slowUntil = 0; }
  var st = parseStatus(buf);
  this.log('st', st.text);
  return st;
};
function parseStatus(buf) {
  if (!buf || !buf.length) return {code: 99, msg: 'DRIVER ERROR', t: 0, s: 0, text: '99, DRIVER ERROR,00,00', none: true};
  var cr = buf.indexOf(13), s = String.fromCharCode.apply(null, cr >= 0 ? buf.slice(0, cr) : buf);
  var m = /^\s*(\d+)\s*,\s*([^,]*?)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (!m) return {code: parseInt(s, 10) || 99, msg: s, t: 0, s: 0, text: s};
  return {code: +m[1], msg: m[2], t: +m[3], s: +m[4], text: s};
}
Cbm.parseStatus = parseStatus;
RF.Cbm = Cbm;

/* ======================= operazioni ad alto livello ======================= */
function DriveError(st, what) {
  var e = new Error((what ? what + ': ' : '') + st.text);
  e.status = st; return e;
}
function Drive(cbm, dev) { this.cbm = cbm; this.dev = dev || 8; this.model = ''; this.dosText = ''; }
var DP = Drive.prototype;
DP.run = function (fn) {
  var self = this, c = self.cbm;
  return c.exclusive(async function () {
    c.abort = false; c.x.cancel = false;
    try { return await fn.call(self, c); }
    catch (e) {
      var why = c.x.dirty;
      if (why) { try { await c.x.recover(); } catch (r) { self.lost = true; c.log('err', 'xum1541 non riaperta: ' + (r.message || r)); } throw why; }
      throw e;
    }
  });
};
// "Interrompi": ferma l'operazione al prossimo blocco; se la xum1541 è ferma sul bus da più di un secondo la sblocca
Cbm.prototype.stop = function () {
  var x = this.x, pend = x.pending;
  this.abort = true; x.cancel = true;
  if (!pend) return;
  setTimeout(function () { if (x.pending === pend) x.unstick(abortError()); }, Math.max(0, 1200 - (Date.now() - pend.t0)));
};
DP.status = function (waitMs) { var self = this; return this.run(function (c) { return c.deviceStatus(self.dev, waitMs); }); };
// comando DOS libero con lettura dello stato (waitMs: quanto aspettare un drive occupato)
DP.command = function (cmd, waitMs) {
  var self = this;
  return this.run(async function (c) {
    if (await c.execCommand(self.dev, cmd)) throw DriveError({code: 99, text: tr('notPresent', self.dev)});
    return c.deviceStatus(self.dev, waitMs || 4000);
  });
};
function tr(k, a) { return (RF.msg && RF.msg(k, a)) || k; }
function checkSt(st, what) { if (st.code >= 20 && st.code !== 73) throw DriveError(st, what); return st; }
DP.identify = function () {
  var self = this;
  return this.run(async function (c) {
    if (await c.execCommand(self.dev, 'UJ')) throw DriveError({code: 99, text: tr('notPresent', self.dev)});
    await sleep(c.x.simulated ? 50 : 2200);
    var st = await c.deviceStatus(self.dev, 6000);
    self.setModel(st);
    return st;
  });
};
DP.setModel = function (st) {
  if (st.code !== 73) return;
  this.dosText = st.msg;
  var m = /(1541|1570|1571|1581|2031|4040|8050|8250|1001)/.exec(st.msg);
  this.model = m ? m[1] : '';
};
DP.geometry = function () { return this.model === '1581' ? 'd81' : this.model === '1571' ? 'd71' : 'd64'; };

// LOAD"$",8: directory come programma BASIC, poi decodificata
DP.directory = function (onProgress) {
  var self = this;
  return this.run(async function (c) {
    var raw = await self._readFile(c, 0, RF.pet.fromStr('$'), onProgress);
    var dir = RF.parseDirProgram(raw);
    dir.raw = raw;
    return dir;
  });
};
// lettura di un file intero da un canale già scelto (sa 0 = LOAD, 2 = file con tipo)
DP._readFile = async function (c, sa, name, onProgress, sizeHint) {
  var dev = this.dev;
  if (await c.open(dev, sa, name)) throw DriveError({code: 99, text: tr('notPresent', dev)});
  var st = await c.deviceStatus(dev, 8000);
  if (st.code >= 20) { await c.close(dev, sa); throw DriveError(st); }
  var parts = [], got = 0, idle = 0, t0 = Date.now();
  if (await c.talk(dev, sa)) { await c.close(dev, sa); throw DriveError({code: 99, text: tr('notPresent', dev)}); }
  for (;;) {
    if (c.abort) { await c.untalk(); await c.close(dev, sa); throw new Error(tr('aborted')); }
    var d = await c.rawRead(254);
    if (d.length) { parts.push(d); got += d.length; idle = 0; if (onProgress) onProgress(got, sizeHint || 0, Date.now() - t0); }
    if (d.length < 254) {
      if (await c.getEoi()) break;
      if (d.length === 0 && ++idle > 8) break; // nessun dato per ~8 s: il drive non risponde
    }
  }
  await c.untalk();
  await c.close(dev, sa);
  var data = concat(parts);
  if (!got) { var st2 = await c.deviceStatus(dev); if (st2.code >= 20) throw DriveError(st2); }
  return data;
};
DP.readFile = function (nameBytes, typeName, onProgress, sizeHint) {
  var self = this, t = (typeName || 'PRG')[0];
  return this.run(function (c) {
    var name = nameBytes.concat(RF.pet.fromStr(',' + t + ',R'));
    return self._readFile(c, 2, name, onProgress, sizeHint);
  });
};
// scrittura di un file (SEQ/PRG/USR) sul canale 2, a pezzi per mostrare l'avanzamento
DP.writeFile = function (nameBytes, data, typeName, opts, onProgress) {
  var self = this;
  return this.run(function (c) { return self._writeFile(c, nameBytes, data, typeName, opts, onProgress); });
};
DP._writeFile = async function (c, nameBytes, data, typeName, opts, onProgress) {
  var t = (typeName || 'PRG')[0], dev = this.dev;
  opts = opts || {};
  {
    if (opts.replace) {
      await c.execCommand(dev, RF.pet.fromStr('S0:').concat(nameBytes));
      await c.deviceStatus(dev, 8000);
    }
    var name = RF.pet.fromStr('0:').concat(nameBytes, RF.pet.fromStr(',' + t + ',W'));
    if (await c.open(dev, 2, name)) throw DriveError({code: 99, text: tr('notPresent', dev)});
    var st = await c.deviceStatus(dev, 8000);
    if (st.code >= 20) { await c.close(dev, 2); throw DriveError(st); }
    var t0 = Date.now();
    if (await c.listen(dev, 2)) throw DriveError({code: 99, text: tr('notPresent', dev)});
    for (var p = 0; p < data.length; p += 254) {
      if (c.abort) { await c.unlisten(); await c.close(dev, 2); throw new Error(tr('aborted')); }
      var chunk = data.subarray(p, Math.min(data.length, p + 254));
      var n = await c.rawWrite(chunk);
      if (n !== chunk.length) { await c.unlisten(); await c.close(dev, 2); throw DriveError(await c.deviceStatus(dev)); }
      if (onProgress) onProgress(p + chunk.length, data.length, Date.now() - t0);
    }
    await c.unlisten();
    await c.close(dev, 2);
    return checkSt(await c.deviceStatus(dev, 8000));
  }
};
function nm(bytes) { return Array.isArray(bytes) ? bytes : Array.prototype.slice.call(bytes); }
DP.scratch = function (nameBytes) {
  return this.command(RF.pet.fromStr('S0:').concat(nm(nameBytes)), 15000).then(function (st) { return checkSt(st); });
};
DP.rename = function (oldBytes, newBytes) {
  return this.command(RF.pet.fromStr('R0:').concat(nm(newBytes), [0x3D], nm(oldBytes)), 8000).then(function (st) { return checkSt(st); });
};
DP.validate = function () { return this.command('V0', 120000).then(function (st) { return checkSt(st); }); };
DP.initialize = function () { return this.command('I0', 8000); };
// N:nome,id (completa, scrive ogni traccia) oppure N:nome (rapida, solo su dischi già formattati)
DP.format = function (nameBytes, idBytes) {
  var cmd = RF.pet.fromStr('N0:').concat(nm(nameBytes));
  if (idBytes && idBytes.length) cmd = cmd.concat([0x2C], nm(idBytes));
  return this.command(cmd, 240000).then(function (st) { return checkSt(st); });
};

/* ---------- blocchi (U1 / U2 / B-P) e dischi interi ---------- */
DP._blockOpen = async function (c) {
  if (await c.open(this.dev, 2, [0x23])) throw DriveError({code: 99, text: tr('notPresent', this.dev)});
  checkSt(await c.deviceStatus(this.dev));
};
DP._blockRead = async function (c, t, s) {
  var dev = this.dev;
  await c.execCommand(dev, 'U1:2 0 ' + t + ' ' + s);
  var st = await c.deviceStatus(dev, 8000);
  if (st.code >= 20) return {st: st, data: null};
  await c.execCommand(dev, 'B-P:2 0');
  await c.talk(dev, 2);
  var d = await c.rawRead(256);
  await c.untalk();
  return {st: st, data: d.length === 256 ? d : null};
};
DP._blockWrite = async function (c, t, s, data) {
  var dev = this.dev;
  await c.execCommand(dev, 'B-P:2 0');
  await c.listen(dev, 2);
  var n = await c.rawWrite(data);
  await c.unlisten();
  if (n !== 256) return checkSt(await c.deviceStatus(dev));
  await c.execCommand(dev, 'U2:2 0 ' + t + ' ' + s);
  return c.deviceStatus(dev, 8000);
};
DP.readBlock = function (t, s) {
  var self = this;
  return this.run(async function (c) {
    await self._blockOpen(c);
    try { var r = await self._blockRead(c, t, s); checkSt(r.st); return r.data; }
    finally { await c.close(self.dev, 2); }
  });
};
// copia del disco intero in un'immagine (blocco per blocco, bus standard: lento)
DP.readDisk = function (fmtId, onProgress) {
  var self = this;
  return this.run(async function (c) {
    var img = RF.Disk.blank(fmtId, RF.pet.fromStr('LETTURA'), RF.pet.fromStr('00'));
    var total = img.sectors, done = 0, errors = [], t0 = Date.now();
    await self._blockOpen(c);
    try {
      for (var t = 1; t <= img.tracks; t++) {
        for (var s = 0; s < img.spt(t); s++) {
          if (c.abort) throw new Error(tr('aborted'));
          var r = await self._blockRead(c, t, s);
          if (r.data) img.writeBlock(t, s, r.data); else { img.block(t, s).fill(0); errors.push({t: t, s: s, st: r.st}); }
          done++;
          if (onProgress) onProgress(done, total, Date.now() - t0, t, s);
        }
      }
    } finally { await c.close(self.dev, 2); }
    img.readErrors = errors;
    return img;
  });
};
// scrittura di un'immagine sul disco: formatta con lo stesso nome e ID, poi scrive i blocchi (solo quelli usati, se richiesto)
DP.writeDisk = function (img, opts, onProgress) {
  var self = this;
  opts = opts || {};
  return this.run(async function (c) {
    var h = img.headerInfo(), dev = self.dev, t0 = Date.now(), list = [], t, s;
    if (opts.format !== false) {
      if (onProgress) onProgress(0, 1, 0, 0, 0, 'format');
      await c.execCommand(dev, RF.pet.fromStr('N0:').concat(h.name.length ? h.name : RF.pet.fromStr('DISCO'), [0x2C], h.id));
      checkSt(await c.deviceStatus(dev, 240000), 'N');
    }
    for (t = 1; t <= img.tracks; t++) for (s = 0; s < img.spt(t); s++) {
      if (opts.usedOnly === false || t > img.dosTracks() || img.isReserved(t) || !img.isFree(t, s)) list.push([t, s]);
    }
    await self._blockOpen(c);
    try {
      for (var i = 0; i < list.length; i++) {
        if (c.abort) throw new Error(tr('aborted'));
        var st = await self._blockWrite(c, list[i][0], list[i][1], img.readBlock(list[i][0], list[i][1]));
        checkSt(st, 'U2 ' + list[i][0] + '/' + list[i][1]);
        if (onProgress) onProgress(i + 1, list.length, Date.now() - t0, list[i][0], list[i][1]);
      }
    } finally { await c.close(dev, 2); }
    await c.execCommand(dev, 'I0'); await c.deviceStatus(dev);
    return list.length;
  });
};
/* ---------- separatori nella directory (file DEL da 0 blocchi) ----------
 * Il DOS non ha un comando per creare file DEL: si scrive la voce direttamente nel blocco della directory (U1 / U2).
 * La voce punta al primo blocco della directory, che è già occupato: un "V" (validate) non cambia niente.
 * Con "locked" (DEL<) il DOS non la cancella con S:, che altrimenti libererebbe i blocchi della directory.
 */
DP._dirStart = async function (c) {
  if (this.model === '1581') return [40, 3];
  if (this.model) return [18, 1];
  var r = await this._blockRead(c, 18, 0);
  if (r.data && r.data[2] === 0x41) return [18, 1];
  r = await this._blockRead(c, 40, 0);
  if (r.data && r.data[2] === 0x44) return [40, 3];
  throw DriveError({code: 74, text: tr('noDosDisk')});
};
DP._dirSlots = async function (c, start) {
  var out = [], t = start[0], s = start[1], seen = {};
  while (t && !seen[t + ':' + s] && out.length < 40) {
    seen[t + ':' + s] = 1;
    var r = await this._blockRead(c, t, s);
    checkSt(r.st);
    if (!r.data) throw DriveError(r.st);
    out.push({t: t, s: s, data: r.data});
    t = r.data[0]; s = r.data[1];
  }
  return out;
};
function padName(bytes) { var a = new Array(16).fill(0xA0); for (var i = 0; i < 16 && i < bytes.length; i++) a[i] = bytes[i]; return a; }
DP.addSeparator = function (nameBytes, locked) {
  var self = this, dev = this.dev;
  return this.run(async function (c) {
    await self._blockOpen(c);
    var start = await self._dirStart(c), secs = await self._dirSlots(c, start), slot = null;
    function find() {
      for (var k = 0; k < secs.length && !slot; k++) for (var i = 0; i < 8; i++) if (secs[k].data[i * 32 + 2] === 0) { slot = {sec: secs[k], o: i * 32}; break; }
    }
    find();
    if (!slot) {
      // directory piena: un file temporaneo fa allungare la directory al DOS, poi lo cancelliamo e resta la voce libera
      await c.close(dev, 2);
      var tmp = RF.pet.fromStr('RF-SEP-TMP');
      await self._writeFile(c, tmp, new Uint8Array([1, 8, 0, 0]), 'PRG', {});
      await c.execCommand(dev, RF.pet.fromStr('S0:').concat(tmp)); checkSt(await c.deviceStatus(dev, 8000));
      await self._blockOpen(c);
      secs = await self._dirSlots(c, start); find();
      if (!slot) throw DriveError({code: 72, text: '72,DISK FULL,00,00'});
    }
    try {
      var d = slot.sec.data, o = slot.o;
      for (var j = 2; j < 32; j++) d[o + j] = 0;
      d[o + 2] = locked ? 0xC0 : 0x80; d[o + 3] = start[0]; d[o + 4] = start[1];
      d.set(padName(nameBytes), o + 5);
      checkSt(await self._blockWrite(c, slot.sec.t, slot.sec.s, d), 'U2');
    } finally { await c.close(dev, 2); }
    await c.execCommand(dev, 'I0');
    return checkSt(await c.deviceStatus(dev, 8000));
  });
};
// toglie una voce DEL dalla directory senza liberare blocchi (S: libererebbe la catena a cui punta)
DP.removeDel = function (nameBytes) {
  var self = this, dev = this.dev;
  return this.run(async function (c) {
    await self._blockOpen(c);
    try {
      var secs = await self._dirSlots(c, await self._dirStart(c));
      for (var k = 0; k < secs.length; k++) for (var i = 0; i < 8; i++) {
        var d = secs[k].data, o = i * 32;
        if (d[o + 2] === 0 || (d[o + 2] & 7) !== 0) continue;
        var n = Array.prototype.slice.call(d, o + 5, o + 21);
        while (n.length && n[n.length - 1] === 0xA0) n.pop();
        if (!RF.pet.eq(n, nm(nameBytes))) continue;
        d[o + 2] = 0;
        checkSt(await self._blockWrite(c, secs[k].t, secs[k].s, d), 'U2');
        await c.close(dev, 2);
        await c.execCommand(dev, 'I0');
        return checkSt(await c.deviceStatus(dev, 8000));
      }
    } catch (e) { await c.close(dev, 2); throw e; }
    await c.close(dev, 2);
    throw DriveError({code: 62, text: '62,FILE NOT FOUND,00,00'});
  });
};
RF.Drive = Drive;
})(window.RFFloppy = window.RFFloppy || {});
