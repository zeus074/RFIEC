/* copiato da floppy-web/src/d64.js da build.py: non modificare qui */
/* RetroFixer · Floppy C64 · immagini disco D64 / D71 / D81
 * Lettura e scrittura di immagini in memoria (Uint8Array): directory, BAM, file, formattazione,
 * cancellazione, rinomina, validazione, blocchi. Usata dal visualizzatore e dal drive simulato.
 */
(function (RF) {
'use strict';

/* ---------- PETSCII ---------- */
// visualizzazione nel set maiuscole/grafica (quello di accensione del C64)
var GFX = {0x5C:'£',0x5E:'↑',0x5F:'←',0x60:'─',0x61:'♠',0x62:'│',0x63:'─',0x6B:'╮',0x6C:'╰',0x6D:'╯',0x6E:'╲',0x6F:'╱',
  0x71:'●',0x73:'♥',0x75:'╭',0x76:'╳',0x77:'○',0x78:'♣',0x7A:'♦',0x7B:'┼',0x7D:'│',0x7E:'π',0x7F:'◥',0xA0:' ',0xFF:'π'};
function petChar(b) {
  if (b >= 0x20 && b <= 0x5B) return String.fromCharCode(b);
  if (b === 0x5D) return ']';
  if (GFX[b]) return GFX[b];
  if (b >= 0xC0 && b <= 0xDF && GFX[b - 0x60]) return GFX[b - 0x60];
  if (b >= 0xC1 && b <= 0xDA) return String.fromCharCode(b - 0x80); // lettere "shiftate": nel set grafico sono simboli, le mostriamo come lettere
  if (b >= 0xE0 && b <= 0xFE) return '▒';
  if (b >= 0xA1 && b <= 0xBF) return '▒';
  return '·';
}
function petToStr(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += petChar(bytes[i]); return s; }
// testo del PC → PETSCII (maiuscolo, caratteri sconosciuti → '?')
function strToPet(str) {
  var out = [], s = String(str).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 0xA3) out.push(0x5C);
    else if (c >= 0x20 && c <= 0x5D) out.push(c);
    else out.push(0x3F);
  }
  return out;
}
// nome di file del PC → nome C64 (16 caratteri, senza caratteri vietati nei nomi DOS)
function pcNameToC64(name) {
  var base = String(name).replace(/\.(prg|seq|usr|p00|s00|u00)$/i, '').replace(/[_]+/g, ' ');
  var p = strToPet(base).filter(function (b) { return b !== 0x2A && b !== 0x3F && b !== 0x2C && b !== 0x3A && b !== 0x3D && b !== 0x22 && b !== 0x24 && b !== 0x40 || false; });
  while (p.length && p[0] === 0x20) p.shift();
  return p.slice(0, 16).length ? p.slice(0, 16) : strToPet('SENZA NOME');
}
function c64NameToPc(bytes, ext) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b >= 0x41 && b <= 0x5A) s += String.fromCharCode(b + 32);
    else if (b >= 0xC1 && b <= 0xDA) s += String.fromCharCode(b - 0x80);
    else if ((b >= 0x30 && b <= 0x39) || b === 0x2D || b === 0x2E || b === 0x2B || b === 0x21 || b === 0x28 || b === 0x29) s += String.fromCharCode(b);
    else if (b === 0x20 || b === 0xA0) s += ' ';
    else s += '_';
  }
  s = s.trim().replace(/\s+/g, ' ') || 'file';
  return ext ? s + '.' + ext : s;
}
function bytesEq(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
// confronto con i caratteri jolly del DOS: * = il resto, ? = un carattere qualsiasi
function wildMatch(pat, name) {
  for (var i = 0; i < pat.length; i++) {
    if (pat[i] === 0x2A) return true;
    if (i >= name.length) return false;
    if (pat[i] !== 0x3F && pat[i] !== name[i]) return false;
  }
  return pat.length === name.length;
}

/* ---------- formati ---------- */
var TYPES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL', 'CBM'];
function zone(t) { return t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17; }
var FORMATS = {
  d64: {id:'d64', label:'D64', drive:'1541', tracks:35, maxTracks:40, spt:function (t) { return zone(t); },
        dirTrack:18, header:[18,0], dirStart:[18,1], dos:'2A', fileIl:10, dirIl:3, reserved:[18]},
  d71: {id:'d71', label:'D71', drive:'1571', tracks:70, maxTracks:70, spt:function (t) { return zone(t > 35 ? t - 35 : t); },
        dirTrack:18, header:[18,0], dirStart:[18,1], dos:'2A', fileIl:6, dirIl:3, reserved:[18,53]},
  d81: {id:'d81', label:'D81', drive:'1581', tracks:80, maxTracks:80, spt:function () { return 40; },
        dirTrack:40, header:[40,0], dirStart:[40,3], dos:'3D', fileIl:1, dirIl:1, reserved:[40]}
};
function sizeFor(f, tracks) { var n = 0; for (var t = 1; t <= tracks; t++) n += f.spt(t); return n; }
// riconosce il formato dalla dimensione (con o senza i byte di errore in coda)
function detect(len) {
  var c = [['d64',35],['d64',40],['d64',42],['d71',70],['d81',80]];
  for (var i = 0; i < c.length; i++) {
    var f = FORMATS[c[i][0]], n = sizeFor(f, c[i][1]);
    if (len === n * 256 || len === n * 257) return {fmt:f, tracks:c[i][1], sectors:n, errors: len === n * 257};
  }
  return null;
}

function DiskError(code, msg, t, s) { var e = new Error(msg); e.code = code; e.t = t || 0; e.s = s || 0; return e; }

/* ---------- immagine ---------- */
function Disk(data, name) {
  var d = detect(data.length);
  if (!d) throw DiskError(0, 'Dimensione non riconosciuta (' + data.length + ' byte): servono immagini D64, D71 o D81.');
  this.fmt = d.fmt; this.tracks = d.tracks; this.sectors = d.sectors;
  this.data = data.slice(0, d.sectors * 256);
  this.errorBytes = d.errors ? data.slice(d.sectors * 256) : null;
  this.name = name || '';
  this.offs = [0, 0];
  for (var t = 1; t <= this.tracks; t++) this.offs[t + 1] = this.offs[t] + this.fmt.spt(t) * 256;
}
Disk.FORMATS = FORMATS;
Disk.detect = detect;
Disk.blank = function (fmtId, nameBytes, idBytes) {
  var f = FORMATS[fmtId] || FORMATS.d64, d = new Disk(new Uint8Array(sizeFor(f, f.tracks) * 256));
  d.format(nameBytes, idBytes || strToPet('00'));
  return d;
};

var P = Disk.prototype;
P.spt = function (t) { return this.fmt.spt(t); };
P.valid = function (t, s) { return t >= 1 && t <= this.tracks && s >= 0 && s < this.fmt.spt(t); };
P.off = function (t, s) {
  if (!this.valid(t, s)) throw DiskError(66, 'ILLEGAL TRACK OR SECTOR', t, s);
  return this.offs[t] + s * 256;
};
P.block = function (t, s) { var o = this.off(t, s); return this.data.subarray(o, o + 256); };
P.readBlock = function (t, s) { return this.block(t, s).slice(); };
P.writeBlock = function (t, s, bytes) { this.block(t, s).set(bytes.subarray ? bytes.subarray(0, 256) : bytes.slice(0, 256)); };
P.sectorIndex = function (t, s) { return this.off(t, s) / 256; };
// tracce che il DOS usa (le tracce 36-40 di un D64 da 40 tracce non hanno BAM standard)
P.dosTracks = function () { return this.fmt.id === 'd64' ? 35 : this.tracks; };

/* ---------- BAM ---------- */
P.bamEntry = function (t) {
  var f = this.fmt.id;
  if (f === 'd81') {
    var sec = t <= 40 ? this.off(40, 1) : this.off(40, 2), tt = t <= 40 ? t : t - 40, e = sec + 0x10 + 6 * (tt - 1);
    return {count: e, map: e + 1};
  }
  if (t <= 35) { var b = this.off(18, 0) + 4 + 4 * (t - 1); return {count: b, map: b + 1}; }
  if (f === 'd71' && t <= 70) return {count: this.off(18, 0) + 0xDD + (t - 36), map: this.off(53, 0) + 3 * (t - 36)};
  return null;
};
P.isFree = function (t, s) {
  var e = this.bamEntry(t);
  if (!e) return false;
  return (this.data[e.map + (s >> 3)] & (1 << (s & 7))) !== 0;
};
P.setFree = function (t, s, free) {
  var e = this.bamEntry(t);
  if (!e) return;
  var i = e.map + (s >> 3), m = 1 << (s & 7), was = (this.data[i] & m) !== 0;
  if (was === free) return;
  if (free) { this.data[i] |= m; this.data[e.count]++; }
  else { this.data[i] &= ~m; this.data[e.count]--; }
};
P.trackFree = function (t) { var e = this.bamEntry(t); return e ? this.data[e.count] : 0; };
P.blocksFree = function () {
  var n = 0, max = this.dosTracks();
  for (var t = 1; t <= max; t++) if (this.fmt.reserved.indexOf(t) < 0) n += this.trackFree(t);
  return n;
};
P.blocksTotal = function () {
  var n = 0, max = this.dosTracks();
  for (var t = 1; t <= max; t++) if (this.fmt.reserved.indexOf(t) < 0) n += this.fmt.spt(t);
  return n;
};
// mappa per il disegno: 0 libero, 1 occupato, 2 sistema (traccia directory), 3 fuori dalla BAM
P.bamMap = function () {
  var out = [];
  for (var t = 1; t <= this.tracks; t++) {
    var row = [];
    for (var s = 0; s < this.fmt.spt(t); s++) {
      if (t > this.dosTracks()) row.push(3);
      else if (this.fmt.reserved.indexOf(t) >= 0) row.push(this.isFree(t, s) ? 0 : 2);
      else row.push(this.isFree(t, s) ? 0 : 1);
    }
    out.push(row);
  }
  return out;
};

/* ---------- intestazione ---------- */
P.headerInfo = function () {
  var b, nameOff, idOff;
  if (this.fmt.id === 'd81') { b = this.block(40, 0); nameOff = 0x04; idOff = 0x16; }
  else { b = this.block(18, 0); nameOff = 0x90; idOff = 0xA2; }
  var name = Array.prototype.slice.call(b, nameOff, nameOff + 16);
  while (name.length && name[name.length - 1] === 0xA0) name.pop();
  return {name: name, id: [b[idOff], b[idOff + 1]], dos: [b[idOff + 3], b[idOff + 4]], raw: Array.prototype.slice.call(b, nameOff, nameOff + 27)};
};

/* ---------- formattazione ---------- */
function pad16(bytes) { bytes = bytes || []; var a = new Array(16).fill(0xA0); for (var i = 0; i < 16 && i < bytes.length; i++) a[i] = bytes[i]; return a; }
P.format = function (nameBytes, idBytes) {
  var f = this.fmt, id = idBytes && idBytes.length ? [idBytes[0], idBytes.length > 1 ? idBytes[1] : 0x20] : this.headerInfo().id;
  this.data.fill(0);
  var t, s, b;
  if (f.id === 'd81') {
    b = this.block(40, 0);
    b.set([40, 3, 0x44, 0]); b.set(pad16(nameBytes), 4); b[20] = b[21] = 0xA0; b[22] = id[0]; b[23] = id[1]; b[24] = 0xA0;
    b[25] = 0x33; b[26] = 0x44; b[27] = b[28] = 0xA0;
    [[40, 1, 40, 2], [40, 2, 0, 0xFF]].forEach(function (x) {
      var bb = this.block(x[0], x[1]);
      bb.set([x[2], x[3], 0x44, 0xBB, id[0], id[1], 0xC0, 0]);
    }, this);
    for (t = 1; t <= 80; t++) for (s = 0; s < 40; s++) this.setFree(t, s, true);
    for (s = 0; s < 4; s++) this.setFree(40, s, false);
    b = this.block(40, 3); b[1] = 0xFF;
  } else {
    b = this.block(18, 0);
    b.set([18, 1, 0x41, f.id === 'd71' ? 0x80 : 0]);
    b.set(pad16(nameBytes), 0x90); b[0xA0] = b[0xA1] = 0xA0; b[0xA2] = id[0]; b[0xA3] = id[1]; b[0xA4] = 0xA0;
    b[0xA5] = 0x32; b[0xA6] = 0x41; for (var i = 0xA7; i <= 0xAA; i++) b[i] = 0xA0;
    var last = f.id === 'd71' ? 70 : 35;
    for (t = 1; t <= last; t++) for (s = 0; s < f.spt(t); s++) this.setFree(t, s, true);
    this.setFree(18, 0, false); this.setFree(18, 1, false);
    if (f.id === 'd71') for (s = 0; s < f.spt(53); s++) this.setFree(53, s, false);
    b = this.block(18, 1); b[1] = 0xFF;
  }
  if (this.errorBytes) this.errorBytes.fill(1);
};
// formattazione rapida (N:nome senza ID): azzera directory e BAM, tiene l'ID
P.quickFormat = function (nameBytes) { this.format(nameBytes, this.headerInfo().id); };

/* ---------- directory ---------- */
P.dirSectors = function () {
  var out = [], seen = {}, t = this.fmt.dirStart[0], s = this.fmt.dirStart[1];
  while (t !== 0 && this.valid(t, s) && !seen[t + ':' + s] && out.length < 200) {
    seen[t + ':' + s] = 1; out.push([t, s]);
    var b = this.block(t, s); t = b[0]; s = b[1];
  }
  return out;
};
P.entries = function (withEmpty) {
  var out = [], secs = this.dirSectors();
  for (var k = 0; k < secs.length; k++) {
    var b = this.block(secs[k][0], secs[k][1]);
    for (var i = 0; i < 8; i++) {
      var o = i * 32, type = b[o + 2];
      if (type === 0 && !withEmpty) continue;
      var nm = Array.prototype.slice.call(b, o + 5, o + 21);
      while (nm.length && nm[nm.length - 1] === 0xA0) nm.pop();
      out.push({dt: secs[k][0], ds: secs[k][1], di: i, rawType: type, type: type & 7, typeName: TYPES[type & 7] || '???',
        closed: (type & 0x80) !== 0, locked: (type & 0x40) !== 0, t: b[o + 3], s: b[o + 4], name: nm,
        blocks: b[o + 30] | (b[o + 31] << 8), sideT: b[o + 21], sideS: b[o + 22], recLen: b[o + 23], empty: type === 0});
    }
  }
  return out;
};
P.files = function () { return this.entries(false); };
P.find = function (nameBytes, typeFilter) {
  var e = this.files();
  for (var i = 0; i < e.length; i++) {
    if (!e[i].closed && !typeFilter) continue;
    if (typeFilter && e[i].type !== typeFilter) continue;
    if (wildMatch(nameBytes, e[i].name)) return e[i];
  }
  return null;
};
P.findExact = function (nameBytes) {
  var e = this.files();
  for (var i = 0; i < e.length; i++) if (bytesEq(e[i].name, nameBytes)) return e[i];
  return null;
};
P.entryOffset = function (e) { return this.off(e.dt, e.ds) + e.di * 32; };

/* ---------- lettura dei file ---------- */
P.chain = function (t, s) {
  var out = [], seen = {};
  while (t !== 0) {
    if (!this.valid(t, s)) throw DiskError(66, 'ILLEGAL TRACK OR SECTOR', t, s);
    if (seen[t + ':' + s]) throw DiskError(66, 'Catena di blocchi circolare', t, s);
    seen[t + ':' + s] = 1; out.push([t, s]);
    var b = this.block(t, s); t = b[0]; s = b[1];
    if (out.length > this.sectors) break;
  }
  return out;
};
P.readChain = function (t, s) {
  var c = this.chain(t, s), parts = [], len = 0;
  for (var i = 0; i < c.length; i++) {
    var b = this.block(c[i][0], c[i][1]), end = b[0] === 0 ? Math.max(1, b[1]) : 255;
    var part = b.subarray(2, end + 1); parts.push(part); len += part.length;
  }
  var out = new Uint8Array(len), p = 0;
  parts.forEach(function (x) { out.set(x, p); p += x.length; });
  return out;
};
P.readFile = function (e) { return e.t ? this.readChain(e.t, e.s) : new Uint8Array(0); };

/* ---------- allocazione ---------- */
P.isReserved = function (t) { return this.fmt.reserved.indexOf(t) >= 0; };
P.trackOrder = function (startT) {
  var dt = this.fmt.dirTrack, max = this.dosTracks(), out = [], t;
  if (this.fmt.id === 'd71') {
    // la 1571 riempie prima il lato 1 e poi il lato 2, partendo sempre vicino alla traccia 18
    for (var d = 1; d < 35; d++) { if (dt - d >= 1) out.push(dt - d); if (dt + d <= 35) out.push(dt + d); }
    for (t = 36; t <= 70; t++) if (t !== 53) out.push(t);
    return out;
  }
  if (!startT) {
    for (var k = 1; k < max; k++) { if (dt - k >= 1) out.push(dt - k); if (dt + k <= max) out.push(dt + k); }
    return out;
  }
  var dir = startT < dt ? -1 : 1;
  for (t = startT; t >= 1 && t <= max; t += dir) if (!this.isReserved(t)) out.push(t);
  for (t = dt - dir; t >= 1 && t <= max; t -= dir) if (!this.isReserved(t)) out.push(t);
  return out;
};
P.allocate = function (n) {
  if (this.blocksFree() < n) throw DiskError(72, 'DISK FULL');
  var out = [], order = this.trackOrder(), cur = null, il = this.fmt.fileIl;
  for (var i = 0; i < n; i++) {
    var got = null, tracks = cur ? this.trackOrder(cur[0]) : order;
    for (var k = 0; k < tracks.length && !got; k++) {
      var t = tracks[k], spt = this.fmt.spt(t);
      if (this.isReserved(t) || this.trackFree(t) === 0) continue;
      var start = cur && cur[0] === t ? (cur[1] + il) % spt : (cur ? (cur[1] + il) % spt : 0);
      for (var j = 0; j < spt; j++) {
        var s = (start + j) % spt;
        if (this.isFree(t, s)) { got = [t, s]; break; }
      }
    }
    if (!got) throw DiskError(72, 'DISK FULL');
    this.setFree(got[0], got[1], false); out.push(got); cur = got;
  }
  return out;
};
// nuovo blocco di directory sulla traccia della directory
P.newDirSector = function (lastT, lastS) {
  var t = this.fmt.dirTrack, spt = this.fmt.spt(t);
  for (var j = 1; j <= spt; j++) {
    var s = (lastS + this.fmt.dirIl * j) % spt;
    if (this.isFree(t, s)) {
      this.setFree(t, s, false);
      var nb = this.block(t, s); nb.fill(0); nb[1] = 0xFF;
      var lb = this.block(lastT, lastS); lb[0] = t; lb[1] = s;
      return [t, s];
    }
  }
  throw DiskError(72, 'DISK FULL');
};
P.freeSlot = function () {
  var e = this.entries(true);
  for (var i = 0; i < e.length; i++) if (e[i].empty) return e[i];
  var secs = this.dirSectors(), last = secs[secs.length - 1], ns = this.newDirSector(last[0], last[1]);
  return {dt: ns[0], ds: ns[1], di: 0};
};

/* ---------- scrittura ---------- */
P.writeFile = function (nameBytes, data, type, opts) {
  opts = opts || {};
  type = type || 2;
  if (!nameBytes.length) throw DiskError(34, 'SYNTAX ERROR');
  for (var q = 0; q < nameBytes.length; q++) if (nameBytes[q] === 0x2A || nameBytes[q] === 0x3F) throw DiskError(33, 'SYNTAX ERROR');
  var old = this.findExact(nameBytes);
  if (old) { if (opts.replace) this.scratchEntry(old); else throw DiskError(63, 'FILE EXISTS'); }
  var nBlocks = Math.max(1, Math.ceil(data.length / 254));
  if (this.blocksFree() < nBlocks) throw DiskError(72, 'DISK FULL');
  var slot = this.freeSlot();
  var secs = this.allocate(nBlocks);
  for (var i = 0; i < secs.length; i++) {
    var b = this.block(secs[i][0], secs[i][1]), part = data.subarray(i * 254, i * 254 + 254);
    b.fill(0);
    if (i < secs.length - 1) { b[0] = secs[i + 1][0]; b[1] = secs[i + 1][1]; }
    else { b[0] = 0; b[1] = part.length + 1; }
    b.set(part, 2);
  }
  var o = this.off(slot.dt, slot.ds) + slot.di * 32, blk = this.data;
  for (var k = 2; k < 32; k++) blk[o + k] = 0;
  blk[o + 2] = 0x80 | type; blk[o + 3] = secs[0][0]; blk[o + 4] = secs[0][1];
  blk.set(pad16(nameBytes), o + 5);
  blk[o + 30] = nBlocks & 255; blk[o + 31] = nBlocks >> 8;
  return nBlocks;
};

// separatore: voce DEL da 0 blocchi che punta al primo blocco della directory (vedi Drive.addSeparator)
P.addSeparator = function (nameBytes, locked) {
  var slot = this.freeSlot(), o = this.off(slot.dt, slot.ds) + slot.di * 32, b = this.data;
  for (var k = 2; k < 32; k++) b[o + k] = 0;
  b[o + 2] = locked ? 0xC0 : 0x80; b[o + 3] = this.fmt.dirStart[0]; b[o + 4] = this.fmt.dirStart[1];
  b.set(pad16(nameBytes), o + 5);
};
P.removeEntry = function (e) { this.data[this.entryOffset(e) + 2] = 0; };

/* ---------- cancellazione, rinomina, validazione ---------- */
P.freeChainSafe = function (t, s) {
  var seen = {}, n = 0;
  while (t !== 0 && this.valid(t, s) && !seen[t + ':' + s] && n <= this.sectors) {
    seen[t + ':' + s] = 1; n++;
    this.setFree(t, s, true);
    var b = this.block(t, s); t = b[0]; s = b[1];
  }
};
P.scratchEntry = function (e) {
  if (e.t) this.freeChainSafe(e.t, e.s);
  if (e.type === 4 && e.sideT) this.freeChainSafe(e.sideT, e.sideS);
  this.data[this.entryOffset(e) + 2] = 0;
};
// S:modello1,modello2 → numero di file cancellati (i file protetti con "<" restano)
P.scratch = function (patterns) {
  var n = 0, self = this;
  patterns.forEach(function (pat) {
    self.files().forEach(function (e) {
      if (!e.locked && wildMatch(pat, e.name)) { self.scratchEntry(e); n++; }
    });
  });
  return n;
};
P.rename = function (newName, oldName) {
  if (!newName.length || !oldName.length) throw DiskError(34, 'SYNTAX ERROR');
  if (this.findExact(newName)) throw DiskError(63, 'FILE EXISTS');
  var e = this.find(oldName, 0) || null;
  if (!e) { var all = this.files(); for (var i = 0; i < all.length; i++) if (wildMatch(oldName, all[i].name)) { e = all[i]; break; } }
  if (!e) throw DiskError(62, 'FILE NOT FOUND');
  this.data.set(pad16(newName), this.entryOffset(e) + 5);
};
// V: ricostruisce la BAM dalla directory e toglie i file non chiusi ("*PRG")
P.validate = function () {
  var self = this, max = this.dosTracks(), t, s, removed = 0;
  for (t = 1; t <= max; t++) for (s = 0; s < this.fmt.spt(t); s++) this.setFree(t, s, true);
  if (this.fmt.id === 'd81') { for (s = 0; s < 3; s++) this.setFree(40, s, false); }
  else { this.setFree(18, 0, false); if (this.fmt.id === 'd71') for (s = 0; s < this.fmt.spt(53); s++) this.setFree(53, s, false); }
  this.dirSectors().forEach(function (x) { self.setFree(x[0], x[1], false); });
  var mark = function (t, s) {
    var seen = {}, n = 0;
    while (t !== 0 && self.valid(t, s) && !seen[t + ':' + s] && n <= self.sectors) {
      seen[t + ':' + s] = 1; n++; self.setFree(t, s, false);
      var b = self.block(t, s); t = b[0]; s = b[1];
    }
  };
  this.files().forEach(function (e) {
    if (!e.closed) { self.data[self.entryOffset(e) + 2] = 0; removed++; return; }
    if (e.t) mark(e.t, e.s);
    if (e.type === 4 && e.sideT) mark(e.sideT, e.sideS);
  });
  return removed;
};
P.copyFile = function (newName, oldNames) {
  var parts = [], type = 0, self = this;
  oldNames.forEach(function (n) {
    var e = self.find(n, 0);
    if (!e) throw DiskError(62, 'FILE NOT FOUND');
    type = type || e.type; parts.push(self.readFile(e));
  });
  var len = parts.reduce(function (a, p) { return a + p.length; }, 0), all = new Uint8Array(len), p = 0;
  parts.forEach(function (x) { all.set(x, p); p += x.length; });
  return this.writeFile(newName, all, type || 2);
};

/* ---------- directory come programma BASIC (quello che il drive manda con LOAD"$",8) ---------- */
P.dirProgram = function (patBytes) {
  var h = this.headerInfo(), out = [0x01, 0x04], addr = 0x0401;
  function line(num, text) {
    var len = 2 + 2 + text.length + 1, next = addr + len;
    out.push(next & 255, next >> 8, num & 255, num >> 8);
    for (var i = 0; i < text.length; i++) out.push(text[i]);
    out.push(0); addr = next;
  }
  var raw = h.raw.slice(0, 16).map(function (b) { return b === 0xA0 ? 0x20 : b; });
  var hdr = [0x12, 0x22].concat(raw, [0x22, 0x20, h.raw[18], h.raw[19], 0x20, h.raw[21], h.raw[22]]);
  line(0, hdr);
  this.files().forEach(function (e) {
    if (patBytes && patBytes.length && !wildMatch(patBytes, e.name)) return;
    var t = [], sp = e.blocks < 10 ? 3 : e.blocks < 100 ? 2 : e.blocks < 1000 ? 1 : 0, i;
    for (i = 0; i < sp; i++) t.push(0x20);
    t.push(0x22); t = t.concat(e.name); t.push(0x22);
    for (i = e.name.length; i < 16; i++) t.push(0x20);
    t.push(e.closed ? 0x20 : 0x2A);
    t = t.concat(strToPet(e.typeName));
    t.push(e.locked ? 0x3C : 0x20);
    while (t.length < 27) t.push(0x20);
    line(e.blocks, t);
  });
  var foot = strToPet('BLOCKS FREE.');
  while (foot.length < 25) foot.push(0x20);
  line(this.blocksFree(), foot);
  out.push(0, 0);
  return new Uint8Array(out);
};

/* ---------- lettura di una directory in formato BASIC (dal drive vero o simulato) ---------- */
function parseDirProgram(bytes) {
  var res = {name: [], id: [], files: [], free: null, ok: false}, p = 2, guard = 0;
  while (p + 2 <= bytes.length && guard++ < 2000) {
    var link = bytes[p] | (bytes[p + 1] << 8);
    if (link === 0) { res.ok = true; break; }
    if (p + 4 > bytes.length) break;
    var num = bytes[p + 2] | (bytes[p + 3] << 8), q = p + 4, text = [];
    while (q < bytes.length && bytes[q] !== 0) text.push(bytes[q++]);
    p = q + 1;
    var q1 = text.indexOf(0x22), q2 = q1 >= 0 ? text.indexOf(0x22, q1 + 1) : -1;
    if (text.indexOf(0x12) >= 0 && res.files.length === 0 && q2 > 0) {
      res.name = text.slice(q1 + 1, q2);
      while (res.name.length && res.name[res.name.length - 1] === 0x20) res.name.pop();
      res.id = text.slice(q2 + 1).filter(function (b) { return b !== 0x20; });
      var it = text.slice(q2 + 1); while (it.length && it[0] === 0x20) it.shift(); while (it.length && it[it.length - 1] === 0x20) it.pop();
      res.idText = it;
    } else if (q2 > 0) {
      var rest = text.slice(q2 + 1), r = 0;
      while (r < rest.length && rest[r] === 0x20) r++;
      var splat = rest[r] === 0x2A; if (splat) r++;
      var tn = petToStr(rest.slice(r, r + 3));
      res.files.push({name: text.slice(q1 + 1, q2), blocks: num, typeName: tn, type: TYPES.indexOf(tn), closed: !splat, locked: rest[r + 3] === 0x3C});
    } else if (/BLOCKS FREE/.test(petToStr(text))) res.free = num;
    if (p >= bytes.length) { res.ok = true; break; }
  }
  return res;
}

/* ---------- BASIC V2: elenco di un programma ---------- */
var TOKENS = ['END','FOR','NEXT','DATA','INPUT#','INPUT','DIM','READ','LET','GOTO','RUN','IF','RESTORE','GOSUB','RETURN','REM','STOP','ON','WAIT','LOAD','SAVE','VERIFY','DEF','POKE','PRINT#','PRINT','CONT','LIST','CLR','CMD','SYS','OPEN','CLOSE','GET','NEW','TAB(','TO','FN','SPC(','THEN','NOT','STEP','+','-','*','/','↑','AND','OR','>','=','<','SGN','INT','ABS','USR','FRE','POS','SQR','RND','LOG','EXP','COS','SIN','TAN','ATN','PEEK','LEN','STR$','VAL','ASC','CHR$','LEFT$','RIGHT$','MID$','GO'];
var CTRL = {0x05:'{wht}',0x0D:'{return}',0x0E:'{lower}',0x11:'{down}',0x12:'{rvon}',0x13:'{home}',0x14:'{del}',0x1C:'{red}',0x1D:'{rght}',0x1E:'{grn}',0x1F:'{blu}',
  0x81:'{orng}',0x8E:'{upper}',0x90:'{blk}',0x91:'{up}',0x92:'{rvof}',0x93:'{clr}',0x94:'{inst}',0x95:'{brn}',0x96:'{lred}',0x97:'{gry1}',0x98:'{gry2}',0x99:'{lgrn}',0x9A:'{lblu}',0x9B:'{gry3}',0x9C:'{pur}',0x9D:'{left}',0x9E:'{yel}',0x9F:'{cyn}'};
function basicList(prg, maxLines) {
  if (prg.length < 4) return null;
  var load = prg[0] | (prg[1] << 8), p = 2, addr = load, lines = [], guard = 0;
  maxLines = maxLines || 2000;
  while (p + 2 <= prg.length && guard++ < maxLines) {
    var link = prg[p] | (prg[p + 1] << 8);
    if (link === 0) return lines.length ? {load: load, lines: lines, end: p + 2} : null;
    if (p + 4 > prg.length) break;
    var num = prg[p + 2] | (prg[p + 3] << 8), q = p + 4, s = '', quote = false, rem = false, sys = false;
    while (q < prg.length && prg[q] !== 0) {
      var b = prg[q++];
      if (b === 0x9E && !quote) sys = true;
      if (b === 0x22) quote = !quote;
      if (!quote && !rem && b >= 0x80 && b <= 0xCB) { s += TOKENS[b - 0x80]; if (b === 0x8F) rem = true; }
      else if (b === 0xFF && !quote) s += 'π';
      else if (CTRL[b] && (quote || rem)) s += CTRL[b];
      else if (b < 0x20 || (b >= 0x80 && b < 0xA0)) s += '{$' + b.toString(16).padStart(2, '0') + '}';
      else s += petChar(b);
    }
    if (q >= prg.length) break;
    lines.push(num + ' ' + s);
    var next = addr + (q + 1 - p);
    p = q + 1;
    // il puntatore deve indicare la riga seguente: se non torna, dopo c'è codice macchina (programmi con SYS)
    if (link !== next) {
      // alla prima riga accettiamo un puntatore sbagliato solo se c'è SYS (programmi compressi con una riga di avvio)
      if (lines.length === 1 && !sys) return null;
      return {load: load, lines: lines, end: p, partial: true};
    }
    addr = next;
  }
  return lines.length ? {load: load, lines: lines, end: p, partial: true} : null;
}
// tokenizzazione minima, per creare il disco dimostrativo
function basicTokenize(lines, load) {
  load = load || 0x0801;
  var out = [load & 255, load >> 8], addr = load;
  lines.forEach(function (l) {
    var m = /^(\d+)\s*(.*)$/.exec(l), num = +m[1], src = m[2], body = [], i = 0, quote = false;
    while (i < src.length) {
      var c = src[i];
      if (c === '"') { quote = !quote; body.push(0x22); i++; continue; }
      if (!quote) {
        var tok = -1, best = 0;
        for (var k = 0; k < TOKENS.length; k++) {
          var t = TOKENS[k];
          if (t.length > best && src.substr(i, t.length).toUpperCase() === t) { tok = k; best = t.length; }
        }
        if (tok >= 0) { body.push(0x80 + tok); i += best; if (tok === 0x0F) { body = body.concat(strToPet(src.slice(i))); i = src.length; } continue; }
      }
      body = body.concat(strToPet(c)); i++;
    }
    var len = 4 + body.length + 1, next = addr + len;
    out.push(next & 255, next >> 8, num & 255, num >> 8);
    out = out.concat(body); out.push(0); addr = next;
  });
  out.push(0, 0);
  return new Uint8Array(out);
}

/* ---------- file P00 (PC64): nome originale nell'intestazione ---------- */
function parseP00(bytes) {
  var sig = 'C64File';
  for (var i = 0; i < 7; i++) if (bytes[i] !== sig.charCodeAt(i)) return null;
  var nm = Array.prototype.slice.call(bytes, 8, 24);
  var z = nm.indexOf(0); if (z >= 0) nm = nm.slice(0, z);
  return {name: nm, data: bytes.slice(26)};
}

RF.Disk = Disk;
RF.DiskError = DiskError;
RF.pet = {toStr: petToStr, char: petChar, fromStr: strToPet, fromPcName: pcNameToC64, toPcName: c64NameToPc, eq: bytesEq, match: wildMatch};
RF.parseDirProgram = parseDirProgram;
RF.basicList = basicList;
RF.basicTokenize = basicTokenize;
RF.parseP00 = parseP00;
RF.FILE_TYPES = TYPES;
})(window.RFFloppy = window.RFFloppy || {});
