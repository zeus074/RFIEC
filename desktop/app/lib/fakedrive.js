/* copiato da floppy-web/src/fakedrive.js da build.py: non modificare qui */
/* RetroFixer · Floppy C64 · xum1541 e drive simulati
 * FakeXum1541: imita un USBDevice di WebUSB con il firmware della xum1541 (comandi di controllo, READ, WRITE, IOCTL, stato).
 * FakeDrive:   un drive 1541 / 1571 / 1581 sul bus IEC (LISTEN, TALK, OPEN, CLOSE, canale 15, LOAD"$", file, blocchi) con un disco in memoria.
 * Così tutto il codice di cbm.js gira identico a quando c'è l'hardware vero: cambia solo l'oggetto "device".
 */
(function (RF) {
'use strict';
var X = RF.XUM, pet = RF.pet;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function dv(bytes) { var a = new Uint8Array(bytes); return new DataView(a.buffer); }

var DOS = {
  '1541': {msg: 'CBM DOS V2.6 1541', fmt: 'd64'},
  '1571': {msg: 'CBM DOS V3.0 1571', fmt: 'd71'},
  '1581': {msg: 'COPYRIGHT CBM DOS V10 1581', fmt: 'd81'}
};
// tempi del drive in modalità "realistica" (millisecondi): stime, da confrontare con l'hardware vero
var REAL = {byteMs: 1000 / 450, fmtFull: {'1541': 80000, '1571': 75000, '1581': 45000}, fmtQuick: 3000, validate: 12000, scratch: 900, block: 120, open: 250, reset: 1600};

/* ======================= drive sul bus IEC ======================= */
function FakeDrive(opts) {
  opts = opts || {};
  this.model = opts.model || '1541';
  this.dev = opts.dev || 8;
  this.speed = opts.speed || 'instant';
  this.writeProtect = !!opts.writeProtect;
  this.disk = opts.disk || null;
  this.powered = true;
  this.onChange = opts.onChange || function () {};
  this.onLed = opts.onLed || function () {};
  this.reset(true);
}
var F = FakeDrive.prototype;
F.reset = function (power) {
  this.listening = false; this.talking = false; this.sa = 0; this.mode = null; this.nameBuf = [];
  this.cmdBuf = []; this.channels = {}; this.busyUntil = 0;
  this.setError(73, DOS[this.model].msg, 0, 0);
  if (!power) this.busy(REAL.reset, true);
};
F.setModel = function (m) { this.model = m; this.reset(true); };
F.insert = function (disk) { this.disk = disk; this.channels = {}; this.setError(0, ' OK', 0, 0); this.onChange(); };
F.eject = function () { this.disk = null; this.channels = {}; this.onChange(); };
F.setError = function (code, msg, t, s) {
  var txt = String(code).padStart(2, '0') + ',' + msg + ',' + String(t || 0).padStart(2, '0') + ',' + String(s || 0).padStart(2, '0');
  this.err = {code: code, bytes: pet.fromStr(txt).concat([13]), pos: 0};
};
F.ok = function () { this.setError(0, ' OK', 0, 0); };
F.fail = function (e) {
  if (e && e.code) this.setError(e.code, e.code === 1 ? 'FILES SCRATCHED' : e.message, e.t, e.s);
  else this.setError(99, 'DRIVER ERROR', 0, 0);
};
// visible: in modalità istantanea le operazioni lunghe (formattazione, validazione, reset) durano comunque un attimo, per vedere il LED
F.busy = function (ms, visible) {
  var d = this.speed === 'real' ? ms : (visible ? 400 : 0);
  if (!d) return;
  this.busyUntil = Math.max(this.busyUntil, Date.now() + d); this.onLed(true);
};
F.isBusy = function () { var b = Date.now() < this.busyUntil; if (!b) this.onLed(false); return b; };
F.needDisk = function () { if (!this.disk) throw RF.DiskError(74, 'DRIVE NOT READY'); };
F.needWrite = function () { this.needDisk(); if (this.writeProtect) throw RF.DiskError(26, 'WRITE PROTECT ON'); };

// byte sotto ATN: restituisce quanti byte sono stati accettati
F.atn = function (bytes) {
  if (!this.powered) return 0;
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i], cmd = b & 0xE0, arg = b & 0x1F;
    if (b === 0x3F) { if (this.listening) this.endListen(); this.listening = false; }
    else if (b === 0x5F) { this.talking = false; }
    else if (cmd === 0x20) { this.listening = arg === this.dev; this.talking = false; this.mode = null; }
    else if (cmd === 0x40) { this.talking = arg === this.dev; if (this.talking) this.listening = false; this.mode = null; }
    else if ((b & 0xF0) === 0x60) { this.sa = b & 0x0F; this.mode = 'data'; if (this.sa === 15 && this.listening) this.cmdBuf = []; }
    else if ((b & 0xF0) === 0xE0) { if (this.listening) this.closeCh(b & 0x0F); this.mode = null; }
    else if ((b & 0xF0) === 0xF0) { if (this.listening) { this.sa = b & 0x0F; this.mode = 'open'; this.nameBuf = []; } }
  }
  return bytes.length;
};
// byte di dati dal PC
F.write = function (bytes) {
  if (!this.powered || !this.listening) return 0;
  if (this.mode === 'open') { for (var i = 0; i < bytes.length; i++) this.nameBuf.push(bytes[i]); return bytes.length; }
  if (this.sa === 15) { for (var j = 0; j < bytes.length; j++) this.cmdBuf.push(bytes[j]); return bytes.length; }
  var ch = this.channels[this.sa];
  if (!ch || !ch.write) { this.setError(61, 'FILE NOT OPEN', 0, 0); return 0; }
  if (ch.buffer) { for (var k = 0; k < bytes.length; k++) { ch.data[ch.pos & 255] = bytes[k]; ch.pos = (ch.pos + 1) & 255; } }
  else for (var m = 0; m < bytes.length; m++) ch.out.push(bytes[m]);
  return bytes.length;
};
// lettura dal drive che parla: {data, eoi}; nessun dato = timeout del bus (come il firmware dopo 1 s)
F.read = function (len) {
  if (!this.powered || !this.talking) return {data: [], eoi: false};
  var out = [], eoi = false;
  if (this.sa === 15) {
    var e = this.err;
    while (out.length < len && e.pos < e.bytes.length) out.push(e.bytes[e.pos++]);
    if (e.pos >= e.bytes.length) { eoi = true; this.ok(); }
    return {data: out, eoi: eoi};
  }
  var ch = this.channels[this.sa];
  if (!ch || !ch.read) return {data: [], eoi: false};
  if (ch.buffer) {
    while (out.length < len) { out.push(ch.data[ch.pos & 255]); ch.pos = (ch.pos + 1) & 255; if (ch.pos === 0) { eoi = true; break; } }
  } else {
    while (out.length < len && ch.pos < ch.data.length) out.push(ch.data[ch.pos++]);
    if (ch.pos >= ch.data.length) eoi = true;
  }
  return {data: out, eoi: eoi};
};

F.endListen = function () {
  if (this.mode === 'open') { this.mode = null; this.doOpen(this.sa, this.nameBuf); }
  else if (this.sa === 15 && this.cmdBuf.length) { var c = this.cmdBuf; this.cmdBuf = []; this.doCommand(c); }
};

// nome con prefisso e opzioni: "@0:NOME,P,W"
function splitName(bytes) {
  var b = bytes.slice(), replace = false, type = 0, mode = '';
  while (b.length && b[b.length - 1] === 13) b.pop();
  if (b[0] === 0x40) { replace = true; b.shift(); }
  var colon = b.indexOf(0x3A);
  if (colon >= 0 && colon <= 2) b = b.slice(colon + 1);
  var parts = [], cur = [];
  b.forEach(function (x) { if (x === 0x2C) { parts.push(cur); cur = []; } else cur.push(x); });
  parts.push(cur);
  for (var i = 1; i < parts.length; i++) {
    var c = String.fromCharCode(parts[i][0] || 0);
    if ('SPUL'.indexOf(c) >= 0 && i === 1) type = {S: 1, P: 2, U: 3, L: 4}[c];
    else if ('RWAM'.indexOf(c) >= 0) mode = c;
  }
  return {name: parts[0], replace: replace, type: type, mode: mode};
}

F.doOpen = function (sa, nameBytes) {
  try {
    if (sa === 15) { if (nameBytes.length) this.doCommand(nameBytes); return; }
    this.busy(REAL.open);
    if (nameBytes[0] === 0x23) { // "#": buffer per i comandi di blocco
      this.channels[sa] = {buffer: true, read: true, write: true, data: new Uint8Array(256), pos: 0};
      this.ok(); return;
    }
    this.needDisk();
    if (nameBytes[0] === 0x24 && (sa === 0)) { // "$" o "$0:MODELLO"
      var c = nameBytes.indexOf(0x3A), pat = c >= 0 ? nameBytes.slice(c + 1) : [];
      this.channels[sa] = {read: true, data: this.disk.dirProgram(pat), pos: 0};
      this.ok(); return;
    }
    var p = splitName(nameBytes);
    if (!p.name.length) throw RF.DiskError(34, 'SYNTAX ERROR');
    var writing = sa === 1 || p.mode === 'W';
    if (writing) {
      this.needWrite();
      for (var i = 0; i < p.name.length; i++) if (p.name[i] === 0x2A || p.name[i] === 0x3F) throw RF.DiskError(33, 'SYNTAX ERROR');
      if (!p.replace && this.disk.findExact(p.name)) throw RF.DiskError(63, 'FILE EXISTS');
      this.channels[sa] = {write: true, out: [], name: p.name, type: p.type || 2, replace: p.replace};
      this.ok(); return;
    }
    var want = sa < 2 ? 2 : p.type;
    var e = this.disk.find(p.name, 0);
    if (!e) throw RF.DiskError(62, 'FILE NOT FOUND');
    if (want && e.type !== want) throw RF.DiskError(64, 'FILE TYPE MISMATCH');
    this.channels[sa] = {read: true, data: this.disk.readFile(e), pos: 0};
    this.ok();
  } catch (err) { this.fail(err); }
};
F.closeCh = function (sa) {
  var ch = this.channels[sa];
  delete this.channels[sa];
  if (!ch || !ch.write || ch.buffer) return;
  try {
    this.needWrite();
    this.disk.writeFile(ch.name, new Uint8Array(ch.out), ch.type, {replace: ch.replace});
    this.ok(); this.onChange();
  } catch (err) { this.fail(err); }
};

function asc(bytes) { return String.fromCharCode.apply(null, bytes); }
function nums(str) { return (str.match(/\d+/g) || []).map(Number); }
function splitNames(bytes) { var out = [], cur = []; bytes.forEach(function (b) { if (b === 0x2C) { out.push(cur); cur = []; } else cur.push(b); }); out.push(cur); return out.filter(function (x) { return x.length; }); }
function afterColon(bytes) { var i = bytes.indexOf(0x3A); return i >= 0 ? bytes.slice(i + 1) : bytes.slice(1); }

F.doCommand = function (raw) {
  var b = raw.slice();
  while (b.length && (b[b.length - 1] === 13 || b[b.length - 1] === 0x20)) b.pop();
  var s = asc(b), c0 = s[0], m;
  try {
    if (b.length > 58) throw RF.DiskError(32, 'SYNTAX ERROR');
    if (/^U[J:;I9]/.test(s) || /^UI/.test(s)) { this.reset(false); return; }
    if (/^(U1|UA|B-R)/.test(s)) { this.needDisk(); this.blockCmd(s, 'r'); return; }
    if (/^(U2|UB|B-W)/.test(s)) { this.needWrite(); this.blockCmd(s, 'w'); return; }
    if (/^B-P/.test(s)) { var n = nums(s.slice(3)), ch = this.channels[n[0]]; if (!ch || !ch.buffer) throw RF.DiskError(70, 'NO CHANNEL'); ch.pos = (n[1] || 0) & 255; this.ok(); return; }
    if (/^M-[RWE]/.test(s)) { this.ok(); return; }
    if (c0 === 'I') { this.needDisk(); this.ok(); return; }
    if (c0 === 'V') { this.needWrite(); this.busy(REAL.validate, true); this.disk.validate(); this.ok(); this.onChange(); return; }
    if (c0 === 'N') {
      this.needWrite();
      var parts = splitNames(afterColon(b)), name = parts[0] || [], id = parts[1];
      if (!name.length) throw RF.DiskError(34, 'SYNTAX ERROR');
      if (id && id.length) {
        if (!this.disk || this.disk.fmt.id !== DOS[this.model].fmt) this.disk = RF.Disk.blank(DOS[this.model].fmt, name, id);
        else this.disk.format(name, id);
        this.busy(REAL.fmtFull[this.model], true);
      } else {
        if (!this.disk) throw RF.DiskError(74, 'DRIVE NOT READY');
        this.disk.quickFormat(name);
        this.busy(REAL.fmtQuick, true);
      }
      this.ok(); this.onChange(); return;
    }
    if (c0 === 'S') {
      this.needWrite();
      var pats = splitNames(afterColon(b));
      if (!pats.length) throw RF.DiskError(34, 'SYNTAX ERROR');
      var k = this.disk.scratch(pats);
      this.busy(REAL.scratch * Math.max(1, k));
      this.setError(1, 'FILES SCRATCHED', k, 0); this.onChange(); return;
    }
    if (c0 === 'R') {
      this.needWrite();
      var rb = afterColon(b), eq = rb.indexOf(0x3D);
      if (eq < 0) throw RF.DiskError(34, 'SYNTAX ERROR');
      var oldB = rb.slice(eq + 1), ci = oldB.indexOf(0x3A); if (ci >= 0 && ci <= 1) oldB = oldB.slice(ci + 1);
      this.disk.rename(rb.slice(0, eq), oldB);
      this.busy(REAL.scratch); this.ok(); this.onChange(); return;
    }
    if (c0 === 'C') {
      this.needWrite();
      var cb = afterColon(b), ce = cb.indexOf(0x3D);
      if (ce < 0) throw RF.DiskError(34, 'SYNTAX ERROR');
      var srcs = splitNames(cb.slice(ce + 1)).map(function (x) { var i = x.indexOf(0x3A); return i >= 0 && i <= 1 ? x.slice(i + 1) : x; });
      if (this.disk.findExact(cb.slice(0, ce))) throw RF.DiskError(63, 'FILE EXISTS');
      this.disk.copyFile(cb.slice(0, ce), srcs); this.busy(REAL.validate / 2); this.ok(); this.onChange(); return;
    }
    throw RF.DiskError(31, 'SYNTAX ERROR');
  } catch (err) { this.fail(err); }
};
F.blockCmd = function (s, dir) {
  var n = nums(s.replace(/^(U1|U2|UA|UB|B-R|B-W)/, '')), ch = this.channels[n[0]];
  if (!ch || !ch.buffer) throw RF.DiskError(70, 'NO CHANNEL');
  var t = n[2], sec = n[3];
  if (!this.disk.valid(t, sec)) throw RF.DiskError(66, 'ILLEGAL TRACK OR SECTOR', t, sec);
  if (dir === 'r') { ch.data.set(this.disk.readBlock(t, sec)); ch.pos = 0; }
  else { this.disk.writeBlock(t, sec, ch.data); this.onChange(); }
  this.busy(REAL.block);
  this.ok();
};

/* ======================= xum1541 simulata (stessa interfaccia di un USBDevice) ======================= */
function FakeXum1541(drive, opts) {
  opts = opts || {};
  this.simulated = true;
  this.drive = drive;
  this.vendorId = X.VID; this.productId = X.PID;
  this.productName = 'xum1541 (simulata)'; this.manufacturerName = 'RetroFixer'; this.serialNumber = '0';
  this.opened = false; this.configuration = null; this.claimed = false;
  this.inQ = []; this.pending = null; this.eoi = false; this.halted = false;
  this.usbDelay = opts.usbDelay || 0;
  // noBus: imita il bus senza drive con le linee che restano basse: il firmware aspetta per sempre
  this.noBus = !!opts.noBus; this.resetFrees = opts.resetFrees !== false;
}
var U = FakeXum1541.prototype;
function result(status, data) { return {status: status, data: data ? dv(data) : new DataView(new ArrayBuffer(0)), bytesWritten: 0}; }
U.open = async function () { this.opened = true; };
U.close = async function () { this.opened = false; this.claimed = false; this.hung = false; };
U.selectConfiguration = async function (v) { this.configuration = {configurationValue: v}; };
U.claimInterface = async function (i) { if (!this.opened) throw new Error('device chiuso'); this.claimed = true; };
U.releaseInterface = async function () { this.claimed = false; };
U.selectAlternateInterface = async function () {};
U.clearHalt = async function () { this.halted = false; };
U.reset = async function () {};
U.controlTransferIn = async function (setup, len) {
  if (setup.requestType !== 'class') return result('stall');
  if (setup.request === X.INIT) return result('ok', [8, 0x03, 0, 0, 0, 0, 0, 0].slice(0, len));
  if (setup.request === X.ECHO) return result('ok', [0]);
  if (setup.request === X.GITREV) return result('ok', pet.fromStr('SIMULAT').concat([0]));
  return result('stall');
};
U.controlTransferOut = async function (setup) {
  if (setup.request === X.BOOTLOADER) { this.bootloader = true; this.opened = false; this.claimed = false; return {status: 'ok', bytesWritten: 0}; }
  if (setup.request === X.RESET && this.hung && this.resetFrees) { this.hung = false; this.inQ.push([X.ERROR, 0, 0]); return {status: 'ok', bytesWritten: 0}; }
  if (setup.request === X.RESET) { this.drive.reset(false); this.inQ = []; this.pending = null; await sleep(this.drive.speed === 'real' ? 800 : 20); }
  return {status: 'ok', bytesWritten: 0};
};
U.transferOut = async function (ep, data) {
  if (ep !== X.EP_OUT) return {status: 'stall', bytesWritten: 0};
  var b = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength) : data);
  if (this.usbDelay) await sleep(this.usbDelay);
  if (this.pending) {
    var p = this.pending;
    for (var i = 0; i < b.length; i++) p.buf.push(b[i]);
    if (p.buf.length >= p.len) { this.pending = null; await this.doWrite(p.flags, p.buf); }
    return {status: 'ok', bytesWritten: b.length};
  }
  if (b.length !== 4) return {status: 'stall', bytesWritten: 0};
  var cmd = b[0], len = b[2] | (b[3] << 8);
  if (cmd === X.WRITE) { if (len === 0) this.inQ.push([X.READY, 0, 0]); else this.pending = {flags: b[1], len: len, buf: []}; }
  else if (cmd === X.READ) await this.doRead(len);
  else if (cmd === X.GET_EOI) this.inQ.push([X.READY, this.eoi ? 1 : 0, 0]);
  else if (cmd === X.CLEAR_EOI) { this.eoi = false; this.inQ.push([X.READY, 0, 0]); }
  else if (cmd >= 16) this.inQ.push([X.READY, 0, 0]);
  else return {status: 'stall', bytesWritten: 0};
  return {status: 'ok', bytesWritten: 4};
};
U.doWrite = async function (flags, buf) {
  this.eoi = false; // come il firmware: ogni scrittura azzera EOI
  var n;
  if (this.noBus) { this.hung = true; return; }
  if (flags & X.F_ATN) n = this.drive.atn(buf);
  else {
    // un drive occupato (per esempio mentre formatta) accetta i dati solo quando ha finito
    while (this.drive.isBusy()) await sleep(Math.min(200, this.drive.busyUntil - Date.now() + 1));
    n = this.drive.write(buf);
    if (this.drive.speed === 'real') await sleep(buf.length * REAL.byteMs);
  }
  this.inQ.push([X.READY, n & 255, n >> 8]);
};
U.doRead = async function (len) {
  if (this.eoi) { this.inQ.push([]); return; }
  // il firmware aspetta al massimo 1 s che il drive inizi a parlare
  if (this.drive.isBusy()) {
    var wait = Math.min(1000, this.drive.busyUntil - Date.now());
    await sleep(Math.max(0, wait));
    if (this.drive.isBusy()) { this.inQ.push([]); return; }
  }
  var r = this.drive.read(len);
  if (r.eoi) this.eoi = true;
  if (this.drive.speed === 'real' && r.data.length) await sleep(r.data.length * REAL.byteMs);
  this.inQ.push(r.data);
};
U.transferIn = async function (ep, len) {
  if (ep !== X.EP_IN) return result('stall');
  if (this.usbDelay) await sleep(this.usbDelay);
  var guard = 0;
  while (!this.inQ.length) {
    if (!this.opened) { var e = new Error('The transfer was cancelled.'); e.name = 'AbortError'; throw e; }
    await sleep(5);
    if (!this.hung && ++guard > 2000) return result('stall');
  }
  var d = this.inQ[0];
  if (d.length > len) { this.inQ[0] = d.slice(len); d = d.slice(0, len); }
  else this.inQ.shift();
  return result('ok', d);
};

/* ======================= disco dimostrativo ======================= */
function demoDisk(fmtId) {
  var P = pet.fromStr, d = RF.Disk.blank(fmtId || 'd64', P('RETROFIXER DEMO'), P('RF'));
  d.writeFile(P('CIAO RETROFIXER'), RF.basicTokenize([
    '10 PRINT CHR$(147)"CIAO DA RETROFIXER.IT!"',
    '20 FOR I=1 TO 15:POKE 53280,I:POKE 53281,I-1',
    '30 FOR J=1 TO 150:NEXT J,I',
    '40 POKE 53280,14:POKE 53281,6',
    '50 PRINT "QUESTO FILE ARRIVA DAL DRIVE SIMULATO."'
  ]), 2);
  var music = new Uint8Array(4098); music[0] = 0x00; music[1] = 0x10;
  for (var i = 2; i < music.length; i++) music[i] = (i * 37 + (i >> 5)) & 255;
  d.writeFile(P('MUSICA SID'), music, 2);
  d.writeFile(P('TESTO NOTE'), new Uint8Array(P('APPUNTI DI PROVA SU UN FILE SEQUENZIALE.\rSECONDA RIGA.\r')), 1);
  var big = new Uint8Array(30 * 254); big[0] = 0x01; big[1] = 0x08;
  for (var k = 2; k < big.length; k++) big[k] = (k * 13) & 255;
  d.writeFile(P('GIOCO GRANDE'), big, 2);
  d.addSeparator(P('----------------'), true);
  return d;
}

RF.FakeDrive = FakeDrive;
RF.FakeXum1541 = FakeXum1541;
RF.demoDisk = demoDisk;
RF.DOS_MODELS = DOS;
RF.SIM_TIMING = REAL;
})(window.RFFloppy = window.RFFloppy || {});
