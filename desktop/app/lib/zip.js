/* copiato da floppy-web/src/zip.js da build.py: non modificare qui */
/* RetroFixer · Floppy C64 · lettura minima di archivi ZIP (molte release di CSDb sono .zip)
 * Metodi "stored" e "deflate", decompressi con DecompressionStream del browser: nessuna libreria esterna.
 */
(function (RF) {
'use strict';
async function inflateRaw(bytes) {
  var ds = new DecompressionStream('deflate-raw');
  var stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
RF.readZip = async function (u8, maxFiles) {
  var v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), eocd = -1;
  for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP non valido');
  var count = v.getUint16(eocd + 10, true), p = v.getUint32(eocd + 16, true), out = [], dec = new TextDecoder();
  for (var k = 0; k < count && k < (maxFiles || 500); k++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    var method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    var nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), loc = v.getUint32(p + 42, true);
    var name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (/\/$/.test(name) || usize > 8 * 1024 * 1024) continue;
    var start = loc + 30 + v.getUint16(loc + 26, true) + v.getUint16(loc + 28, true), body = u8.subarray(start, start + csize), data;
    if (method === 0) data = body.slice();
    else if (method === 8) data = await inflateRaw(body);
    else continue;
    out.push({name: name.split('/').pop(), path: name, data: data});
  }
  return out;
};
})(window.RFFloppy = window.RFFloppy || {});
