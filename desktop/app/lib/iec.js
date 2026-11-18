/* copiato da floppy-web/src/iec.js da build.py: non modificare qui */
/* RetroFixer · Floppy C64 · il PC fa da drive per il C64 (firmware RFIEC sul Pro Micro)
 * SerialLink: porta seriale USB con Web Serial (Chrome, Edge).
 * IecHost:    traduce gli eventi del bus che arrivano dal firmware (LISTEN, TALK, dati…) in chiamate al drive
 *             simulato di fakedrive.js, che fa da DOS, e rimanda al C64 i dati da leggere.
 * Avr109:     programma il Pro Micro attraverso il suo bootloader (Caterina), per passare da RFIEC a XUM1541 e viceversa.
 * FakeRfiec / FakeCaterina: doppioni del firmware e del bootloader per provare tutto senza hardware.
 * Il protocollo del firmware è descritto in firmware/iec-device/rfiec/rfiec.ino.
 */
(function (RF) {
'use strict';
var pet = RF.pet;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function bytes(arr) { return arr instanceof Uint8Array ? arr : new Uint8Array(arr); }

/* ======================= porta seriale (Web Serial) ======================= */
function SerialLink(port, log) { this.port = port; this.log = log || function () {}; this.onData = null; this.reading = false; this.writer = null; }
SerialLink.supported = function () { return typeof navigator !== 'undefined' && !!navigator.serial; };
// Pro Micro e cloni: Arduino (Leonardo/Micro), SparkFun, Arduino.org; si accetta comunque qualsiasi porta scelta dall'utente
SerialLink.filters = [{usbVendorId: 0x2341}, {usbVendorId: 0x1B4F}, {usbVendorId: 0x2A03}];
SerialLink.request = function (any) { return navigator.serial.requestPort(any ? {} : {filters: SerialLink.filters}); };
var SP = SerialLink.prototype;
SP.open = async function (baud) {
  await this.port.open({baudRate: baud || 115200, bufferSize: 4096});
  try { await this.port.setSignals({dataTerminalReady: true, requestToSend: true}); } catch (e) {}
  this.writer = this.port.writable.getWriter();
  this.readLoop();
};
SP.readLoop = async function () {
  this.reading = true;
  while (this.reading && this.port.readable) {
    var reader = this.port.readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        if (r.value && this.onData) this.onData(r.value);
      }
    } catch (e) { this.log('err', 'seriale: ' + e.message); }
    finally { try { reader.releaseLock(); } catch (e) {} }
    if (!this.reading) break;
    await sleep(50);
  }
};
SP.write = function (b) { return this.writer.write(bytes(b)); };
SP.close = async function () {
  this.reading = false;
  try { if (this.reader) await this.reader.cancel(); } catch (e) {}
  try { if (this.writer) { this.writer.releaseLock(); this.writer = null; } } catch (e) {}
  try { await this.port.close(); } catch (e) {}
};
// "tocco a 1200 baud": il core Arduino del firmware RFIEC si riavvia nel bootloader
SP.touch1200 = async function () {
  try { await this.close(); } catch (e) {}
  await this.port.open({baudRate: 1200});
  try { await this.port.setSignals({dataTerminalReady: false}); } catch (e) {}
  await sleep(100);
  await this.port.close();
};
// tocco a 1200 baud su una porta chiusa (per esempio subito dopo averla scollegata)
SerialLink.touch1200 = async function (port) {
  await port.open({baudRate: 1200});
  try { await port.setSignals({dataTerminalReady: false}); } catch (e) {}
  await sleep(100);
  await port.close();
};
RF.SerialLink = SerialLink;

/* ======================= lettura dei messaggi del firmware ======================= */
function FrameParser(onFrame) { this.buf = []; this.onFrame = onFrame; }
FrameParser.prototype.push = function (data) {
  for (var i = 0; i < data.length; i++) this.buf.push(data[i]);
  var b = this.buf;
  for (;;) {
    if (!b.length) return;
    var t = String.fromCharCode(b[0]), need;
    if (t === 'L') need = 3; else if (t === 'T') need = 4; else if (t === 'U') need = 2;
    else if (t === 'K') need = 5; else if (t === 'Q') need = 3; else if (t === 'R') need = 1;
    else if (t === 'H') need = b.length >= 2 ? 2 + b[1] : 0;
    else if (t === 'a') need = 3;
    else if (t === 'b' || t === 'm') need = 2;
    else if (t === 'x') need = 1;
    else if (t === 's') need = 5;
    else if (t === 'g') need = b.length >= 2 ? 3 + b[1] : 0;
    else if (t === 'W') need = b.length >= 3 ? 4 + b[2] : 0;
    else { b.shift(); continue; }                    // byte non riconosciuto: si scarta
    if (!need || b.length < need) return;
    var f = b.splice(0, need), fr = {type: t};
    if (t === 'L') { fr.slot = f[1]; fr.sec = f[2]; }
    else if (t === 'T') { fr.slot = f[1]; fr.sec = f[2]; fr.seq = f[3]; }
    else if (t === 'U') fr.slot = f[1];
    else if (t === 'K') { fr.slot = f[1]; fr.seq = f[2]; fr.consumed = f[3] | (f[4] << 8); }
    else if (t === 'Q') { fr.slot = f[1]; fr.seq = f[2]; }
    else if (t === 'H') fr.text = String.fromCharCode.apply(null, f.slice(2));
    else if (t === 'W') { fr.slot = f[1]; fr.eoi = !!f[3]; fr.data = f.slice(4); }
    else if (t === 'a') { fr.n = f[1]; fr.err = f[2]; }
    else if (t === 'b' || t === 'm') fr.n = f[1];
    else if (t === 'g') { fr.flags = f[2]; fr.data = f.slice(3); }
    else if (t === 's') fr.pins = f.slice(1);
    this.onFrame(fr);
  }
};
RF.IecFrameParser = FrameParser;

/* ======================= il PC risponde al C64 ======================= */
var CHUNK = 64;
/* Caricatori veloci: le cartucce mandano al drive il loro programma con una serie di M-W e lo avviano con M-E.
 * Come la libreria IECDevice (IECFileDevice::isFastLoaderRequest) li riconosciamo da indirizzo, lunghezza e somma
 * dei byte di ogni M-W; poi il firmware ('F') fa la sua parte del protocollo veloce. */
function sigRun(start, step, len, sums) { return sums.map(function (c, i) { return [start + i * step, len, c]; }); }
var FAST = [
  {name: 'Final Cartridge III', loader: 2, proto: 1, exec: [0x059A], sig: sigRun(0x400, 0x20, 0x20, [0xb0, 0x6a, 0x51, 0x0a, 0x61, 0x9b, 0x18, 0x0b, 0xb7, 0xb7, 0xf7, 0x8f, 0x6b, 0x5d, 0x7b, 0x52])},
  {name: 'Final Cartridge III (freezer)', loader: 2, proto: 5, exec: [0x0403], sig: sigRun(0x400, 0x20, 0x20, [0x23, 0xfc, 0x25, 0xcd, 0x4d, 0xc2, 0x9e, 0x5a, 0xc9, 0xb2, 0x5c, 0x8a, 0xc5, 0x02, 0xae, 0x2d])},
  {name: 'Final Cartridge III SAVE', loader: 2, proto: 2, exec: [0x059C, 0x05AF], sig: sigRun(0x500, 0x20, 0x20, [0x16, 0x7e, 0xe1, 0xd8, 0xf2, 0xe2, 0xa3, 0x2e, 0x27, 0x09, 0xfc, 0x8e, 0xaf, 0xe0, 0xc9, 0xa4])},
  {name: 'Epyx FastLoad', loader: 1, proto: 3, exec: [0x01A2], sig: [[0x0180, 0x20, 0x2E], [0x01A0, 0x20, 0xA5]]},
  {name: 'Epyx FastLoad', loader: 1, proto: 3, exec: [0x01A9], sig: [[0x0180, 0x19, 0x53], [0x0199, 0x19, 0xA6], [0x01B2, 0x19, 0x8F]]}
];
RF.FAST_LOADERS = FAST;
function mwMatch(b, sig) {
  if (b.length < sig[1] + 6 || b[3] !== (sig[0] & 255) || b[4] !== (sig[0] >> 8) || b[5] !== sig[1]) return false;
  for (var i = 0, c = 0; i < sig[1]; i++) c = (c + b[6 + i]) & 255;
  return c === sig[2];
}
function IecHost(link, opts) {
  opts = opts || {};
  this.link = link; this.drive = opts.drive; this.printer = opts.printer || null;
  this.log = opts.log || function () {}; this.onActivity = opts.onActivity || function () {}; this.onVersion = opts.onVersion || function () {};
  this.dev = opts.dev || 8; this.printerDev = opts.printerDev || 4; this.printerOn = !!opts.printerOn;
  this.talk = null; this.listenSa = null; this.listenBytes = []; this.version = ''; this.mw = null;
  var self = this;
  this.parser = new FrameParser(function (f) { self.frame(f); });
  link.onData = function (d) { self.parser.push(d); };
}
var IH = IecHost.prototype;
IH.send = function (arr) { return this.link.write(bytes(arr)); };
IH.hello = function () { return this.send([0x56]); };
IH.configure = async function () {
  // senza drive (pagina della stampante) lo slot 0 resta spento
  if (this.drive) this.drive.dev = this.dev;
  await this.send([0x43, 0, this.dev, this.drive ? 1 : 0]);
  await this.send([0x43, 1, this.printerDev, this.printerOn ? 1 : 0]);
};
IH.frame = function (f) {
  if (!this.drive && f.slot === 0) return;
  try { this['on' + f.type](f); }
  catch (e) { this.log('err', 'RFIEC ' + f.type + ': ' + e.message); }
};
IH.onH = function (f) { this.version = f.text; this.onVersion(f.text); };
IH.onR = function () {
  if (this.printer && this.printer.reset) this.printer.reset();
  if (!this.drive) return;
  this.drive.reset(false); this.talk = null; this.onActivity({kind: 'reset'}); };
// avanzamento per la pagina: al massimo qualche volta al secondo, così non rallenta il trasferimento
var PROG_MS = 300;
IH.progress = function (p, final) {
  var now = Date.now();
  if (!final && now - p.last < PROG_MS) return;
  p.last = now;
  var ms = Math.max(1, now - p.t0);
  this.onActivity({kind: 'progress', dir: p.dir, sa: p.sa, done: p.done, total: p.total || 0, ms: ms, bps: p.done * 1000 / ms, final: !!final});
};
IH.onL = function (f) {
  if (f.slot === 1) { if (this.printer) this.printer.listen(f.sec); return; }
  this.listenSa = f.sec; this.listenBytes = [];
  this.rx = (f.sec & 0xF0) === 0x60 && (f.sec & 15) !== 15 ? {dir: 'in', sa: f.sec & 15, done: 0, t0: Date.now(), last: Date.now()} : null;
  this.drive.atn([0x20 | this.dev, f.sec]);
};
IH.onW = function (f) {
  if (f.slot === 1) { if (this.printer) this.printer.write(f.data, f.eoi); return; }
  if (this.listenBytes.length < 300) this.listenBytes = this.listenBytes.concat(f.data);
  this.drive.write(f.data);
  if (this.rx) { this.rx.done += f.data.length; this.onActivity({kind: 'data', sa: this.rx.sa, n: f.data.length}); this.progress(this.rx); }
};
IH.onU = function (f) {
  if (f.slot === 1) { if (this.printer) this.printer.unlisten(); return; }
  var sa = this.listenSa, b = this.listenBytes;
  this.drive.atn([0x3F]);
  this.listenSa = null;
  if (this.rx && this.rx.done) { var rx = this.rx; this.onActivity({kind: 'recv', sa: rx.sa, n: rx.done, ms: Math.max(1, Date.now() - rx.t0)}); }
  this.rx = null;
  if (sa === null) return;
  var e = this.drive.err, ev = null;
  // comandi di memoria (M-W, M-E, M-R): niente riga nel registro, ma servono a riconoscere i caricatori veloci
  if ((sa === 0x6F || sa === 0xFF) && b[0] === 0x4D && b[1] === 0x2D) { this.memCmd(b); return; }
  if ((sa & 0xF0) === 0xF0 && b.length) ev = {kind: (sa & 15) === 15 ? 'cmd' : (sa & 15) === 1 ? 'save' : (sa & 15) === 0 ? 'load' : 'open', sa: sa & 15, name: b};
  else if ((sa & 0xF0) === 0x60 && (sa & 15) === 15 && b.length) ev = {kind: 'cmd', sa: 15, name: b};
  else if ((sa & 0xF0) === 0xE0) ev = {kind: 'close', sa: sa & 15};
  if (ev) { ev.code = e.code; ev.status = pet.toStr(e.bytes.slice(0, -1)); this.onActivity(ev); }
};
IH.memCmd = function (b) {
  var m = this.mw;
  if (b[2] === 0x57) {                                // M-W
    if (m && m.i < m.l.sig.length && mwMatch(b, m.l.sig[m.i])) { m.i++; return; }
    this.mw = null;
    for (var k = 0; k < FAST.length; k++) if (mwMatch(b, FAST[k].sig[0])) { this.mw = {l: FAST[k], i: 1}; return; }
  } else if (b[2] === 0x45) {                         // M-E
    var addr = b[3] | (b[4] << 8);
    this.mw = null;
    if (m && m.i === m.l.sig.length && m.l.exec.indexOf(addr) >= 0) {
      this.send([0x46, 0, m.l.loader, m.l.proto]);
      this.log('usb', 'caricatore veloce: ' + m.l.name);
      this.onActivity({kind: 'fast', name: m.l.name});
    }
  }
};
IH.onT = function (f) {
  if (f.slot === 1) return;                          // la stampante non parla mai
  var sa = f.sec & 15;
  this.drive.atn([0x40 | this.dev, f.sec]);
  var ch = sa === 15 ? this.drive.err : this.drive.channels[sa];
  var now = Date.now();
  this.talk = {seq: f.seq, sa: sa, ch: ch, start: ch ? ch.pos : 0, sent: 0, t0: now,
    prog: sa !== 15 && ch && ch.data && !ch.buffer ? {dir: 'out', sa: sa, done: ch.pos, total: ch.data.length, t0: now, last: now} : null};
  this.sendData();
};
IH.onQ = function (f) { if (f.slot === 0 && this.talk && this.talk.seq === f.seq) this.sendData(); };
IH.sendData = function () {
  var t = this.talk, r = this.drive.read(CHUNK), d = r.data, flags = r.eoi ? 1 : (d.length ? 0 : 2);
  t.sent += d.length;
  if (r.eoi || !d.length) t.done = true;
  if (t.prog) { t.prog.done = t.start + t.sent; this.progress(t.prog); }
  return this.send([0x44, 0, t.seq, d.length, flags].concat(d));
};
IH.onK = function (f) {
  if (f.slot === 1) return;
  var t = this.talk;
  if (t && t.seq === f.seq && t.ch && f.consumed < t.sent) {
    // il C64 ha smesso di leggere prima: si torna indietro dei byte mandati in anticipo
    if (t.ch.buffer) t.ch.pos = (t.start + f.consumed) & 255;
    else if (t.ch === this.drive.err) { if (this.drive.err === t.ch) t.ch.pos = Math.min(t.ch.bytes.length, t.start + f.consumed); }
    else t.ch.pos = t.start + f.consumed;
  }
  this.drive.atn([0x5F]);
  if (t && t.sa !== 15) this.onActivity({kind: 'sent', sa: t.sa, n: f.consumed, ms: Math.max(1, Date.now() - t.t0)});
  this.talk = null;
};
RF.IecHost = IecHost;

/* ======================= RFIEC 2.0 come XUM1541 (padrone del bus) =======================
 * Stessa interfaccia di RF.Xum1541 (open, write, read, ioctl, reset…), così Cbm e Drive di cbm.js funzionano uguali:
 * i comandi passano dalla porta seriale (comandi 'A' ATN, 'B' dati, 'G' lettura, 'X' reset) invece che da WebUSB.
 */
var ATN_ERR = {1: 'nessuno tira DATA dopo ATN', 2: 'chi ascolta non libera DATA (non è pronto)', 3: 'byte non confermato da chi ascolta', 4: 'dopo il TALK il dispositivo non prende CLK'};
function msg(k, d) { return (RF.msg && RF.msg(k)) || d; }
function SerialXum(link, log) {
  this.link = link; this.log = log || function () {};
  this.version = ''; this.gitrev = ''; this.isSerial = true; this.simulated = !!link.simulated;
  this.pending = null; this.dirty = null; this.cancel = false; this.slowUntil = 0; this.watchdog = 8000; this.eoi = false;
  this.wait = null;
  var self = this;
  this.parser = new FrameParser(function (f) { self.onFrame(f); });
}
var SX = SerialXum.prototype;
SX.onFrame = function (f) {
  var w = this.wait;
  if (!w || f.type !== w.type) return;
  if (f.type === 'g') {
    w.parts.push(f.data);
    if (f.flags & 1) w.eoi = true;
    if (!(f.flags & 2)) return;
  }
  this.wait = null; clearTimeout(w.t); w.resolve(f.type === 'g' ? w : f);
};
// manda un comando e aspetta la risposta del tipo dato (ms: tempo massimo, se manca quello del drive lento)
SX.request = function (frame, type, ms) {
  var self = this;
  if (self.dirty) return Promise.reject(self.dirty);
  return new Promise(function (res, rej) {
    var w = {type: type, parts: [], resolve: res, reject: rej};
    var limit = ms || Math.max(self.watchdog, self.slowUntil - Date.now() + 5000);
    w.t = setTimeout(function () {
      if (self.wait === w) self.wait = null;
      var e = new Error(msg('noBus', 'Nessuna risposta dal bus IEC.')); e.noBus = true; self.dirty = e; rej(e);
    }, limit);
    self.wait = w;
    Promise.resolve(self.link.write(bytes(frame))).catch(function (e) { clearTimeout(w.t); if (self.wait === w) self.wait = null; rej(e); });
  });
};
SX.open = async function () {
  if (!this.link.opened) { await this.link.open(115200); this.link.opened = true; }
  var self = this;
  this.link.onData = function (d) { self.parser.push(d); };
  var h;
  try { h = await this.request([0x56], 'H', 2500); }
  catch (e) { this.dirty = null; throw new Error(msg('serNoFw', 'La porta risponde ma non c\u2019è il firmware RFIEC.')); }
  var m = /RFIEC (\d+)\.(\d+)/.exec(h.text || '');
  if (!m || +m[1] < 2) { var e = new Error(msg('serOld', 'Serve il firmware RFIEC 2.0') + ' (' + (h.text || '?') + ')'); e.oldFw = h.text; throw e; }
  this.version = h.text;
  await this.request([0x4D, 1], 'm', 2000);
  this.log('usb', h.text + ': padrone del bus (come la XUM1541)');
};
SX.close = async function () {
  try { if (!this.dirty) await this.request([0x4D, 0], 'm', 1000); } catch (e) {}
  try { await this.link.close(); } catch (e) {}
  this.link.opened = false;
};
SX.write = async function (mode, data) {
  var X = RF.XUM, arr = Array.prototype.slice.call(data);
  this.eoi = false;
  if (mode & X.F_ATN) {
    var a = await this.request([0x41, arr.length, (mode & X.F_TALK) ? 1 : 0].concat(arr), 'a');
    if (a.err) this.log('err', 'bus: ' + (ATN_ERR[a.err] || 'errore ' + a.err) + ' (byte ' + (a.n + 1) + ' di ' + arr.length + ' sotto ATN: $' + (arr[a.n] !== undefined ? arr[a.n].toString(16).toUpperCase() : '?') + ')');
    return a.n;
  }
  // come la XUM1541 di OpenCBM: l'ultimo byte di ogni scrittura va con EOI (il 1541 lo vuole, per esempio, alla fine
  // del nome di un OPEN, altrimenti non apre il file)
  var total = 0;
  for (var p = 0; p < arr.length; p += 60) {
    var c = arr.slice(p, p + 60), last = p + 60 >= arr.length, r = await this.request([0x42, c.length, last ? 1 : 0].concat(c), 'b');
    total += r.n;
    if (r.n < c.length) break;
  }
  return total;
};
SX.read = async function (mode, len) {
  var w = await this.request([0x47, len & 255, len >> 8], 'g');
  this.eoi = !!w.eoi;
  var out = [];
  w.parts.forEach(function (p) { for (var i = 0; i < p.length; i++) out.push(p[i]); });
  return new Uint8Array(out);
};
SX.ioctl = async function (cmd) {
  var X = RF.XUM;
  if (cmd === X.GET_EOI) return this.eoi ? 1 : 0;
  if (cmd === X.CLEAR_EOI) { this.eoi = false; return 0; }
  return 0;
};
// misura delle linee del bus (RFIEC 2.2): testo per il registro
SX.diag = async function () {
  var f;
  try { f = await this.request([0x53], 's', 2000); } catch (e) { this.dirty = null; return 'misura delle linee non disponibile (serve RFIEC 2.2)'; }
  function st(v) { return 'ATN ' + (v & 0x10 ? 1 : 0) + ' CLK ' + (v & 0x08 ? 1 : 0) + ' DATA ' + (v & 0x04 ? 1 : 0) + ' RESET ' + (v & 0x40 ? 1 : 0); }
  var p = f.pins, out = 'linee a riposo: ' + st(p[0]) + ' · con i pull-up interni: ' + st(p[1]) + ' · con ATN tirato: ' + st(p[2]) + ' · dopo: ' + st(p[3]);
  if (!(p[0] & 0x40) && !(p[1] & 0x40)) out += ' → RESET è a zero: qualcosa tiene il drive in reset';
  else if (p[2] & 0x04) out += ' → con ATN tirato DATA resta alta: nessun dispositivo risponde (drive spento, non avviato o cavo)';
  return out;
};
SX.reset = async function () { await this.request([0x58], 'x', 3000); await sleep(this.simulated ? 20 : 1500); };
// "Interrompi" e tempo massimo: si abbandona la risposta attesa e recover() riapre la porta
SX.unstick = function (err) {
  this.dirty = this.dirty || err;
  var w = this.wait;
  if (w) { this.wait = null; clearTimeout(w.t); w.reject(err); }
};
SX.recover = async function () {
  if (!this.dirty) return;
  this.log('usb', 'riapro la porta seriale');
  this.dirty = null; this.cancel = false;
  try { await this.link.close(); } catch (e) {}
  this.link.opened = false;
  await this.open();
};
RF.SerialXum = SerialXum;

/* ======================= Intel HEX e programmazione del Pro Micro ======================= */
RF.parseHex = function (text) {
  var mem = new Uint8Array(32768).fill(0xFF), top = 0, base = 0;
  text.split(/\r?\n/).forEach(function (l) {
    if (l[0] !== ':') return;
    var n = parseInt(l.substr(1, 2), 16), a = parseInt(l.substr(3, 4), 16), t = parseInt(l.substr(7, 2), 16);
    if (t === 4) base = parseInt(l.substr(9, 4), 16) << 16;
    if (t === 2) base = parseInt(l.substr(9, 4), 16) << 4;
    if (t !== 0) return;
    for (var i = 0; i < n; i++) { var addr = base + a + i; mem[addr] = parseInt(l.substr(9 + i * 2, 2), 16); top = Math.max(top, addr + 1); }
  });
  return mem.slice(0, Math.ceil(top / 128) * 128);
};

// protocollo AVR109 del bootloader Caterina (lo stesso che usa avrdude -c avr109)
function Avr109(io, log) { this.io = io; this.log = log || function () {}; this.rx = []; var self = this; io.onData = function (d) { for (var i = 0; i < d.length; i++) self.rx.push(d[i]); }; }
var AP = Avr109.prototype;
AP.cmd = async function (out, nIn, timeout) {
  this.rx.length = 0;
  await this.io.write(bytes(out));
  var t0 = Date.now();
  while (this.rx.length < nIn) {
    if (Date.now() - t0 > (timeout || 2000)) throw new Error('il bootloader non risponde');
    await sleep(2);
  }
  return this.rx.splice(0, nIn);
};
AP.ok = async function (out, timeout) { var r = await this.cmd(out, 1, timeout); if (r[0] !== 13) throw new Error('risposta inattesa del bootloader: ' + r[0]); };
AP.program = async function (image, onProgress) {
  var id = String.fromCharCode.apply(null, await this.cmd([0x53], 7));
  this.log('usb', 'bootloader: ' + id);
  if (!/CATERIN|LUFACDC|AVRBOOT/i.test(id)) throw new Error('bootloader sconosciuto (' + id + ')');
  var b = await this.cmd([0x62], 3), block = b[0] === 0x59 ? (b[1] << 8) | b[2] : 0;
  if (block < 128) throw new Error('il bootloader non accetta blocchi da 128 byte');
  if (image.length > 28672) throw new Error('firmware troppo grande per il Pro Micro');
  await this.ok([0x50]);
  var pages = image.length / 128;
  for (var p = 0; p < pages; p++) {
    var w = p * 64;                                  // indirizzo in parole
    await this.ok([0x41, w >> 8, w & 255]);
    await this.ok([0x42, 0, 128, 0x46].concat(Array.prototype.slice.call(image, p * 128, p * 128 + 128)), 4000);
    if (onProgress) onProgress(p + 1, pages * 2, 'write');
  }
  for (var q = 0; q < pages; q++) {                  // verifica
    await this.ok([0x41, (q * 64) >> 8, (q * 64) & 255]);
    var back = await this.cmd([0x67, 0, 128, 0x46], 128, 4000);
    for (var i = 0; i < 128; i++) if (back[i] !== image[q * 128 + i]) throw new Error('verifica fallita all\'indirizzo ' + (q * 128 + i));
    if (onProgress) onProgress(pages + q + 1, pages * 2, 'verify');
  }
  await this.ok([0x4C]);
  await this.ok([0x45]);                             // esce dal bootloader e avvia il firmware
};
RF.Avr109 = Avr109;
/* Scrive il firmware sulla porta scelta nel dialogo. Se lì non risponde il bootloader ma la porta è di un Pro Micro
 * (scheda nuova con lo sketch di prova, RFIEC non collegata alla pagina…), la riavvia nel bootloader con il tocco a
 * 1200 baud e restituisce 'restarted': il bootloader compare come un'altra porta, da scegliere di nuovo entro 8 secondi.
 * link: solo per le prove (un oggetto con open/close/write/onData al posto della porta vera). */
RF.flashFirmware = async function (port, image, log, onProgress, link) {
  log = log || function () {};
  link = link || new SerialLink(port, log);
  await link.open(57600);
  var av = new Avr109(link, log), id = '';
  try { id = String.fromCharCode.apply(null, await av.cmd([0x53], 7, 800)); } catch (e) {}
  if (!/CATERIN|LUFACDC|AVRBOOT/i.test(id)) {
    try { await link.close(); } catch (e) {}
    var info = port && port.getInfo ? port.getInfo() : {}, known = SerialLink.filters.some(function (f) { return f.usbVendorId === info.usbVendorId; });
    if (!known) throw new Error(id ? 'bootloader sconosciuto (' + id + ')' : 'il bootloader non risponde');
    log('usb', 'sulla porta non c\'è il bootloader: la riavvio con il tocco a 1200 baud');
    await SerialLink.touch1200(port);
    return 'restarted';
  }
  try { await av.program(image, onProgress); } finally { try { await link.close(); } catch (e) {} }
  return 'done';
};
// firmware incorporati nella pagina (base64, generati da build.py)
RF.firmwareImage = function (key) {
  var f = RF.FIRMWARE && RF.FIRMWARE[key];
  if (!f) return null;
  var bin = atob(f.b64), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/* ======================= doppioni per le prove senza hardware ======================= */
// bootloader finto: memoria flash di 28 KB
function FakeCaterina() { this.flash = new Uint8Array(28672).fill(0xFF); this.addr = 0; this.onData = null; this.exited = false; }
FakeCaterina.prototype.write = async function (b) {
  var self = this, c = b[0], out;
  var reply = function (arr) { setTimeout(function () { if (self.onData) self.onData(new Uint8Array(arr)); }, 1); };
  if (c === 0x53) reply(pet.fromStr('CATERIN'));
  else if (c === 0x62) reply([0x59, 0, 128]);
  else if (c === 0x50 || c === 0x4C) reply([13]);
  else if (c === 0x45) { this.exited = true; reply([13]); }
  else if (c === 0x41) { this.addr = ((b[1] << 8) | b[2]) * 2; reply([13]); }
  else if (c === 0x42) { var n = (b[1] << 8) | b[2]; this.flash.set(b.subarray(4, 4 + n), this.addr); this.addr += n; reply([13]); }
  else if (c === 0x67) { var m = (b[1] << 8) | b[2]; out = Array.prototype.slice.call(this.flash, this.addr, this.addr + m); this.addr += m; reply(out); }
  else reply([0x3F]);
};
RF.FakeCaterina = FakeCaterina;

// firmware RFIEC finto con un C64 che usa le routine del Kernal: serve a provare IecHost
function FakeRfiec() { this.onData = null; this.seq = 0; this.rb = []; this.more = false; this.pending = false; this.noData = false; this.consumed = 0; this.waiters = []; this.config = {}; }
var FR = FakeRfiec.prototype;
FR.emit = function (arr) { var self = this; return new Promise(function (r) { setTimeout(function () { self.onData(new Uint8Array(arr)); r(); }, 0); }); };
FR.write = async function (b) {            // dal PC
  var t = String.fromCharCode(b[0]);
  if (t === 'V') await this.emit([0x48, 9].concat(pet.fromStr('RFIEC 2.6')));
  else if (t === 'C') this.config[b[1]] = {dev: b[2], on: !!(b[3] & 1)};
  else if (t === 'F') this.fast = [b[2], b[3]];
  else if (t === 'D' && b[2] === this.seq) {
    this.pending = false;
    for (var i = 0; i < b[3]; i++) this.rb.push(b[5 + i]);
    if (b[4] & 1) this.more = false;
    if (b[4] & 2) { this.more = false; this.noData = !this.rb.length; }
    var w = this.waiters; this.waiters = []; w.forEach(function (f) { f(); });
  }
};
FR.wait = function () { var self = this; return new Promise(function (r) { self.waiters.push(r); setTimeout(r, 200); }); };
FR.listen = async function (sec, data) {
  await this.emit([0x4C, 0, sec]);
  for (var p = 0; data && p < data.length; p += 32) { var c = data.slice(p, p + 32); await this.emit([0x57, 0, c.length, p + 32 >= data.length ? 1 : 0].concat(c)); }
  await this.emit([0x55, 0]);
};
// TALK: legge fino a max byte (tutti se max manca), come il Kernal con ACPTR
FR.talk = async function (sec, max) {
  this.seq = (this.seq + 1) & 255; this.rb = []; this.more = true; this.pending = true; this.noData = false; this.consumed = 0;
  await this.emit([0x54, 0, sec, this.seq]);
  var out = [], guard = 0;
  while ((max === undefined || out.length < max) && guard++ < 100000) {
    if (this.rb.length >= 2 || (this.rb.length === 1 && !this.more)) { out.push(this.rb.shift()); this.consumed++; if (!this.rb.length && !this.more) break; continue; }
    if (!this.rb.length && !this.more) break;
    if (!this.pending) { this.pending = true; await this.emit([0x51, 0, this.seq]); }
    await this.wait();
  }
  await this.emit([0x4B, 0, this.seq, this.consumed & 255, this.consumed >> 8]);
  return out;
};
FR.load = async function (name) {
  await this.listen(0xF0, pet.fromStr(name));
  var d = await this.talk(0x60);
  await this.listen(0xE0);
  return d;
};
FR.save = async function (name, data) {
  await this.listen(0xF1, pet.fromStr(name));
  await this.listen(0x61, Array.prototype.slice.call(data));
  await this.listen(0xE1);
};
FR.status = async function () { return pet.toStr(await this.talk(0x6F)).replace(/·$/, ''); };
FR.command = async function (cmd) { await this.listen(0x6F, pet.fromStr(cmd)); };
RF.FakeRfiec = FakeRfiec;

// RFIEC 2.0 finto come padrone del bus: i dispositivi sono FakeDrive (atn/write/read) o una stampante Mps
function FakeRfiecMaster(devices) {
  this.simulated = true; this.onData = null; this.devices = devices || []; this.master = false; this.version = 'RFIEC 2.6';
}
var FM = FakeRfiecMaster.prototype;
FM.open = async function () { this.opened = true; };
FM.close = async function () { this.opened = false; };
FM.emit = function (arr) { var self = this; setTimeout(function () { if (self.onData) self.onData(new Uint8Array(arr)); }, 1); };
FM.write = async function (b) {
  var t = String.fromCharCode(b[0]), self = this, devs = this.devices;
  if (t === 'V') return this.emit([0x48, this.version.length].concat(pet.fromStr(this.version)));
  if (t === 'M') { this.master = b[1] === 1; return this.emit([0x6D, b[1]]); }
  if (!this.master) return;
  if (t === 'A') {
    var data = Array.prototype.slice.call(b, 3, 3 + b[1]), present = devs.some(function (d) { return d.powered !== false; });
    devs.forEach(function (d) { d.atn(data); });
    return this.emit([0x61, present ? data.length : 0, present ? 0 : 1]);
  }
  if (t === 'B') {
    var dat = Array.prototype.slice.call(b, 3, 3 + b[1]), n = 0;
    for (var i = 0; i < devs.length; i++) {
      var d = devs[i];
      while (d.isBusy && d.isBusy()) await sleep(Math.min(200, d.busyUntil - Date.now() + 1));
      n = Math.max(n, d.write(dat) || 0);
    }
    return this.emit([0x62, n]);
  }
  if (t === 'G') {
    var len = b[1] | (b[2] << 8), r = {data: [], eoi: false};
    for (var k = 0; k < devs.length; k++) {
      var dv = devs[k];
      if (dv.isBusy && dv.isBusy()) { await sleep(Math.max(0, Math.min(1000, dv.busyUntil - Date.now()))); if (dv.isBusy()) continue; }
      var rr = dv.read ? dv.read(len) : {data: []};
      if (rr.data.length || rr.eoi) { r = rr; break; }
    }
    for (var p = 0; p < r.data.length || p === 0; p += 60) {
      var c = r.data.slice(p, p + 60), last = p + 60 >= r.data.length;
      this.emit([0x67, c.length, (last && r.eoi ? 1 : 0) | (last ? 2 : 0)].concat(c));
      if (last) break;
    }
    return;
  }
  if (t === 'X') { devs.forEach(function (d) { if (d.reset) d.reset(false); }); this.emit([0x78]); }
  if (t === 'S') { var on = devs.some(function (d) { return d.powered !== false; }); this.emit([0x73, 0x5C, 0x5C, on ? 0x48 : 0x4C, 0x5C]); }
};
// una stampante Mps vista dal bus (numero dev): ascolta LISTEN dev e passa i dati all'emulatore
function FakeBusPrinter(mps, dev) { this.mps = mps; this.dev = dev || 4; this.listening = false; }
FakeBusPrinter.prototype.atn = function (bytes) {
  for (var i = 0; i < bytes.length; i++) {
    var x = bytes[i];
    if (x === 0x3F) { if (this.listening) this.mps.unlisten(); this.listening = false; }
    else if ((x & 0xE0) === 0x20) this.listening = (x & 0x1F) === this.dev;
    else if ((x & 0xE0) === 0x40) this.listening = false;
    else if (this.listening && (x & 0xF0) >= 0x60) this.mps.listen(x);
  }
  return bytes.length;
};
FakeBusPrinter.prototype.write = function (d) { if (!this.listening) return 0; this.mps.write(d); return d.length; };
FakeBusPrinter.prototype.read = function () { return {data: [], eoi: false}; };
RF.FakeRfiecMaster = FakeRfiecMaster;
RF.FakeBusPrinter = FakeBusPrinter;
})(window.RFFloppy = window.RFFloppy || {});
