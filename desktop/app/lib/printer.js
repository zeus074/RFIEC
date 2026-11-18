/* copiato da floppy-web/src/printer.js da build.py: non modificare qui */
/* RetroFixer · Stampante Commodore
 * Mps:       emulatore di una stampante ad aghi su carta a modulo continuo. Tre modelli:
 *            'mps'   Commodore MPS-801 / MPS-803 / 1525 (testo PETSCII, grafica a 7 aghi, 60×72 punti per pollice);
 *            'epson' Epson FX a 8 aghi (comandi ESC/P, grafica da 60 a 240 punti per pollice, nastro a colori JX);
 *            'nec'   NEC Pinwriter P a 24 aghi (ESC/P a 24 aghi, fino a 360×180 punti per pollice).
 * PaperView: disegna i fogli su canvas (schermo) e li esporta in PDF (immagini JPEG, PDF scritto a mano).
 * Il carattere a 5×7 punti e i simboli grafici sono disegnati qui da zero (non è la ROM della stampante).
 */
(function (RF) {
'use strict';

var COLS = 80, CELL = 6, W = COLS * CELL;      // 480 punti per riga, 60 punti per pollice
var DPI_X = 60, DPI_Y = 72;                     // passo orizzontale e verticale degli aghi
var PAGE_H = 11 * DPI_Y;                        // foglio da 11 pollici (modulo continuo)
var LINE = 12, GLINE = 7;                       // avanzamento carta: testo 1/6", grafica 7 punti
var TOP = 36;                                   // prima riga a mezzo pollice dal bordo

/* ---------------- carattere 5×7 ---------------- */
var G = {};
function def(ch, rows) { G[ch] = rows.split('|').map(function (r) { var m = 0; for (var i = 0; i < 5; i++) if (r[i] === '#') m |= 1 << i; return m; }); }
[
  [' ', '     |     |     |     |     |     |     '], ['!', '  #  |  #  |  #  |  #  |  #  |     |  #  '],
  ['"', ' # # | # # |     |     |     |     |     '], ['#', ' # # | # # |#####| # # |#####| # # | # # '],
  ['$', '  #  | ####|# #  | ### |  # #|#### |  #  '], ['%', '##   |##  #|   # |  #  | #   |#  ##|   ##'],
  ['&', ' ##  |#  # |# #  | #   |# # #|#  # | ## #'], ["'", '  #  |  #  | #   |     |     |     |     '],
  ['(', '   # |  #  | #   | #   | #   |  #  |   # '], [')', ' #   |  #  |   # |   # |   # |  #  | #   '],
  ['*', '     |  #  |# # #| ### |# # #|  #  |     '], ['+', '     |  #  |  #  |#####|  #  |  #  |     '],
  [',', '     |     |     |     |  #  |  #  | #   '], ['-', '     |     |     |#####|     |     |     '],
  ['.', '     |     |     |     |     | ##  | ##  '], ['/', '     |    #|   # |  #  | #   |#    |     '],
  ['0', ' ### |#   #|#  ##|# # #|##  #|#   #| ### '], ['1', '  #  | ##  |  #  |  #  |  #  |  #  | ### '],
  ['2', ' ### |#   #|    #|   # |  #  | #   |#####'], ['3', '#####|   # |  #  |   # |    #|#   #| ### '],
  ['4', '   # |  ## | # # |#  # |#####|   # |   # '], ['5', '#####|#    |#### |    #|    #|#   #| ### '],
  ['6', '  ## | #   |#    |#### |#   #|#   #| ### '], ['7', '#####|    #|   # |  #  | #   | #   | #   '],
  ['8', ' ### |#   #|#   #| ### |#   #|#   #| ### '], ['9', ' ### |#   #|#   #| ####|    #|   # | ##  '],
  [':', '     | ##  | ##  |     | ##  | ##  |     '], [';', '     | ##  | ##  |     | ##  |  #  | #   '],
  ['<', '   # |  #  | #   |#    | #   |  #  |   # '], ['=', '     |     |#####|     |#####|     |     '],
  ['>', ' #   |  #  |   # |    #|   # |  #  | #   '], ['?', ' ### |#   #|    #|   # |  #  |     |  #  '],
  ['@', ' ### |#   #|    #| ## #|# # #|# # #| ### '],
  ['A', ' ### |#   #|#   #|#####|#   #|#   #|#   #'], ['B', '#### |#   #|#   #|#### |#   #|#   #|#### '],
  ['C', ' ### |#   #|#    |#    |#    |#   #| ### '], ['D', '###  |#  # |#   #|#   #|#   #|#  # |###  '],
  ['E', '#####|#    |#    |#### |#    |#    |#####'], ['F', '#####|#    |#    |#### |#    |#    |#    '],
  ['G', ' ### |#   #|#    |# ###|#   #|#   #| ####'], ['H', '#   #|#   #|#   #|#####|#   #|#   #|#   #'],
  ['I', ' ### |  #  |  #  |  #  |  #  |  #  | ### '], ['J', '  ###|   # |   # |   # |   # |#  # | ##  '],
  ['K', '#   #|#  # |# #  |##   |# #  |#  # |#   #'], ['L', '#    |#    |#    |#    |#    |#    |#####'],
  ['M', '#   #|## ##|# # #|# # #|#   #|#   #|#   #'], ['N', '#   #|#   #|##  #|# # #|#  ##|#   #|#   #'],
  ['O', ' ### |#   #|#   #|#   #|#   #|#   #| ### '], ['P', '#### |#   #|#   #|#### |#    |#    |#    '],
  ['Q', ' ### |#   #|#   #|#   #|# # #|#  # | ## #'], ['R', '#### |#   #|#   #|#### |# #  |#  # |#   #'],
  ['S', ' ####|#    |#    | ### |    #|    #|#### '], ['T', '#####|  #  |  #  |  #  |  #  |  #  |  #  '],
  ['U', '#   #|#   #|#   #|#   #|#   #|#   #| ### '], ['V', '#   #|#   #|#   #|#   #|#   #| # # |  #  '],
  ['W', '#   #|#   #|#   #|# # #|# # #|# # #| # # '], ['X', '#   #|#   #| # # |  #  | # # |#   #|#   #'],
  ['Y', '#   #|#   #| # # |  #  |  #  |  #  |  #  '], ['Z', '#####|    #|   # |  #  | #   |#    |#####'],
  ['[', ' ### | #   | #   | #   | #   | #   | ### '], ['£', '  ## | #  #| #   |###  | #   | #   |#####'],
  [']', ' ### |   # |   # |   # |   # |   # | ### '], ['↑', '  #  | ### |# # #|  #  |  #  |  #  |  #  '],
  ['←', '     |  #  | #   |#####| #   |  #  |     '],
  ['\\', '     |#    | #   |  #  |   # |    #|     '], ['^', '  #  | # # |#   #|     |     |     |     '],
  ['_', '     |     |     |     |     |     |#####'], ['`', ' #   |  #  |   # |     |     |     |     '],
  ['{', '   ##|  #  |  #  | #   |  #  |  #  |   ##'], ['|', '  #  |  #  |  #  |  #  |  #  |  #  |  #  '],
  ['}', '##   |  #  |  #  |   # |  #  |  #  |##   '], ['~', '     |     | #   |# # #|   # |     |     '],
  ['a', '     |     | ### |    #| ####|#   #| ####'], ['b', '#    |#    |# ## |##  #|#   #|#   #|#### '],
  ['c', '     |     | ### |#    |#    |#   #| ### '], ['d', '    #|    #| ## #|#  ##|#   #|#   #| ####'],
  ['e', '     |     | ### |#   #|#####|#    | ### '], ['f', '  ## | #  #| #   |###  | #   | #   | #   '],
  ['g', '     |     | ####|#   #| ####|    #| ### '], ['h', '#    |#    |# ## |##  #|#   #|#   #|#   #'],
  ['i', '  #  |     | ##  |  #  |  #  |  #  | ### '], ['j', '   # |     |  ## |   # |   # |#  # | ##  '],
  ['k', '#    |#    |#  # |# #  |##   |# #  |#  # '], ['l', ' ##  |  #  |  #  |  #  |  #  |  #  | ### '],
  ['m', '     |     |## # |# # #|# # #|#   #|#   #'], ['n', '     |     |# ## |##  #|#   #|#   #|#   #'],
  ['o', '     |     | ### |#   #|#   #|#   #| ### '], ['p', '     |     |#### |#   #|#### |#    |#    '],
  ['q', '     |     | ####|#   #| ####|    #|    #'], ['r', '     |     |# ## |##  #|#    |#    |#    '],
  ['s', '     |     | ####|#    | ### |    #|#### '], ['t', ' #   | #   |###  | #   | #   | #  #|  ## '],
  ['u', '     |     |#   #|#   #|#   #|#  ##| ## #'], ['v', '     |     |#   #|#   #|#   #| # # |  #  '],
  ['w', '     |     |#   #|#   #|# # #|# # #| # # '], ['x', '     |     |#   #| # # |  #  | # # |#   #'],
  ['y', '     |     |#   #|#   #| ####|    #| ### '], ['z', '     |     |#####|   # |  #  | #   |#####'],
  // simboli disegnati a mano (5 colonne)
  ['♠', '  #  | ### |#####|#####|  #  | ### |     '], ['♥', '     | # # |#####|#####| ### |  #  |     '],
  ['♣', '  #  | ### |  #  |## ##|## ##|  #  | ### '], ['♦', '  #  | ### |#####|#####| ### |  #  |     '],
  ['●', '     | ### |#####|#####|#####| ### |     '], ['○', '     | ### |#   #|#   #|#   #| ### |     '],
  ['π', '     |#####| # # | # # | # # | #  #|     '], ['✓', '     |    #|    #|   # |#  # | # # |  #  ']
].forEach(function (g) { def(g[0], g[1]); });

// simboli grafici PETSCII a tutta cella (6×7, si toccano tra un carattere e l'altro): f(x, y) → punto acceso
function H(r) { return function (x, y) { return y === r; }; }
function V(c) { return function (x, y) { return x === c; }; }
function or() { var f = arguments; return function (x, y) { for (var i = 0; i < f.length; i++) if (f[i](x, y)) return true; return false; }; }
function and(a, b) { return function (x, y) { return a(x, y) && b(x, y); }; }
var MID_X = 2, MID_Y = 3;
var GFX = {
  0x60: H(3), 0x62: V(MID_X), 0x63: H(3), 0x64: H(2), 0x65: H(1), 0x66: H(4), 0x67: V(1), 0x68: V(4),
  0x69: or(function (x, y) { return y === MID_Y && x < MID_X; }, function (x, y) { return x === MID_X && y > MID_Y; }),
  0x6A: or(function (x, y) { return x === MID_X && y < MID_Y; }, function (x, y) { return y === MID_Y && x > MID_X; }),
  0x6B: or(function (x, y) { return x === MID_X && y < MID_Y; }, function (x, y) { return y === MID_Y && x < MID_X; }),
  0x6C: or(V(0), H(6)), 0x6D: function (x, y) { return x === Math.round(y * 5 / 6); }, 0x6E: function (x, y) { return x === 5 - Math.round(y * 5 / 6); },
  0x6F: or(V(0), H(0)), 0x70: or(V(5), H(0)), 0x72: H(5), 0x74: V(0),
  0x75: or(function (x, y) { return y === MID_Y && x > MID_X; }, function (x, y) { return x === MID_X && y > MID_Y; }),
  0x76: function (x, y) { var d = Math.round(y * 5 / 6); return x === d || x === 5 - d; },
  0x79: V(5), 0x7B: or(H(MID_Y), V(MID_X)), 0x7C: function (x, y) { return x < 3 && (x + y) % 2 === 0; }, 0x7D: V(MID_X),
  0x7F: function (x, y) { return x * 7 >= y * 6; },
  0xA0: function () { return false; }, 0xA1: function (x) { return x < 3; }, 0xA2: function (x, y) { return y >= 4; },
  0xA3: H(0), 0xA4: H(6), 0xA5: V(0), 0xA6: function (x, y) { return (x + y) % 2 === 0; }, 0xA7: V(5),
  0xA8: function (x, y) { return y >= 4 && (x + y) % 2 === 0; }, 0xA9: function (x, y) { return x * 7 + y * 6 <= 35; },
  0xAA: function (x) { return x >= 4; }, 0xAB: or(V(MID_X), function (x, y) { return y === MID_Y && x > MID_X; }),
  0xAC: function (x, y) { return x >= 3 && y >= 4; }, 0xAD: or(function (x, y) { return x === MID_X && y <= MID_Y; }, function (x, y) { return y === MID_Y && x >= MID_X; }),
  0xAE: or(function (x, y) { return y === MID_Y && x <= MID_X; }, function (x, y) { return x === MID_X && y >= MID_Y; }),
  0xAF: function (x, y) { return y >= 5; },
  0xB0: or(function (x, y) { return y === MID_Y && x >= MID_X; }, function (x, y) { return x === MID_X && y >= MID_Y; }),
  0xB1: or(H(MID_Y), function (x, y) { return x === MID_X && y <= MID_Y; }), 0xB2: or(H(MID_Y), function (x, y) { return x === MID_X && y >= MID_Y; }),
  0xB3: or(V(MID_X), function (x, y) { return y === MID_Y && x < MID_X; }),
  0xB4: function (x) { return x <= 1; }, 0xB5: function (x) { return x <= 2; }, 0xB6: function (x) { return x >= 3; },
  0xB7: function (x, y) { return y <= 1; }, 0xB8: function (x, y) { return y <= 2; }, 0xB9: function (x, y) { return y >= 4; },
  0xBA: or(V(5), H(6)), 0xBB: function (x, y) { return x < 3 && y >= 4; }, 0xBC: function (x, y) { return x >= 3 && y <= 3; },
  0xBD: or(function (x, y) { return x === MID_X && y <= MID_Y; }, function (x, y) { return y === MID_Y && x <= MID_X; }),
  0xBE: function (x, y) { return x < 3 && y <= 3; }, 0xBF: function (x, y) { return (x < 3 && y <= 3) || (x >= 3 && y >= 4); }
};
var SYM = {0x61: '♠', 0x71: '●', 0x73: '♥', 0x77: '○', 0x78: '♣', 0x7A: '♦', 0x7E: 'π'};
// in minuscolo alcuni simboli cambiano
var GFX_LOWER = {0x7E: function (x, y) { return (x + y) % 2 === 0; }, 0x7F: function (x, y) { return (x + y) % 3 === 0; }, 0xA9: function (x, y) { return (x - y + 6) % 3 === 0; }};
var SYM_LOWER = {0xBA: '✓'};

var cache = {};
// colonne di punti (bit 0 = ago in alto) per un codice PETSCII: array di 6 byte, oppure null se non si stampa
function glyph(code, lower) {
  var key = (lower ? 'l' : 'u') + code;
  if (cache[key] !== undefined) return cache[key];
  var c = code, out = null;
  if (c >= 0xC0 && c <= 0xDF) c -= 0x60;
  else if (c >= 0xE0 && c <= 0xFE) c -= 0x40;
  else if (c === 0xFF) c = 0x7E;
  var ch = null, fn = null;
  if (c >= 0x20 && c <= 0x40) ch = String.fromCharCode(c);
  else if (c >= 0x41 && c <= 0x5A) ch = lower ? String.fromCharCode(c + 32) : String.fromCharCode(c);
  else if (c >= 0x5B && c <= 0x5F) ch = '[£]↑←'[c - 0x5B];
  else if (c >= 0x61 && c <= 0x7A && lower) ch = String.fromCharCode(c - 32);
  else if (lower && SYM_LOWER[c]) ch = SYM_LOWER[c];
  else if (lower && GFX_LOWER[c]) fn = GFX_LOWER[c];
  else if (SYM[c]) ch = SYM[c];
  else if (GFX[c]) fn = GFX[c];
  if (ch && G[ch]) {
    var rows = G[ch];
    out = [0, 0, 0, 0, 0, 0];
    for (var y = 0; y < 7; y++) for (var x = 0; x < 5; x++) if (rows[y] & (1 << x)) out[x] |= 1 << y;
  } else if (fn) {
    out = [0, 0, 0, 0, 0, 0];
    for (var yy = 0; yy < 7; yy++) for (var xx = 0; xx < 6; xx++) if (fn(xx, yy)) out[xx] |= 1 << yy;
  }
  cache[key] = out;
  return out;
}

/* ---------------- la stampante ---------------- */
// dpiX/dpiY: griglia dei punti; needle: diametro dell'ago in pollici; lineDots: punti di una riga di 8 pollici
var MODELS = {
  mps: {name: 'Commodore MPS-803', dpiX: 60, dpiY: 72, needle: 1 / 62},
  epson: {name: 'Epson FX (8 aghi)', dpiX: 240, dpiY: 216, needle: 1 / 75},
  nec: {name: 'NEC P (24 aghi)', dpiX: 360, dpiY: 180, needle: 1 / 120}   // ago da 0,2 mm
};
function Mps(opts) {
  opts = opts || {};
  this.onChange = function () {};
  this.setModel(opts.model || 'mps', true);
  this.onChange = opts.onChange || function () {};
}
var M = Mps.prototype;
// cambiare stampante vuol dire carta nuova (la griglia dei punti è diversa)
M.setModel = function (model, quiet) {
  var g = MODELS[model] || MODELS.mps;
  this.model = MODELS[model] ? model : 'mps';
  this.dpiX = g.dpiX; this.dpiY = g.dpiY; this.needle = g.needle;
  this.W = 8 * g.dpiX; this.H = 11 * g.dpiY; this.top = g.dpiY / 2;
  this.clear(quiet);
};
M.clear = function () {
  this.pages = [];      // Uint8Array(W * H) per foglio, creati quando servono
  var TOP = this.top;
  this.y = TOP; this.x = 0; this.maxY = TOP;
  this.lower = false; this.saLower = false; this.dbl = false; this.rvs = false; this.gfx = false;
  this.pend = null;     // comando a più byte in corso (POS, ripetizione, ESC)
  this.raster = null;   // immagine a colori in arrivo (ESC "C")
  this.escInit();
  this.raw = []; this.rawSa = -1; this.used = false; this.chars = 0;
  this.dirty = {from: Infinity, to: -1};
  this.onChange(this);
};
M.page = function (n) {
  while (this.pages.length <= n) this.pages.push(new Uint8Array(this.W * this.H));
  return this.pages[n];
};
/* v: 1 = inchiostro nero, 2 + n = colore n del C64 (immagini a colori),
 * 0x20 | m = nastro a colori Epson: m è la somma dei passaggi (1 nero, 2 magenta, 4 ciano, 8 giallo) */
M.dot = function (x, y, v) {
  x = Math.round(x);
  if (x < 0 || x >= this.W || y < 0) return;
  var p = this.page(Math.floor(y / this.H)), i = (y % this.H) * this.W + x, cur = p[i];
  v = v || 1;
  if ((v & 0x20) && (cur & 0x20)) v |= cur;   // un colore sopra l'altro si mescola
  p[i] = v;
  if (y < this.dirty.from) this.dirty.from = y;
  if (y > this.dirty.to) this.dirty.to = y;
};
// una colonna di 7 aghi alla posizione della testina
M.column = function (bits) {
  var reps = this.dbl ? 2 : 1;
  for (var r = 0; r < reps; r++) {
    if (this.x >= this.W) this.newLine();
    for (var b = 0; b < 7; b++) if (bits & (1 << b)) this.dot(this.x, this.y + b);
    this.x++;
  }
  this.used = true;
  if (this.y + 7 > this.maxY) this.maxY = this.y + 7;
};
M.newLine = function (step) {
  this.x = 0;
  this.y += step || (this.gfx ? GLINE : LINE);
  if (this.y + 7 > this.maxY) this.maxY = this.y + 7;
};
M.char = function (code) {
  var g = glyph(code, this.lower);
  if (!g) return;
  if (this.x + CELL * (this.dbl ? 2 : 1) > this.W) this.newLine();
  for (var i = 0; i < CELL; i++) this.column(this.rvs ? (~g[i]) & 0x7F : g[i]);
  this.chars++;
};
// LISTEN con indirizzo secondario: 7 = minuscole (modo "business"), gli altri maiuscole e grafica
M.listen = function (sec) {
  var sa = sec & 15;
  // un'immagine a colori interrotta (STOP sul C64) finisce quando comincia un altro lavoro
  if (this.raster && ((sec & 0xF0) === 0xF0 || (sec & 0xF0) === 0xE0 || sa !== this.raster.sa)) this.endRaster();
  if ((sec & 0xF0) === 0x60 || (sec & 0xF0) === 0xF0) { this.sa = sa; this.saLower = sa === 7; this.lower = this.saLower; }
};
M.unlisten = function () { this.flush(); };
// RESET del bus: modi di stampa normali, la testina torna a inizio riga
M.reset = function () {
  if (this.raster) this.endRaster();
  if (this.model !== 'mps') { this.escInit(); if (this.x) { this.x = 0; this.lineFeed(this.lf); } return; }
  this.lower = this.saLower = this.dbl = this.rvs = this.gfx = false; this.pend = null;
  if (this.x) this.newLine();
};
M.write = function (bytes) {
  // solo per la MPS: CHR$(17)/CHR$(145) ricordano nel .prn se il C64 stampava in minuscolo o in maiuscolo
  if (this.model === 'mps' && this.sa !== this.rawSa) { this.raw.push(this.sa === 7 ? 17 : 145); this.rawSa = this.sa; }
  for (var i = 0; i < bytes.length; i++) { this.raw.push(bytes[i]); this.feed(bytes[i]); }
  this.flush();
};
M.flush = function () {
  if (this.dirty.to >= 0) { var d = this.dirty; this.dirty = {from: Infinity, to: -1}; this.onChange(this, d); }
};
/* Immagine a colori, come la manda la Final Cartridge III nella copia dello schermo a colori:
 * ESC "C" + larghezza e altezza in tre cifre ciascuna ("320200"), poi un byte per pixel con il colore del C64 (0-15),
 * riga per riga. Occupa tutta la larghezza della carta; i pixel del C64 PAL sono un po' più alti che larghi. */
var PIXEL_ASPECT = 0.936;
M.startRaster = function (w, h) {
  var rows = Math.round(this.W / this.dpiX * (h / w) / PIXEL_ASPECT * this.dpiY);
  if (this.x) this.newLine();
  this.raster = {w: w, h: h, rows: rows, row: new Uint8Array(w), n: 0, r: 0, y0: this.y, sa: this.sa};
  this.used = true;
};
M.pixel = function (b) {
  var R = this.raster;
  R.row[R.n++] = b & 15;
  if (R.n < R.w) return;
  // riga di pixel completa: diventa le righe di punti corrispondenti
  var y1 = Math.floor(R.r * R.rows / R.h), y2 = Math.floor((R.r + 1) * R.rows / R.h);
  for (var y = y1; y < y2; y++) {
    for (var x = 0; x < this.W; x++) {
      var c = R.row[Math.floor(x * R.w / this.W)];
      if (c !== 1) this.dot(x, R.y0 + y, 2 + c);   // il bianco è la carta
    }
  }
  R.n = 0; R.r++;
  if (R.y0 + y2 + 1 > this.maxY) this.maxY = R.y0 + y2 + 1;
  if (R.r >= R.h) this.endRaster();
};
M.endRaster = function () {
  var R = this.raster;
  this.raster = null; this.x = 0;
  this.y = R.y0 + Math.floor(R.r * R.rows / R.h) + Math.round(this.dpiY / 12);
  if (this.y > this.maxY) this.maxY = this.y;
};
M.feed = function (b) {
  if (this.raster) { this.pixel(b); return; }
  if (this.model !== 'mps') { this.feedEsc(b); return; }
  var p = this.pend;
  if (p) {
    p.buf.push(b);
    if (p.buf.length < p.need) return;
    this.pend = null;
    if (p.k === 'pos') {
      var n = parseInt(String.fromCharCode(p.buf[0], p.buf[1]), 10);
      if (!isNaN(n) && n < COLS) this.x = n * CELL;
    } else if (p.k === 'dot') {
      var d = ((p.buf[0] & 1) << 8) | p.buf[1];
      if (d < this.W) this.x = d;
    } else if (p.k === 'esc') {
      if (b === 16) this.pend = {k: 'dot', need: 2, buf: []};
      else if (b === 67) this.pend = {k: 'rhdr', need: 6, buf: []};
    } else if (p.k === 'rhdr') {
      var t = String.fromCharCode.apply(null, p.buf), w = +t.slice(0, 3), h = +t.slice(3, 6);
      if (/^\d{6}$/.test(t) && w > 0 && h > 0) this.startRaster(w, h);
    } else if (p.k === 'rep') {
      var times = p.buf[0] || 256, bits = p.buf[1];
      if (bits & 0x80) for (var r = 0; r < times; r++) this.column(bits & 0x7F);
    }
    return;
  }
  // in grafica i byte da 128 in su sono colonne di punti (bit 0 = ago in alto)
  if (this.gfx && b >= 0x80) { this.column(b & 0x7F); return; }
  switch (b) {
    case 13: case 0x8D: this.newLine(); return;
    case 10: var keep = this.x; this.newLine(); this.x = keep; return;
    case 8: this.gfx = true; return;
    case 14: this.dbl = true; return;
    case 15: this.dbl = false; this.gfx = false; return;
    case 16: this.pend = {k: 'pos', need: 2, buf: []}; return;
    case 17: this.lower = true; return;
    case 145: this.lower = false; return;
    case 18: this.rvs = true; return;
    case 146: this.rvs = false; return;
    case 26: this.pend = {k: 'rep', need: 2, buf: []}; return;
    case 27: this.pend = {k: 'esc', need: 1, buf: []}; return;
  }
  this.char(b);
};
/* ---------------- Epson FX / NEC P (ESC/P) ---------------- */
// colori del nastro Epson JX con ESC r n: 0 nero, 1 magenta, 2 ciano, 3 viola, 4 giallo, 5 rosso, 6 verde
var RIBBON = [1, 2, 4, 6, 8, 10, 12];
// numero di parametri dei comandi ESC che non facciamo ma dobbiamo saltare
var ESC_ARGS = {'!': 1, '-': 1, '3': 1, 'A': 1, 'J': 1, 'j': 1, 'W': 1, 'S': 1, 'R': 1, 'l': 1, 'Q': 1, 'x': 1, 'k': 1, 'p': 1,
  'w': 1, 'N': 1, 'U': 1, 'r': 1, 'I': 1, 'm': 1, 's': 1, 't': 1, '/': 1, 'a': 1, 'i': 1, 'q': 1, '+': 1, 'X': 1, 'c': 2,
  '$': 2, '\\': 2, 'e': 2, 'f': 2, '?': 2, '%': 1, '&': 0, ':': 3, 'C': 1};
M.escInit = function () {
  this.lf = Math.round(this.dpiY / 6);    // interlinea 1/6"
  this.cpi = 10; this.wide = false; this.wideLine = false; this.cond = false; this.bold = false; this.ul = false;
  this.ink = 0x21; this.crPend = false; this.left = 0;
};
M.lineFeed = function (n) {
  this.y += n;
  if (this.y > this.maxY) this.maxY = this.y;
};
M.unit = function () { return this.model === 'nec' ? 180 : 216; };       // unità di ESC 3 e ESC J
M.charW = function () {
  var cpi = this.cond ? (this.cpi === 10 ? 17.14 : 20) : this.cpi;
  return this.dpiX / cpi * (this.wide || this.wideLine ? 2 : 1);
};
M.feedEsc = function (b) {
  var p = this.pend;
  if (p) {
    p.buf.push(b);
    if (p.until !== undefined ? b !== p.until : p.buf.length < p.need) return;
    this.pend = null;
    p.done.call(this, p.buf);
    return;
  }
  /* CR da solo: la testina torna a sinistra. Se dopo arriva subito del testo la carta avanza lo stesso, come con
   * le interfacce con "auto LF"; se arriva un comando ESC (per esempio un altro colore) è una ripassata sulla
   * stessa riga e la carta resta ferma. */
  if (this.crPend) {
    this.crPend = false;
    if (b === 10) { this.lineFeed(this.lf); this.wideLine = false; return; }
    if (b >= 32 && b !== 127) this.lineFeed(this.lf);
  }
  switch (b) {
    case 13: this.x = this.left; this.crPend = true; this.wideLine = false; return;
    case 10: this.lineFeed(this.lf); this.wideLine = false; return;
    case 12: this.y = (Math.floor((this.y - this.top) / this.H) + 1) * this.H + this.top; this.x = this.left; if (this.y > this.maxY) this.maxY = this.y; return;
    case 14: this.wideLine = true; return;
    case 20: this.wideLine = false; return;
    case 15: this.cond = true; return;
    case 18: this.cond = false; return;
    case 8: this.x = Math.max(0, this.x - this.charW()); return;
    case 9: var tw = this.dpiX / this.cpi * 8; this.x = (Math.floor(this.x / tw) + 1) * tw; return;
    case 27: this.pend = {need: 1, buf: [], done: this.escCmd}; return;
    case 28: this.pend = {need: 1, buf: [], done: this.fsCmd}; return;      // FS: comandi propri delle NEC P
  }
  if (b < 32 || b === 127 || (b >= 0x80 && b < 0xA0)) return;   // anche 128-159 sono codici di controllo
  this.textChar(b & 0x7F);
};
M.escCmd = function (buf) {
  var c = String.fromCharCode(buf[0]), self = this;
  function arg(n, f) { self.pend = {need: n, buf: [], done: f}; }
  switch (c) {
    case '@': this.escInit(); return;
    case '0': this.lf = Math.round(this.dpiY / 8); return;
    case '1': this.lf = Math.round(this.dpiY * 7 / 72); return;
    case '2': this.lf = Math.round(this.dpiY / 6); return;
    case '3': arg(1, function (a) { this.lf = Math.round(a[0] * this.dpiY / this.unit()); }); return;
    case '+': arg(1, function (a) { this.lf = Math.round(a[0] * this.dpiY / 360); }); return;
    case 'A': arg(1, function (a) { this.lf = Math.round(a[0] * this.dpiY / (this.model === 'nec' ? 60 : 72)); }); return;
    case 'J': arg(1, function (a) { this.lineFeed(Math.round(a[0] * this.dpiY / this.unit())); }); return;
    case 'E': this.bold = true; return;
    case 'F': this.bold = false; return;
    case 'M': this.cpi = 12; return;
    case 'P': this.cpi = 10; return;
    case 'g': this.cpi = 15; return;
    case 'W': arg(1, function (a) { this.wide = (a[0] & 1) === 1; }); return;
    case '-': arg(1, function (a) { this.ul = (a[0] & 1) === 1; }); return;
    case 'r': arg(1, function (a) { this.ink = 0x20 | (RIBBON[a[0] & 7] || 1); }); return;
    case '!': arg(1, function (a) { var m = a[0]; this.cpi = m & 1 ? 12 : 10; this.cond = !!(m & 4); this.bold = !!(m & 8); this.wide = !!(m & 32); this.ul = !!(m & 128); }); return;
    case '$': arg(2, function (a) { this.x = (a[0] + a[1] * 256) * this.dpiX / 60; }); return;
    case '\\': arg(2, function (a) { var n = a[0] + a[1] * 256; if (n > 32767) n -= 65536; this.x = Math.max(0, this.x + n * this.dpiX / (this.model === 'nec' ? 180 : 120)); }); return;
    case 'K': return this.gfxCmd(60, 1);
    case 'L': return this.gfxCmd(120, 1);
    case 'Y': return this.gfxCmd(120, 1);
    case 'Z': return this.gfxCmd(240, 1);
    case '*': arg(1, function (a) {
      var m = a[0], d8 = {0: 60, 1: 120, 2: 120, 3: 240, 4: 80, 5: 72, 6: 90, 7: 144}, d24 = {32: 60, 33: 120, 38: 90, 39: 180, 40: 360, 71: 180, 72: 360, 73: 360};
      if (d8[m]) this.gfxCmd(d8[m], 1); else if (d24[m]) this.gfxCmd(d24[m], 3); else this.gfxCmd(60, 1);
    }); return;
    case '^': arg(1, function (a) { this.gfxCmd(a[0] ? 120 : 60, 2); }); return;   // grafica a 9 aghi
    case 'C': arg(1, function (a) {
      // ESC C: lunghezza del foglio; con sei cifre ("320200") è la copia a colori della Final Cartridge III
      if (a[0] >= 0x30 && a[0] <= 0x39) { var first = a[0]; this.pend = {need: 5, buf: [], done: function (r) { var t = String.fromCharCode.apply(null, [first].concat(r)); if (/^\d{6}$/.test(t)) this.startRaster(+t.slice(0, 3), +t.slice(3)); }}; }
      else if (a[0] === 0) arg(1, function () {});
    }); return;
    case 'D': case 'B': this.pend = {until: 0, buf: [], done: function () {}}; return;
    case '(': arg(3, function (a) { var n = a[1] + a[2] * 256; if (n) this.pend = {need: n, buf: [], done: function () {}}; }); return;
    case 'x': arg(1, function () {}); return;
  }
  if (ESC_ARGS[c]) arg(ESC_ARGS[c], function () {});
};
/* FS (28): comandi delle NEC Pinwriter. FS 3 n = interlinea di n/360" (la Final Cartridge III lo usa nella copia
 * dello schermo: 47/360" ≈ 24 aghi); gli altri si saltano con i loro parametri. */
var FS_ARGS = {'E': 1, 'S': 1, 'r': 1, 'I': 1, 'V': 1, 'A': 1, 'F': 0, 'R': 0, 'Z': 0, 'x': 1, 'M': 1, 'C': 1};
M.fsCmd = function (buf) {
  var c = String.fromCharCode(buf[0]);
  if (c === '3') { this.pend = {need: 1, buf: [], done: function (a) { this.lf = Math.max(1, Math.round(a[0] * this.dpiY / 360)); }}; return; }
  if (FS_ARGS[c]) this.pend = {need: FS_ARGS[c], buf: [], done: function () {}};
};
// ESC K/L/Y/Z/*/^: n colonne (byte basso, byte alto) alla densità data, con 1, 2 o 3 byte per colonna
M.gfxCmd = function (dpi, bpc) {
  this.pend = {need: 2, buf: [], done: function (a) {
    var cols = a[0] + a[1] * 256;
    if (!cols) return;
    this.pend = {need: cols * bpc, buf: [], done: function (d) { this.gfxData(d, dpi, bpc); }};
  }};
};
M.gfxData = function (d, dpi, bpc) {
  var step = this.dpiX / dpi, pins = bpc === 1 ? 8 : bpc === 2 ? 9 : 24;
  // passo verticale degli aghi: 1/72" per gli 8 aghi Epson, 1/60" per gli 8 aghi NEC, 1/180" per i 24 aghi
  var pitch = bpc === 3 ? this.dpiY / 180 : this.model === 'nec' ? this.dpiY / 60 : this.dpiY / 72;
  for (var i = 0; i < d.length / bpc; i++) {
    for (var k = 0; k < pins; k++) {
      var byte = d[i * bpc + (k >> 3)], bit = 7 - (k & 7);
      if (bpc === 2 && k === 8) { byte = d[i * 2 + 1]; bit = 7; }
      if (byte & (1 << bit)) this.dot(this.x, this.y + Math.round(k * pitch), this.ink);
    }
    this.x += step;
  }
  this.used = true;
  var bottom = this.y + Math.round(pins * pitch);
  if (bottom > this.maxY) this.maxY = bottom;
};
// testo ASCII con il carattere 5×7: un punto per ago (Epson) o pieno come la qualità lettera (NEC)
M.textChar = function (b) {
  var cw = this.charW();
  if (this.x + cw > this.W + 0.5) { this.x = this.left; this.lineFeed(this.lf); }
  var ch = String.fromCharCode(b), rows = G[ch] || G['?'];
  var colW = cw / 6, rowH = this.dpiY / (this.model === 'nec' ? 60 : 72), solid = this.model === 'nec';
  for (var y = 0; y < 7; y++) for (var x = 0; x < 5; x++) {
    if (!(rows[y] & (1 << x))) continue;
    var px = this.x + x * colW, py = this.y + Math.round(y * rowH);
    if (solid) {
      for (var yy = 0; yy < Math.max(1, Math.round(rowH)); yy++) for (var xx = 0; xx < Math.max(1, Math.round(colW)); xx += 1) this.dot(px + xx, py + yy, this.ink);
    } else {
      this.dot(px, py, this.ink);
      if (this.wide || this.wideLine) this.dot(px + colW / 2, py, this.ink);
    }
    if (this.bold) this.dot(px + this.dpiX / 120, py, this.ink);
  }
  if (this.ul) for (var u = 0; u < cw; u += Math.max(1, this.dpiX / 120)) this.dot(this.x + u, this.y + Math.round(8 * rowH), this.ink);
  this.x += cw;
  this.chars++; this.used = true;
  var bottom = this.y + Math.round(9 * rowH);
  if (bottom > this.maxY) this.maxY = bottom;
};
// testo del PC → byte ASCII per Epson e NEC (le accentate come sulla macchina da scrivere)
function textToAscii(text, cols) {
  var out = [], pet = textToPet(text, true, cols || COLS);
  pet.forEach(function (c) {
    if (c === 13) out.push(13, 10);
    else if (c >= 0xC1 && c <= 0xDA) out.push(c - 0x80);
    else if (c >= 0x41 && c <= 0x5A) out.push(c + 0x20);
    else if (c === 0x5C) out.push(0x23);
    else if (c === 0xA4) out.push(0x5F);
    else if (c === 0x7D) out.push(0x7C);
    else out.push(c);
  });
  return out;
}
// immagine → grafica ESC/P: 8 aghi a 120 punti (ESC * 1, interlinea 24/216") o 24 aghi a 180 punti (ESC * 39, 24/180")
function imageToEsc(img, model, opts) {
  opts = opts || {};
  var w = img.width, h = img.height, ink = dither(img, opts), out = [27, 64], x, y, b;
  var pins = model === 'nec' ? 24 : 8, bpc = pins / 8, lineDots = model === 'nec' ? 1440 : 960;
  out.push(27, 51, 24);
  var left = Math.max(0, Math.floor((lineDots - w) / 2));
  for (y = 0; y < h; y += pins) {
    if (left) out.push(27, 36, Math.floor(left / (model === 'nec' ? 3 : 2)) & 255, Math.floor(left / (model === 'nec' ? 3 : 2)) >> 8);
    out.push(27, 42, model === 'nec' ? 39 : 1, w & 255, w >> 8);
    for (x = 0; x < w; x++) {
      for (b = 0; b < bpc; b++) {
        var v = 0;
        for (var k = 0; k < 8; k++) { var yy = y + b * 8 + k; if (yy < h && ink[yy * w + x]) v |= 0x80 >> k; }
        out.push(v);
      }
    }
    out.push(13, 10);
  }
  out.push(27, 50);
  return out;
}
RF.textToAscii = textToAscii;
RF.imageToEsc = imageToEsc;

// byte grezzi per il file .prn (con i codici 17/145 che ricordano minuscole e maiuscole)
M.rawBytes = function () { return new Uint8Array(this.raw); };
M.pageCount = function () { return this.used ? Math.floor((this.maxY - 1) / this.H) + 1 : 0; };
// stampa direttamente dei byte (anteprima di un testo o di un .prn)
M.print = function (bytes, sa) { this.listen(0x60 | (sa || 0)); this.write(bytes); this.unlisten(); };
RF.Mps = Mps;
RF.MPS = {COLS: COLS, CELL: CELL, W: W, PAGE_H: PAGE_H, DPI_X: DPI_X, DPI_Y: DPI_Y, LINE: LINE, GLINE: GLINE, glyph: glyph, MODELS: MODELS};

/* ---------------- testo e immagini → byte per la stampante ---------------- */
var ACC = {'à': "a'", 'á': "a'", 'â': 'a', 'ä': 'a', 'è': "e'", 'é': "e'", 'ê': 'e', 'ë': 'e', 'ì': "i'", 'í': "i'", 'î': 'i', 'ï': 'i',
  'ò': "o'", 'ó': "o'", 'ô': 'o', 'ö': 'o', 'ù': "u'", 'ú': "u'", 'û': 'u', 'ü': 'u', 'ç': 'c', 'ñ': 'n',
  'À': "A'", 'È': "E'", 'É': "E'", 'Ì': "I'", 'Ò': "O'", 'Ù': "U'", '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '€': 'EUR', '\t': '    '};
// testo del PC → PETSCII. lower: modo minuscole (indirizzo secondario 7). Le righe lunghe vanno a capo tra le parole.
function textToPet(text, lower, cols) {
  cols = cols || COLS;
  var out = [], lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  lines.forEach(function (line, li) {
    if (li) out.push(13);                    // a capo tra una riga e l'altra (non dopo l'ultima)
    var s = line.replace(/[^\x20-\x7E£\n]/g, function (c) { return ACC[c] !== undefined ? ACC[c] : '?'; });
    // a capo tra le parole
    var parts = [];
    while (s.length > cols) {
      var cut = s.lastIndexOf(' ', cols);
      if (cut < cols / 2) cut = cols;
      parts.push(s.slice(0, cut)); s = s.slice(cut).replace(/^ /, '');
    }
    parts.push(s);
    parts.forEach(function (p, pi) {
      if (pi) out.push(13);
      for (var i = 0; i < p.length; i++) {
        var c = p.charCodeAt(i), ch = p[i];
        if (ch === '£') out.push(0x5C);
        else if (c >= 0x61 && c <= 0x7A) out.push(lower ? c - 0x20 : c - 0x20);
        else if (c >= 0x41 && c <= 0x5A) out.push(lower ? c + 0x80 : c);
        else if (ch === '^') out.push(0x5E);
        else if (ch === '_') out.push(0xA4);
        else if (ch === '`') out.push(0x27);
        else if (ch === '{') out.push(0x28);
        else if (ch === '}') out.push(0x29);
        else if (ch === '|') out.push(0x7D);
        else if (ch === '~') out.push(0x2D);
        else if (ch === '\\') out.push(0x2F);
        else out.push(c);
      }
    });
  });
  return out;
}
// immagine (ImageData) → grafica a punti: bande da 7 righe, CHR$(8) all'inizio di ogni banda, CHR$(15) alla fine.
// Le serie di colonne uguali diventano CHR$(26) n colonna (ripetizione), per mandare meno byte.
function dither(img, opts) {
  var w = img.width, h = img.height, d = img.data, gray = new Float32Array(w * h), i, x, y;
  for (i = 0; i < w * h; i++) {
    var a = d[i * 4 + 3] / 255;
    gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) * a + 255 * (1 - a);
  }
  var thr = opts.threshold || 128, ink = new Uint8Array(w * h);
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    i = y * w + x;
    var old = gray[i], v = old < thr ? 0 : 255;
    ink[i] = v ? 0 : 1;
    if (opts.dither === false) continue;
    var e = old - v;
    if (x + 1 < w) gray[i + 1] += e * 7 / 16;
    if (y + 1 < h) { if (x > 0) gray[i + w - 1] += e * 3 / 16; gray[i + w] += e * 5 / 16; if (x + 1 < w) gray[i + w + 1] += e / 16; }
  }
  return ink;
}
function imageToBits(img, opts) {
  opts = opts || {};
  var w = img.width, h = img.height, ink = dither(img, opts), x, y;
  var out = [], left = Math.max(0, Math.floor(((opts.cols || W) - w) / 2));
  for (y = 0; y < h; y += 7) {
    var cols = [];
    for (x = 0; x < w; x++) {
      var bits = 0;
      for (var b = 0; b < 7 && y + b < h; b++) if (ink[(y + b) * w + x]) bits |= 1 << b;
      cols.push(0x80 | bits);
    }
    while (cols.length && cols[cols.length - 1] === 0x80) cols.pop();
    out.push(8);
    if (left && cols.length) out.push(27, 16, left >> 8, left & 255);
    for (x = 0; x < cols.length;) {
      var run = 1;
      while (x + run < cols.length && cols[x + run] === cols[x] && run < 255) run++;
      if (run >= 4) { out.push(26, run, cols[x]); x += run; }
      else { out.push(cols[x]); x++; }
    }
    out.push(13);
  }
  out.push(15);
  return out;
}
// prepara un'immagine: larghezza in punti (max 480) e altezza corretta per i punti non quadrati (60×72 per pollice)
// aspect: punti verticali per pollice / punti orizzontali per pollice della grafica (MPS 72/60)
function scaleImage(source, dots, aspect, maxW) {
  var sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  var w = Math.max(8, Math.min(maxW || W, Math.round(dots))), h = Math.max(7, Math.round(sh / sw * w * (aspect || DPI_Y / DPI_X)));
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(source, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}
RF.textToPet = textToPet;
RF.ditherImage = function (img, opts) { return dither(img, opts || {}); };
RF.imageToBits = imageToBits;
RF.scaleImage = scaleImage;

/* ---------------- fogli su canvas ---------------- */
var PAPER_W = 9.5, MARGIN_L = 0.75;
// nastro a quattro colori: il nero copre tutto, magenta, ciano e giallo si mescolano come sulla carta
function ribbonColor(m, ink) {
  if (m & 1 || !m) return ink || 'rgba(28,28,40,.88)';
  var r = 250, gg = 248, b = 240;
  if (m & 2) { gg -= 170; b -= 60; }
  if (m & 4) { r -= 190; gg -= 40; }
  if (m & 8) { b -= 200; }
  return 'rgba(' + Math.max(20, r) + ',' + Math.max(20, gg) + ',' + Math.max(20, b) + ',.9)';
}
// tavolozza del C64 (valori misurati, come negli emulatori)
var C64_COLORS = ['#000000', '#ffffff', '#68372b', '#70a4b2', '#6f3d86', '#588d43', '#352879', '#b8c76f',
  '#6f4f25', '#433900', '#9a6759', '#444444', '#6c6c6c', '#9ad284', '#6c5eb5', '#959595'];
// colore dei punti come [r, g, b, a] (a da 0 a 1)
function rgba(css) {
  var m = /rgba?\(([^)]+)\)/.exec(css);
  if (m) { var p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  var h = css.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}
var colorCache = {};
function dotColor(v, ink) {
  var k = v + '|' + (ink || '');
  if (!colorCache[k]) colorCache[k] = rgba(v === 1 ? (ink || 'rgba(28,28,40,.88)') : v >= 0x20 ? ribbonColor(v & 15, ink) : C64_COLORS[v - 2]);
  return colorCache[k];
}
// valore di un punto anche fuori dal foglio n (le righe vicine al bordo vengono dai fogli accanto)
function dotRow(mps, n, y) {
  var H = mps.H, pn = n + Math.floor(y / H), page = mps.pages[pn];
  return page ? {page: page, row: ((y % H) + H) % H * mps.W} : null;
}
/* band: {from, to} righe di punti da ridisegnare (tutto il foglio se manca).
 * I punti si stampano direttamente sui pixel (ImageData): con la grafica fitta delle 24 aghi sono centinaia di
 * migliaia per foglio, troppi per i tracciati del canvas. */
function drawPage(canvas, mps, n, ppi, opts, band) {
  opts = opts || {};
  var H = mps.H, Wd = mps.W, wpx = Math.round(PAPER_W * ppi), hpx = Math.round(H / mps.dpiY * ppi);
  if (canvas.width !== wpx || canvas.height !== hpx) { canvas.width = wpx; canvas.height = hpx; band = null; }
  var g = canvas.getContext('2d'), sy = ppi / mps.dpiY, sx = ppi / mps.dpiX;
  // raggio del punto in pixel: almeno quanto basta perché aghi vicini si tocchino (con aghi piccoli e pochi pixel
  // per punto altrimenti restano righe vuote tra un ago e l'altro)
  var r = Math.max(0.6, mps.needle * ppi / 2);
  // zona da ridisegnare in pixel
  var y0 = 0, y1 = hpx;
  if (band) { y0 = Math.max(0, Math.floor((band.from - 2) * sy - r - 1)); y1 = Math.min(hpx, Math.ceil((band.to + 3) * sy + r + 1)); }
  g.save();
  g.beginPath(); g.rect(0, y0, wpx, y1 - y0); g.clip();
  // carta: bianca con le righe verdi del modulo continuo (facoltative), fori di trascinamento ai lati
  g.fillStyle = '#fbfaf3'; g.fillRect(0, 0, wpx, hpx);
  if (opts.greenbar !== false) {
    g.fillStyle = '#e3f1e0';
    var stripe = ppi / 2;
    for (var by = stripe; by < hpx; by += stripe * 2) g.fillRect(0.5 * ppi, by, wpx - ppi, stripe);
  }
  g.fillStyle = '#e9e6d8';
  g.fillRect(0, 0, 0.5 * ppi, hpx); g.fillRect(wpx - 0.5 * ppi, 0, 0.5 * ppi, hpx);
  g.strokeStyle = '#cfcab4'; g.lineWidth = Math.max(1, ppi / 120);
  g.setLineDash([ppi / 30, ppi / 30]);
  g.beginPath(); g.moveTo(0.5 * ppi, 0); g.lineTo(0.5 * ppi, hpx); g.moveTo(wpx - 0.5 * ppi, 0); g.lineTo(wpx - 0.5 * ppi, hpx); g.stroke();
  // strappo tra un foglio e l'altro: una riga tratteggiata leggera sul bordo alto
  if (n > 0) { g.strokeStyle = '#d9d4bf'; g.beginPath(); g.moveTo(0, 0.5); g.lineTo(wpx, 0.5); g.stroke(); }
  g.setLineDash([]);
  g.fillStyle = opts.holes || '#d7d3c2';
  for (var hy = ppi / 4; hy < hpx; hy += ppi / 2) {
    g.beginPath(); g.arc(0.25 * ppi, hy, ppi * 0.08, 0, 7); g.fill();
    g.beginPath(); g.arc(wpx - 0.25 * ppi, hy, ppi * 0.08, 0, 7); g.fill();
  }
  g.restore();
  if (!mps.pages[n] && !mps.pages[n - 1] && !mps.pages[n + 1]) return;
  // punti: un timbro rotondo per ago, mescolato con la carta sotto; ogni pixel prende un colore una volta sola
  var img = g.getImageData(0, y0, wpx, y1 - y0), d = img.data, iw = wpx, ih = y1 - y0, seen = new Uint8Array(iw * ih);
  // ogni punto copre i pixel il cui centro cade nel cerchio dell'ago, misurato dal centro vero (non arrotondato):
  // così i dettagli larghi un punto restano visibili e aghi vicini si toccano come sulla carta
  var rr = Math.ceil(r + 1), r2 = (r + 0.25) * (r + 0.25);
  var ox = MARGIN_L * ppi + sx / 2;
  var ya = Math.floor((y0 - r) / sy) - 1, yb = Math.ceil((y1 + r) / sy) + 1;
  for (var y = ya; y <= yb; y++) {
    var dr = dotRow(mps, n, y);
    if (!dr) continue;
    var fy = y * sy + sy / 2 - y0;
    if (fy < -rr || fy >= ih + rr) continue;
    var pyA = Math.max(0, Math.floor(fy - r - 0.5)), pyB = Math.min(ih - 1, Math.ceil(fy + r));
    for (var x = 0; x < Wd; x++) {
      var v = dr.page[dr.row + x];
      if (!v) continue;
      var col = dotColor(v, opts.ink), fx = ox + x * sx, a = col[3];
      var pxA = Math.max(0, Math.floor(fx - r - 0.5)), pxB = Math.min(iw - 1, Math.ceil(fx + r));
      for (var py = pyA; py <= pyB; py++) {
        var ddy = py + 0.5 - fy, ddy2 = ddy * ddy;
        if (ddy2 > r2) continue;
        for (var px = pxA; px <= pxB; px++) {
          var ddx = px + 0.5 - fx;
          if (ddx * ddx + ddy2 > r2) continue;
          var pi = py * iw + px;
          if (seen[pi] === v) continue;
          seen[pi] = v;
          var o = pi * 4;
          d[o] = d[o] * (1 - a) + col[0] * a; d[o + 1] = d[o + 1] * (1 - a) + col[1] * a; d[o + 2] = d[o + 2] * (1 - a) + col[2] * a;
        }
      }
    }
  }
  g.putImageData(img, 0, y0);
}
RF.drawPrinterPage = drawPage;
RF.PAPER = {W: PAPER_W, H: 11, MARGIN_L: MARGIN_L};

/* ---------------- PDF (un'immagine JPEG per foglio) ---------------- */
function b64ToBytes(b64) { var s = atob(b64), out = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
function pdfFromJpegs(pages, wPt, hPt, title) {
  var parts = [], offs = [], len = 0, enc = new TextEncoder();
  function add(x) { var b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; }
  function obj(n, body) { offs[n] = len; add(n + ' 0 obj\n'); body.forEach(add); add('\nendobj\n'); }
  add('%PDF-1.4\n%âãÏÓ\n');
  var n = pages.length, kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, ['<< /Type /Pages /Count ' + n + ' /Kids [' + kids.join(' ') + '] >>']);
  pages.forEach(function (p, i) {
    var pg = 3 + i * 3, ct = pg + 1, im = pg + 2;
    var draw = 'q ' + wPt + ' 0 0 ' + hPt + ' 0 0 cm /Im0 Do Q';
    obj(pg, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + wPt + ' ' + hPt + '] /Contents ' + ct + ' 0 R /Resources << /XObject << /Im0 ' + im + ' 0 R >> >> >>']);
    obj(ct, ['<< /Length ' + draw.length + ' >>\nstream\n' + draw + '\nendstream']);
    obj(im, ['<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n', p.jpeg, '\nendstream']);
  });
  var info = 3 + n * 3;
  obj(info, ['<< /Title (' + String(title || 'Stampa').replace(/[()\\]/g, '') + ') /Producer (retrofixer.it) >>']);
  var xref = len, count = info + 1;
  var x = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (var k = 1; k < count; k++) x += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
  add(x + 'trailer\n<< /Size ' + count + ' /Root 1 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  var out = new Uint8Array(len), p0 = 0;
  parts.forEach(function (b) { out.set(b, p0); p0 += b.length; });
  return out;
}
// tutti i fogli stampati → PDF (ppi: risoluzione delle immagini)
function printerPdf(mps, opts) {
  opts = opts || {};
  var ppi = opts.ppi || 200, c = document.createElement('canvas'), pages = [];
  for (var i = 0; i < mps.pageCount(); i++) {
    drawPage(c, mps, i, ppi, opts);
    pages.push({w: c.width, h: c.height, jpeg: b64ToBytes(c.toDataURL('image/jpeg', 0.88).split(',')[1])});
  }
  return pdfFromJpegs(pages, Math.round(PAPER_W * 72), 11 * 72, opts.title);
}
RF.pdfFromJpegs = pdfFromJpegs;
RF.printerPdf = printerPdf;
})(window.RFFloppy = window.RFFloppy || {});
