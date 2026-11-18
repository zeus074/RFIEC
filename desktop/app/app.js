// RFIEC – programma per PC: floppy ⇄ PC, il C64 usa il PC (drive e stampante emulati), stampa sulla stampante vera.
// Le librerie in lib/ (bus IEC, protocollo xum1541/RFIEC, DOS, immagini disco, stampante) sono le stesse del sito
// retrofixer.it; qui c'è solo l'interfaccia del programma.
(function () {
  'use strict';
  var RF = window.RFFloppy, pet = RF.pet, H = window.host;
  var $ = function (id) { return document.getElementById(id); };
  var LANG = 'it';
  function t(k, a) {
    var s = (I18N[LANG] && I18N[LANG][k]) || I18N.it[k] || k;
    if (a) s = s.replace(/\{(\w+)\}/g, function (m, n) { return a[n] !== undefined ? a[n] : m; });
    return s;
  }
  // le librerie chiedono alcuni testi (errori del drive) con RF.msg
  RF.msg = function (k, a) { return I18N.it[k] ? t(k, typeof a === 'object' && a ? a : {0: a, d: a}) : null; };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  function nfmt(n) { return Number(n).toLocaleString(LANG === 'en' ? 'en-GB' : 'it-IT'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function errMsg(e) { return e ? (e.noBus ? t('noBus') : e.aborted ? t('aborted') : e.status ? e.status.text : (e.message || String(e))) : '?'; }

  var S = {
    tab: 'drive', busy: false,
    pc: {path: '', parent: null, sep: '/', entries: [], sel: new Set(), anchor: null},
    conn: null,            // {kind: 'rfiec'|'xum', port|device, master: {xum, cbm, drive}|null, version}
    dir: null, dirErr: '', dirSel: new Set(), dirAnchor: null,
    emu: {mounted: null, run: null, recv: 0},
    stop: null
  };

  /* ================= registro, avvisi, avanzamento ================= */
  var LOGMAX = 3000;
  function log(level, text) {
    var box = $('log'), d = document.createElement('div');
    var cls = level === 'err' ? 'e' : level === 'c64' ? 'c' : level === 'info' ? 'i' : 'u';
    d.className = cls;
    d.textContent = new Date().toLocaleTimeString() + '  ' + text;
    box.appendChild(d);
    while (box.childNodes.length > LOGMAX) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    if (level === 'err' || level === 'info') status(text, level === 'err');
  }
  function status(text, err) { var s = $('statusL'); s.textContent = text; s.style.color = err ? '#ff8b97' : ''; }
  var toastTimer;
  function toast(text, err) {
    var e = $('toast'); e.textContent = text; e.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { e.className = 'toast' + (err ? ' err' : ''); }, err ? 6000 : 3200);
    if (err) log('err', text);
  }
  function rate(bps) { return bps >= 1024 ? t('kbps', {v: (bps / 1024).toFixed(1)}) : t('bps', {v: Math.round(bps)}); }
  function progress(label) {
    var t0 = Date.now();
    $('prog').hidden = false; $('progL').textContent = label; $('progBar').style.width = '0%'; $('progEta').textContent = '';
    return function (done, total, ms) {
      var pct = total ? Math.min(100, done / total * 100) : 0;
      $('progBar').style.width = pct.toFixed(1) + '%';
      ms = ms || (Date.now() - t0);
      var r = ms > 300 ? done * 1000 / ms : 0, left = r && total ? (total - done) / r : 0;
      $('progEta').textContent = total ? Math.round(pct) + '%' + (left > 2 ? t('etaLeft', {s: Math.round(left) + ' s'}) : '') : nfmt(done);
    };
  }
  async function op(label, fn) {
    if (S.busy) { toast(t('busy'), true); return undefined; }
    S.busy = true; updateUi();
    var p = progress(label);
    try { return await fn(p); }
    catch (e) { toast(errMsg(e), true); return undefined; }
    finally { S.busy = false; $('prog').hidden = true; updateUi(); }
  }

  /* ================= finestre (domande, scelta della porta) ================= */
  // fields: [{id, type: 'text'|'select'|'check', label, value, options: [[v, label]], max}]
  function ask(o) {
    return new Promise(function (resolve) {
      var dlg = $('ask'), f = $('askFields'), btns = $('askBtns');
      $('askTitle').textContent = o.title || '';
      $('askBody').innerHTML = o.html || (o.body ? esc(o.body).replace(/\n/g, '<br>') : '');
      $('askOut').textContent = ''; $('askOut').className = 'out';
      f.innerHTML = '';
      (o.fields || []).forEach(function (fd) {
        var l = document.createElement('label'), inp;
        if (fd.type === 'check') {
          l.className = 'ck'; inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!fd.value;
          l.appendChild(inp); var sp = document.createElement('span'); sp.textContent = fd.label; l.appendChild(sp);
        } else {
          var sp2 = document.createElement('span'); sp2.textContent = fd.label; l.appendChild(sp2);
          if (fd.type === 'select') {
            inp = document.createElement('select');
            fd.options.forEach(function (op2) { var x = document.createElement('option'); x.value = op2[0]; x.textContent = op2[1]; inp.appendChild(x); });
            inp.value = fd.value;
          } else {
            inp = document.createElement('input'); inp.type = 'text'; inp.value = fd.value || ''; if (fd.max) inp.maxLength = fd.max; inp.spellcheck = false;
          }
          l.appendChild(inp);
        }
        inp.dataset.id = fd.id; f.appendChild(l);
      });
      btns.innerHTML = '';
      var list = o.buttons || [{v: 'cancel', label: o.cancel || t('cancel')}, {v: 'ok', label: o.ok || t('ok'), cls: 'pri'}];
      list.forEach(function (b) {
        var e = document.createElement('button'); e.className = 'b ' + (b.cls || ''); e.value = b.v; e.textContent = b.label;
        if (b.v !== 'cancel' && o.onSubmit) e.onclick = async function (ev) {
          ev.preventDefault(); e.disabled = true;
          try { await o.onSubmit(values(b.v), $('askOut')); } finally { e.disabled = false; }
        };
        btns.appendChild(e);
      });
      function values(b) {
        var v = {_b: b};
        f.querySelectorAll('[data-id]').forEach(function (i) { v[i.dataset.id] = i.type === 'checkbox' ? i.checked : i.value; });
        return v;
      }
      dlg.onclose = function () { resolve(dlg.returnValue && dlg.returnValue !== 'cancel' ? values(dlg.returnValue) : null); };
      dlg.returnValue = '';
      dlg.showModal();
      var first = f.querySelector('input[type=text]'); if (first) { first.focus(); first.select(); }
    });
  }
  function confirmBox(text, okLabel) {
    return ask({title: 'RFIEC', body: text, ok: okLabel || t('ok')}).then(function (r) { return !!r; });
  }

  var chooser = null;
  function chooserDraw() {
    var all = $('chAll').checked, list = $('chList'), req = chooser;
    var items = req.items.filter(function (it) { return all || it.known || req.kind === 'usb'; });
    if (!items.length) items = req.items;
    list.innerHTML = '';
    if (!items.length) { var e = document.createElement('div'); e.className = 'empty'; e.textContent = t('noPorts'); list.appendChild(e); }
    items.forEach(function (it, i) {
      var l = document.createElement('label'), tag = '';
      if (req.kind === 'usb') tag = it.vid === '16d0' ? t('tagXum') : '';
      else if (/rfiec/i.test(it.label + it.name)) tag = t('tagRfiec');
      else if (it.vid === '2341' && /^00/.test(it.pid)) tag = t('tagBoot');
      else if (it.known) tag = t('tagArduino');
      l.innerHTML = '<input type="radio" name="p"><span><span class="n"></span><br><span class="d"></span></span>' + (tag ? '<span class="tag"></span>' : '');
      var r = l.querySelector('input'); r.value = it.id; r.checked = i === 0;
      l.querySelector('.n').textContent = it.name;
      l.querySelector('.d').textContent = [it.label, it.vid !== '0000' ? it.vid + ':' + it.pid : ''].filter(Boolean).join(' · ');
      if (tag) l.querySelector('.tag').textContent = tag;
      l.ondblclick = function () { finishChooser(it.id); };
      list.appendChild(l);
    });
    $('chOk').disabled = !items.length;
  }
  function finishChooser(id) {
    if (!chooser) return;
    chooser = null; H.chooserDone(id || '');
    if ($('chooser').open) $('chooser').close();
  }
  H.onChooser(function (req) {
    chooser = req;
    $('chTitle').textContent = t(req.kind === 'usb' ? 'usbT' : 'serialT');
    $('chHelp').textContent = t(req.kind === 'usb' ? 'usbHelp' : 'serialHelp');
    $('chAllBox').hidden = req.kind === 'usb'; $('chAll').checked = false;
    chooserDraw();
    if (!$('chooser').open) $('chooser').showModal();
  });
  $('chAll').onchange = chooserDraw;
  $('chooser').addEventListener('close', function () {
    if (!chooser) return;
    var sel = document.querySelector('#chList input:checked');
    finishChooser($('chooser').returnValue === 'ok' && sel ? sel.value : '');
  });

  /* ================= collegamento ================= */
  function ifaceLabel() {
    var c = S.conn;
    if (!c) return t('ifNone');
    var n = c.kind === 'rfiec' ? (c.version || 'RFIEC') : 'xum1541' + (c.version ? ' v' + c.version : '');
    if (S.emu.run) n += ' · C64 → PC';
    return n;
  }
  function devNr() { return +$('devNr').value; }
  // collegamento seriale alla RFIEC (nelle prove automatiche c.fakeLink dà un firmware finto)
  function makeLink(c) {
    var l = c.fakeLink ? c.fakeLink() : new RF.SerialLink(c.port, log);
    if (!l.open) l.open = async function () {};
    if (!l.close) l.close = async function () {};
    return l;
  }
  async function connectRfiec() {
    if (S.busy) return;
    var port;
    try { port = await navigator.serial.requestPort({}); } catch (e) { return; }
    await disconnect(true);
    S.conn = {kind: 'rfiec', port: port, master: null, version: ''};
    updateUi();
    if (S.tab === 'emu') { await probeRfiec(); return; }
    await openMaster(true);
  }
  async function connectXum() {
    if (S.busy) return;
    var dev;
    try { dev = await navigator.usb.requestDevice({filters: RF.Xum1541.filters}); } catch (e) { return; }
    await disconnect(true);
    S.conn = {kind: 'xum', device: dev, master: null, version: ''};
    updateUi();
    await openMaster(true);
  }
  // legge la versione del firmware RFIEC senza aprire il bus (per la scheda «Il C64 usa il PC»)
  async function probeRfiec() {
    var c = S.conn, link = makeLink(c), ver = '';
    try {
      await link.open(115200);
      var host = new RF.IecHost(link, {drive: null, log: log, onVersion: function (v) { ver = v; }});
      await host.hello();
      for (var i = 0; i < 25 && !ver; i++) await sleep(100);
    } catch (e) { log('err', errMsg(e)); }
    try { await link.close(); } catch (e) {}
    if (!ver) { toast(t('noFw'), true); await disconnect(); return; }
    c.version = ver; log('info', t('connOk', {n: ver})); updateUi();
  }
  // apre la scheda come «padrone del bus» (xum1541 o RFIEC) e legge stato e directory
  async function openMaster(readDir) {
    var c = S.conn;
    if (!c) { toast(t('needConn'), true); return null; }
    if (c.master) return c.master;
    if (S.emu.run) { toast(t('emuStopFirst')); await emuStop(); }
    var xum = c.kind === 'rfiec' ? new RF.SerialXum(makeLink(c), log) : new RF.Xum1541(c.device, log);
    status(t('connecting'));
    try { await xum.open(); }
    catch (e) {
      var m = c.kind === 'rfiec' && /firmware|risposta|answer|timeout|tempo/i.test(errMsg(e)) ? t('noFw') : t('connFail', {e: errMsg(e)});
      toast(m, true); try { await xum.close(); } catch (x) {}
      S.conn = null; updateUi(); return null;
    }
    var cbm = new RF.Cbm(xum, log), drive = new RF.Drive(cbm, devNr());
    c.master = {xum: xum, cbm: cbm, drive: drive};
    c.version = xum.version || c.version;
    log('info', t('connOk', {n: ifaceLabel()}));
    updateUi();
    if (readDir && S.tab === 'drive') await refreshAll();
    return c.master;
  }
  async function closeMaster() {
    var c = S.conn;
    if (!c || !c.master) return;
    try { await c.master.xum.close(); } catch (e) {}
    c.master = null;
  }
  async function disconnect(quiet) {
    if (S.emu.run) await emuStop();
    if (S.conn) { await closeMaster(); if (!quiet) log('info', t('disconnected')); }
    S.conn = null; S.dir = null; S.dirErr = ''; S.dirSel.clear();
    renderDir(); updateUi();
  }
  if (navigator.serial) navigator.serial.addEventListener('disconnect', function (ev) {
    if (S.conn && S.conn.port === ev.target) { toast(t('lost'), true); S.busy = false; disconnect(true); }
  });
  if (navigator.usb) navigator.usb.addEventListener('disconnect', function (ev) {
    if (S.conn && S.conn.device === ev.device) { toast(t('lost'), true); S.busy = false; disconnect(true); }
  });
  async function needDrive() {
    var m = S.conn && (S.conn.master || await openMaster(false));
    if (!m) { if (!S.conn) toast(t('needConn'), true); return null; }
    m.drive.dev = devNr();
    return m.drive;
  }

  /* ================= pannello del PC ================= */
  var C64EXT = /\.(prg|seq|usr|p00|s00|u00|d64|d71|d81|prn|txt|bas|g64|t64|crt|zip)$/i;
  var IMGEXT = /\.(d64|d71|d81)$/i;
  function ext(n) { var m = /\.([^.]+)$/.exec(n); return m ? m[1].toUpperCase() : ''; }
  function sizeTxt(n) { return n < 1024 ? nfmt(n) + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function icon(e) {
    if (e.dir) return '📁';
    var x = ext(e.name);
    if (/^D(64|71|81)$/.test(x)) return '💾';
    if (/^(PRG|P00)$/.test(x)) return '▶';
    if (/^(SEQ|S00|USR|U00|TXT)$/.test(x)) return '📄';
    if (x === 'PRN' || x === 'PDF') return '🖨';
    return '·';
  }
  function pcVisible() {
    var only = $('pcC64Only').checked;
    return S.pc.entries.filter(function (e) { return e.dir || !only || C64EXT.test(e.name) || /\.pdf$/i.test(e.name); });
  }
  async function pcLoad(dir, keepSel) {
    try {
      var r = await H.fs.list(dir);
      var old = S.pc.path;
      S.pc.path = r.path; S.pc.parent = r.parent; S.pc.sep = r.sep; S.pc.entries = r.entries;
      if (!keepSel || old !== r.path) { S.pc.sel.clear(); S.pc.anchor = null; }
      else S.pc.sel.forEach(function (n) { if (!r.entries.some(function (e) { return e.name === n; })) S.pc.sel.delete(n); });
      $('pcPath').value = r.path;
      H.setSettings({lastDir: r.path});
      pcRender();
    } catch (e) { toast(errMsg(e), true); $('pcPath').value = S.pc.path; }
  }
  function pcRender() {
    var tb = $('pcTable').tBodies[0], list = pcVisible(), html = [];
    if (S.pc.parent) html.push('<tr class="dir" data-up="1"><td><span class="fi">↰</span>..</td><td></td><td></td><td></td></tr>');
    list.forEach(function (e, i) {
      var cls = (e.dir ? 'dir' : C64EXT.test(e.name) ? 'c64' : 'other') + (S.pc.sel.has(e.name) ? ' sel' : '');
      html.push('<tr class="' + cls + '" data-i="' + i + '" draggable="' + (!e.dir) + '"><td title="' + esc(e.name) + '"><span class="fi">' + icon(e) + '</span>' + esc(e.name) +
        '</td><td class="r">' + (e.dir ? '' : sizeTxt(e.size)) + '</td><td>' + (e.dir ? t('folder') : esc(ext(e.name))) +
        '</td><td>' + new Date(e.mtime).toLocaleString(LANG === 'en' ? 'en-GB' : 'it-IT', {dateStyle: 'short', timeStyle: 'short'}) + '</td></tr>');
    });
    tb.innerHTML = html.join('');
    var files = list.filter(function (e) { return !e.dir; }).length;
    $('pcInfo').textContent = t('files', {n: files}) + (S.pc.sel.size ? ' · ' + t('selInfo', {n: S.pc.sel.size}) : '');
    updateUi();
  }
  function pcSelected() { return pcVisible().filter(function (e) { return S.pc.sel.has(e.name); }); }
  async function pcPath(name) { return H.fs.join(S.pc.path, name); }
  function rowSelect(set, keyOf, list, i, ev, anchorObj, anchorKey) {
    var key = keyOf(list[i]);
    if (ev.shiftKey && anchorObj[anchorKey] !== null && anchorObj[anchorKey] !== undefined) {
      var a = Math.min(anchorObj[anchorKey], i), b = Math.max(anchorObj[anchorKey], i);
      if (!ev.ctrlKey && !ev.metaKey) set.clear();
      for (var k = a; k <= b; k++) set.add(keyOf(list[k]));
    } else if (ev.ctrlKey || ev.metaKey) {
      if (set.has(key)) set.delete(key); else set.add(key);
      anchorObj[anchorKey] = i;
    } else { set.clear(); set.add(key); anchorObj[anchorKey] = i; }
  }
  $('pcTable').addEventListener('mousedown', function (ev) {
    var tr = ev.target.closest('tr'); if (!tr || tr.dataset.up) return;
    var i = +tr.dataset.i, list = pcVisible();
    if (ev.button === 0 && !(S.pc.sel.has(list[i].name) && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey)) {
      rowSelect(S.pc.sel, function (e) { return e.name; }, list, i, ev, S.pc, 'anchor'); pcRender();
    }
  });
  $('pcTable').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr'); if (!tr || tr.dataset.up || ev.ctrlKey || ev.shiftKey || ev.metaKey) return;
    var list = pcVisible(), i = +tr.dataset.i;
    if (S.pc.sel.size > 1 && S.pc.sel.has(list[i].name)) { S.pc.sel.clear(); S.pc.sel.add(list[i].name); S.pc.anchor = i; pcRender(); }
  });
  $('pcTable').addEventListener('dblclick', async function (ev) {
    var tr = ev.target.closest('tr'); if (!tr) return;
    if (tr.dataset.up) { pcLoad(S.pc.parent); return; }
    var e = pcVisible()[+tr.dataset.i];
    if (e.dir) { pcLoad(await pcPath(e.name)); return; }
    if (S.tab === 'emu' && IMGEXT.test(e.name)) { emuMountSelected(); return; }
    if (S.tab === 'print') { printLoad(); return; }
    if (S.tab === 'drive' && !IMGEXT.test(e.name)) { copyToDisk(); return; }
    H.fs.open(await pcPath(e.name));
  });
  $('pcWrap').addEventListener('keydown', function (ev) {
    var list = pcVisible();
    if (ev.key === 'Backspace' && S.pc.parent) { ev.preventDefault(); pcLoad(S.pc.parent); }
    else if (ev.key === 'F5') pcLoad(S.pc.path, true);
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); list.forEach(function (e) { if (!e.dir) S.pc.sel.add(e.name); }); pcRender(); }
    else if (ev.key === 'Delete') pcTrash();
    else if (ev.key === 'Enter') {
      var s = pcSelected(); if (s.length === 1 && s[0].dir) pcPath(s[0].name).then(pcLoad);
      else if (S.tab === 'drive') copyToDisk();
    }
  });
  $('pcUp').onclick = function () { if (S.pc.parent) pcLoad(S.pc.parent); };
  $('pcHome').onclick = async function () { pcLoad(await H.fs.home()); };
  $('pcRefresh').onclick = function () { pcLoad(S.pc.path, true); };
  $('pcPick').onclick = async function () { var d = await H.fs.pickFolder(S.pc.path); if (d) pcLoad(d); };
  $('pcPath').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') pcLoad($('pcPath').value.trim()); });
  $('pcRoots').onchange = function () { if ($('pcRoots').value) pcLoad($('pcRoots').value); $('pcRoots').selectedIndex = 0; };
  $('pcC64Only').onchange = function () { H.setSettings({c64Only: $('pcC64Only').checked}); pcRender(); };
  $('pcNewDir').onclick = async function () {
    var r = await ask({title: t('pcNewDirT'), fields: [{id: 'n', label: t('pcName'), value: ''}]});
    if (!r || !r.n.trim()) return;
    try { await H.fs.mkdir(await pcPath(r.n.trim())); pcLoad(S.pc.path, true); } catch (e) { toast(errMsg(e), true); }
  };
  $('pcRename').onclick = async function () {
    var s = pcSelected(); if (s.length !== 1) { toast(t('noSelPc'), true); return; }
    var r = await ask({title: t('pcRenT'), fields: [{id: 'n', label: t('pcName'), value: s[0].name}]});
    if (!r || !r.n.trim() || r.n === s[0].name) return;
    try { await H.fs.rename(await pcPath(s[0].name), await pcPath(r.n.trim())); S.pc.sel.clear(); S.pc.sel.add(r.n.trim()); pcLoad(S.pc.path, true); } catch (e) { toast(errMsg(e), true); }
  };
  async function pcTrash() {
    var s = pcSelected(); if (!s.length) return;
    if (!await confirmBox(t('trashConfirm', {n: s.length}) + '\n' + s.slice(0, 12).map(function (e) { return e.name; }).join('\n'), t('trash'))) return;
    for (var i = 0; i < s.length; i++) { try { await H.fs.trash(await pcPath(s[i].name)); } catch (e) { toast(errMsg(e), true); } }
    pcLoad(S.pc.path, true);
  }
  $('pcTrash').onclick = pcTrash;

  /* ================= floppy: directory e comandi ================= */
  function petLine(bytes) { return pet.toStr(bytes); }
  function renderDirInto(ids, dir, sel, emptyText) {
    var head = $(ids.head), tb = $(ids.table).tBodies[0], foot = $(ids.foot), empty = $(ids.empty);
    if (!dir) { head.innerHTML = ''; tb.innerHTML = ''; foot.textContent = ''; empty.textContent = emptyText || ''; return; }
    empty.textContent = '';
    var name = (dir.name || []).slice(); while (name.length < 16) name.push(0x20);
    head.innerHTML = '0 <span class="rv">"' + esc(petLine(name)) + '" ' + esc(petLine(dir.idText || dir.id || [])) + '</span>';
    tb.innerHTML = dir.files.map(function (f, i) {
      var nm = '"' + petLine(f.name) + '"'; while (nm.length < 18) nm += ' ';
      return '<tr data-i="' + i + '"' + (sel && sel.has(i) ? ' class="sel"' : '') + ' draggable="true"><td class="bl">' + f.blocks + '</td><td>' + esc(nm) + '</td><td>' +
        (f.closed === false ? '*' : ' ') + esc(f.typeName) + (f.locked ? '&lt;' : '') + '</td></tr>';
    }).join('');
    foot.textContent = dir.free !== null && dir.free !== undefined ? t('blocksFree', {n: dir.free}) : '';
  }
  function renderDir() {
    renderDirInto({head: 'dirHead', table: 'dirTable', foot: 'dirFoot', empty: 'dirEmpty'}, S.dir, S.dirSel,
      S.dirErr ? t('dirErr', {e: S.dirErr}) : t('dirNone'));
    var m = S.conn && S.conn.master;
    $('dosInfo').textContent = m && m.drive.dosText ? m.drive.dosText : '';
  }
  function showStatus(st) {
    var e = $('dStat');
    e.textContent = st ? st.text : '—';
    e.className = 'dstat' + (st && st.code >= 20 && st.code !== 73 ? ' err' : '');
  }
  async function refreshDir() {
    var d = await needDrive(); if (!d) return;
    var r = await op(t('readDir'), async function (p) {
      try {
        var dir = await d.directory(function (n) { p(n, 0); });
        S.dir = dir; S.dirErr = ''; S.dirSel.clear(); S.dirAnchor = null;
      } catch (e) {
        S.dir = null; S.dirErr = errMsg(e);
        if (e && e.status && e.status.none) S.dirErr = t('noDrive', {d: d.dev});
      }
      showStatus(await d.status().catch(function () { return null; }));
      return true;
    });
    renderDir();
    return r;
  }
  async function refreshAll() {
    var d = await needDrive(); if (!d) return;
    var st = await op(t('readStatus'), function () { return d.status(); });
    if (!st) { renderDir(); return; }
    showStatus(st);
    if (st.none) { S.dir = null; S.dirErr = t('noDrive', {d: d.dev}); renderDir(); return; }
    d.setModel(st);
    if (!d.model && st.code === 0) {
      var id = await op(t('readStatus'), function () { return d.identify(); });
      if (id) showStatus(id);
    }
    await refreshDir();
  }
  function dirSelected() { return S.dir ? S.dir.files.filter(function (f, i) { return S.dirSel.has(i); }) : []; }
  $('dirTable').addEventListener('mousedown', function (ev) {
    var tr = ev.target.closest('tr'); if (!tr || !S.dir) return;
    var i = +tr.dataset.i;
    if (ev.button === 0 && !(S.dirSel.has(i) && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey)) {
      rowSelect(S.dirSel, function (f) { return S.dir.files.indexOf(f); }, S.dir.files, i, ev, S, 'dirAnchor'); renderDir(); updateUi();
    }
  });
  $('dirTable').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr'); if (!tr || ev.ctrlKey || ev.shiftKey || ev.metaKey) return;
    var i = +tr.dataset.i;
    if (S.dirSel.size > 1) { S.dirSel.clear(); S.dirSel.add(i); S.dirAnchor = i; renderDir(); updateUi(); }
  });
  $('dirTable').addEventListener('dblclick', function () { copyToPc(); });
  $('dirWrap').addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a' && S.dir) { ev.preventDefault(); S.dir.files.forEach(function (f, i) { S.dirSel.add(i); }); renderDir(); updateUi(); }
    else if (ev.key === 'Delete') scratchSel();
    else if (ev.key === 'F5') refreshDir();
    else if (ev.key === 'Enter') copyToPc();
  });
  $('devNr').onchange = function () { H.setSettings({dev: devNr()}); S.dir = null; S.dirSel.clear(); renderDir(); if (S.conn && S.conn.master) refreshAll(); };

  // tipo del file del C64 dall'estensione del PC
  function c64Type(name) {
    var x = ext(name);
    return x === 'SEQ' || x === 'S00' || x === 'TXT' ? 'SEQ' : x === 'USR' || x === 'U00' ? 'USR' : 'PRG';
  }
  async function copyToDisk(files) {
    files = files || pcSelected();
    var ok = files.filter(function (e) { return !e.dir && !IMGEXT.test(e.name); });
    if (!ok.length) {
      if (files.some(function (e) { return IMGEXT.test(e.name); })) toast(t('skipImg', {n: files[0].name}), true); else toast(t('noSelPc'), true);
      return;
    }
    var d = await needDrive(); if (!d) return;
    var done = 0;
    for (var i = 0; i < ok.length; i++) {
      var e = ok[i], data = await H.fs.read(await pcPath(e.name)), name, type = c64Type(e.name);
      if (/\.[psu]00$/i.test(e.name)) { var p00 = RF.parseP00(data); if (p00) { name = p00.name; data = p00.data; } }
      if (!name) name = pet.fromPcName(e.name);
      var exists = S.dir && S.dir.files.some(function (f) { return pet.eq(f.name, name); }), replace = false;
      if (exists) { if (!await confirmBox(t('exists', {n: petLine(name)}), t('yes'))) continue; replace = true; }
      var r = await op(t('writing', {n: petLine(name)}) + (ok.length > 1 ? ' (' + (i + 1) + '/' + ok.length + ')' : ''), async function (p) {
        var st = await d.writeFile(name, data, type, {replace: replace}, p); showStatus(st); return true;
      });
      if (!r) break;
      done++;
    }
    if (done) { toast(t('copiedToDisk', {n: done})); await refreshDir(); }
  }
  async function copyToPc(files) {
    files = files || dirSelected();
    files = files.filter(function (f) { return f.typeName !== 'DEL'; });
    if (!files.length) { toast(t('noSelDisk'), true); return; }
    var d = await needDrive(); if (!d) return;
    var done = 0, last = '';
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var data = await op(t('reading', {n: petLine(f.name)}) + (files.length > 1 ? ' (' + (i + 1) + '/' + files.length + ')' : ''), function (p) {
        return d.readFile(f.name, f.typeName, p, f.blocks * 254);
      });
      if (!data) break;
      last = await H.fs.write(await pcPath(pet.toPcName(f.name, f.typeName.toLowerCase())), data, true);
      done++;
    }
    if (done) { toast(t('copiedToPc', {n: done, p: S.pc.path})); await pcLoad(S.pc.path, true); }
  }
  async function diskToImage() {
    var d = await needDrive(); if (!d) return;
    var fmt = d.geometry(), base = S.dir ? pet.toPcName(S.dir.name || []) : 'disk';
    var r = await ask({title: t('diskToImg'), fields: [{id: 'n', label: t('imgName'), value: base + '.' + fmt}]});
    if (!r || !r.n.trim()) return;
    var img = await op(t('readDisk'), function (p) { return d.readDisk(fmt, function (done, tot, ms) { p(done, tot, ms); }); });
    if (!img) return;
    var path = await H.fs.write(await pcPath(r.n.trim()), img.data, true);
    if (img.readErrors && img.readErrors.length) toast(t('imgErrors', {n: img.readErrors.length}), true); else toast(t('savedFile', {p: path}));
    await pcLoad(S.pc.path, true);
  }
  async function imageToDisk() {
    var s = pcSelected().filter(function (e) { return IMGEXT.test(e.name); });
    if (s.length !== 1) { toast(t('imgSel'), true); return; }
    var img;
    try { img = new RF.Disk(await H.fs.read(await pcPath(s[0].name)), s[0].name); } catch (e) { toast(t('imgBad', {e: errMsg(e)}), true); return; }
    var d = await needDrive(); if (!d) return;
    var geo = d.geometry();
    if (d.model && geo !== img.fmt.id && !await confirmBox(t('imgGeo', {f: img.fmt.id.toUpperCase(), m: d.model}))) return;
    if (!await confirmBox(t('imgConfirm', {n: s[0].name, d: d.dev}), t('imgToDisk'))) return;
    var n = await op(t('writeDisk'), function (p) { return d.writeDisk(img, {}, function (done, tot, ms) { p(done, tot, ms); }); });
    if (n !== undefined) await refreshDir();
  }
  async function scratchSel() {
    var s = dirSelected(); if (!s.length) { toast(t('noSelDisk'), true); return; }
    if (!await confirmBox(t('scrConfirm', {n: s.length, l: s.slice(0, 12).map(function (f) { return '"' + petLine(f.name) + '"'; }).join('\n')}), t('scratch'))) return;
    var d = await needDrive(); if (!d) return;
    await op(t('scratching'), async function (p) {
      for (var i = 0; i < s.length; i++) { showStatus(await d.scratch(s[i].name)); p(i + 1, s.length); }
    });
    await refreshDir();
  }
  async function renameSel() {
    var s = dirSelected(); if (s.length !== 1) { toast(t('noSelDisk'), true); return; }
    var r = await ask({title: t('renT'), fields: [{id: 'n', label: t('newName'), value: petLine(s[0].name), max: 16}]});
    if (!r || !r.n.trim()) return;
    var d = await needDrive(); if (!d) return;
    var st = await op(t('renaming'), function () { return d.rename(s[0].name, pet.fromStr(r.n.trim()).slice(0, 16)); });
    if (st) showStatus(st);
    await refreshDir();
  }
  async function formatDisk() {
    var d = await needDrive(); if (!d) return;
    var r = await ask({title: t('fmtT'), body: t('fmtConfirm', {d: d.dev}), ok: t('format').replace('…', ''),
      fields: [{id: 'n', label: t('fmtName'), value: 'RFIEC', max: 16}, {id: 'id', label: t('fmtId'), value: '01', max: 2}, {id: 'q', type: 'check', label: t('fmtQuick'), value: false}]});
    if (!r) return;
    var st = await op(t('formatting'), function () { return d.format(pet.fromStr(r.n.trim() || 'RFIEC').slice(0, 16), r.q ? null : pet.fromStr(r.id.trim() || '01').slice(0, 2)); });
    if (st) showStatus(st);
    await refreshDir();
  }
  async function dosCommand() {
    var d = await needDrive(); if (!d) return;
    var r = await ask({title: t('cmdT'), body: t('cmdHelp'), fields: [{id: 'c', label: t('cmdLabel'), value: ''}]});
    if (!r || !r.c.trim()) return;
    var st = await op(t('cmdRun'), function () { return d.command(pet.fromStr(r.c.trim()), 20000); });
    if (st) { showStatus(st); log('info', r.c.trim() + ' → ' + st.text); }
  }
  async function simple(label, fn) {
    var d = await needDrive(); if (!d) return;
    var st = await op(label, function () { return fn(d); });
    if (st) showStatus(st);
    return st;
  }
  async function busReset() {
    var d = await needDrive(); if (!d) return;
    await op(t('busReset'), function () { return d.run(function (c) { return c.reset(); }); });
    S.dir = null; renderDir();
  }
  $('dDir').onclick = refreshDir;
  $('dStatus').onclick = function () { simple(t('readStatus'), function (d) { return d.status(); }); };
  $('dRename').onclick = renameSel;
  $('dScratch').onclick = scratchSel;
  $('dFormat').onclick = formatDisk;
  $('dValidate').onclick = async function () { await simple(t('validating'), function (d) { return d.validate(); }); refreshDir(); };
  $('dInit').onclick = function () { simple(t('dirBtn'), function (d) { return d.initialize(); }); };
  $('dCmd').onclick = dosCommand;
  $('dReset').onclick = busReset;
  $('cpToDisk').onclick = function () { copyToDisk(); };
  $('cpToPc').onclick = function () { copyToPc(); };
  $('imgFromDisk').onclick = diskToImage;
  $('imgToDisk').onclick = imageToDisk;
  $('progStop').onclick = function () { var m = S.conn && S.conn.master; if (m) m.cbm.stop(); };

  // trascinare: righe del PC sul floppy, righe del floppy sul PC
  var drag = null;
  $('pcTable').addEventListener('dragstart', function (ev) { drag = 'pc'; ev.dataTransfer.setData('text/plain', 'rfiec-pc'); ev.dataTransfer.effectAllowed = 'copy'; });
  $('dirTable').addEventListener('dragstart', function (ev) {
    var tr = ev.target.closest('tr'); if (tr && !S.dirSel.has(+tr.dataset.i)) { S.dirSel.clear(); S.dirSel.add(+tr.dataset.i); renderDir(); }
    drag = 'disk'; ev.dataTransfer.setData('text/plain', 'rfiec-disk'); ev.dataTransfer.effectAllowed = 'copy';
  });
  document.addEventListener('dragend', function () { drag = null; });
  [['dirWrap', 'pc', function () { copyToDisk(); }], ['pcWrap', 'disk', function () { copyToPc(); }], ['emuDirWrap', 'pc', function () { emuMountSelected(); }]].forEach(function (z) {
    var el = $(z[0]);
    el.addEventListener('dragover', function (ev) { if (drag === z[1]) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
    el.addEventListener('drop', function (ev) { if (drag === z[1]) { ev.preventDefault(); drag = null; z[2](); } });
  });

  /* ================= il C64 usa il PC (RFIEC: drive e stampante emulati) ================= */
  var FMT_MODEL = {d64: '1541', d71: '1571', d81: '1581'};
  var mps = new RF.Mps({model: 'mps', onChange: paperChanged});
  var paperTimer = null;
  function paperChanged() { if (!paperTimer) paperTimer = setTimeout(function () { paperTimer = null; drawPaper(); }, 150); }
  function drawPaper() {
    var n = mps.pageCount(), c = $('paper');
    $('paperNone').hidden = n > 0; c.hidden = n === 0;
    if (n) RF.drawPrinterPage(c, mps, n - 1, 64, {});
    $('paperInfo').textContent = n ? t('paperInfo', {n: n, b: nfmt(mps.rawBytes().length)}) : t('paperEmpty');
    var box = c.parentNode; box.scrollTop = box.scrollHeight;
    updateUi();
  }
  var c64Printer = {
    listen: function (sec) { mps.listen(sec); },
    write: function (data) {
      mps.write(data); S.emu.recv += data.length;
      clearTimeout(S.emu.prnTimer);
      S.emu.prnTimer = setTimeout(function () { if (S.emu.recv) { activity(t('c64Print', {n: nfmt(S.emu.recv)})); S.emu.recv = 0; } }, 1000);
    },
    unlisten: function () { mps.unlisten(); },
    reset: function () { mps.reset(); }
  };
  function activity(text) {
    var box = $('emuAct'), d = document.createElement('div');
    d.innerHTML = '<span class="t">' + esc(new Date().toLocaleTimeString()) + '</span>  ' + esc(text);
    box.appendChild(d); while (box.childNodes.length > 400) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    log('c64', text);
  }
  function emuActivity(a) {
    var n = a.name ? petLine(a.name) : '', x = '';
    if (a.kind === 'load') x = t('c64Load', {n: n});
    else if (a.kind === 'save') x = t('c64Save', {n: n.replace(/^@?\d?:/, '')});
    else if (a.kind === 'open') x = t('c64Open', {s: a.sa, n: n});
    else if (a.kind === 'cmd') x = t('c64Cmd', {n: n});
    else if (a.kind === 'sent' && a.n) x = t('c64Sent', {n: nfmt(a.n)}) + (a.ms ? ' · ' + rate(a.n * 1000 / a.ms) : '');
    else if (a.kind === 'recv' && a.n) x = t('c64Recv', {n: nfmt(a.n)}) + (a.ms ? ' · ' + rate(a.n * 1000 / a.ms) : '');
    else if (a.kind === 'reset') x = t('c64Reset');
    else if (a.kind === 'fast') x = t('c64Fast', {n: a.name});
    if (!x) return;
    if (a.status && (a.code >= 20 && a.code !== 73 || a.kind === 'cmd')) x += t('c64Err', {s: a.status});
    activity(x);
  }
  function emuDirOf(disk) {
    if (!disk) return null;
    var h = disk.headerInfo();
    return {name: h.name, idText: h.id.concat([0x20], h.dos), files: disk.files().map(function (f) {
      return {name: f.name, blocks: f.blocks, typeName: f.typeName, closed: f.closed, locked: f.locked};
    }), free: disk.blocksFree()};
  }
  function renderEmu() {
    var m = S.emu.mounted;
    $('emuMounted').textContent = m ? t('emuMounted', {n: m.path.split(/[\\/]/).pop()}) : t('emuNoDisk');
    $('emuMounted').title = m ? m.path : '';
    $('emuMounted').className = 'mounted' + (m ? '' : ' none');
    renderDirInto({head: 'emuDirHead', table: 'emuDirTable', foot: 'emuDirFoot', empty: 'emuDirEmpty'}, m ? emuDirOf(m.disk) : null, null, '');
    var r = S.emu.run;
    $('emuState').textContent = r ? t('emuOn', {d: r.driveOn ? r.dev : '-', p: r.prnOn ? t('emuOnP', {p: r.prnDev}) : ''}) : t('emuOff');
  }
  async function emuMount(path, disk) {
    var r = S.emu.run;
    S.emu.mounted = {path: path, disk: disk};
    if (r && r.c64) { var mdl = FMT_MODEL[disk.fmt.id]; if (r.c64.model !== mdl) r.c64.setModel(mdl); r.c64.insert(disk); }
    activity(t('emuMounted', {n: path}));
    H.setSettings({emuDisk: path});
    renderEmu(); updateUi();
  }
  async function emuMountSelected() {
    var s = pcSelected().filter(function (e) { return IMGEXT.test(e.name); });
    if (s.length !== 1) { toast(t('imgSel'), true); return; }
    var path = await pcPath(s[0].name);
    try { await emuMount(path, new RF.Disk(await H.fs.read(path), s[0].name)); } catch (e) { toast(t('imgBad', {e: errMsg(e)}), true); }
  }
  async function emuNew() {
    var fmt = $('emuNewFmt').value;
    var r = await ask({title: t('emuNewT'), fields: [{id: 'n', label: t('emuNewName'), value: 'RFIEC', max: 16}, {id: 'f', label: t('imgName'), value: 'rfiec.' + fmt}]});
    if (!r) return;
    var disk = RF.Disk.blank(fmt, pet.fromStr(r.n.trim() || 'RFIEC').slice(0, 16), pet.fromStr('01'));
    var path = await H.fs.write(await pcPath(r.f.trim() || 'rfiec.' + fmt), disk.data, true);
    await pcLoad(S.pc.path, true);
    await emuMount(path, disk);
  }
  var saveTimer = null;
  function emuChanged() {
    renderEmu();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async function () {
      var m = S.emu.mounted; if (!m) return;
      try { await H.fs.write(m.path, m.disk.data, false); log('info', t('emuSaved', {n: m.path})); } catch (e) { toast(errMsg(e), true); }
    }, 900);
  }
  async function emuStart() {
    var c = S.conn;
    if (!c) { toast(t('needConn'), true); return; }
    if (c.kind !== 'rfiec') { toast(t('needRfiec'), true); return; }
    var driveOn = $('emuDriveOn').checked, prnOn = $('emuPrnOn').checked;
    if (!driveOn && !prnOn) { toast(t('emuNothing'), true); return; }
    if (S.busy) { toast(t('busy'), true); return; }
    await closeMaster();
    var link = makeLink(c), ver = '';
    try { await link.open(115200); } catch (e) { toast(t('connFail', {e: errMsg(e)}), true); return; }
    var dev = +$('emuDev').value, prnDev = +$('emuPrnDev').value, m = S.emu.mounted;
    var c64 = driveOn ? new RF.FakeDrive({model: m ? FMT_MODEL[m.disk.fmt.id] : '1541', dev: dev, speed: 'instant', disk: m ? m.disk : null, onChange: emuChanged}) : null;
    mps.setModel($('emuPrnModel').value, true);
    var host = new RF.IecHost(link, {drive: c64, dev: dev, printer: prnOn ? c64Printer : null, printerDev: prnDev, printerOn: prnOn,
      log: log, onActivity: emuActivity, onVersion: function (v) { ver = v; }});
    await host.hello();
    for (var i = 0; i < 25 && !ver; i++) await sleep(100);
    if (!ver) { try { await link.close(); } catch (e) {} toast(t('noFw'), true); return; }
    await host.configure();
    c.version = ver;
    var latest = RF.FIRMWARE && RF.FIRMWARE.rfiec && RF.FIRMWARE.rfiec.name;
    if (latest && ver !== latest) toast(t('emuOld', {v: ver, n: latest}), true);
    S.emu.run = {link: link, host: host, c64: c64, dev: dev, prnDev: prnDev, driveOn: driveOn, prnOn: prnOn};
    activity(t('emuStarted', {v: ver}));
    renderEmu(); updateUi();
  }
  async function emuStop() {
    var r = S.emu.run; if (!r) return;
    S.emu.run = null;
    try { await r.link.close(); } catch (e) {}
    activity(t('emuStopped'));
    renderEmu(); updateUi();
  }
  $('emuGo').onclick = emuStart;
  $('emuStop').onclick = emuStop;
  $('emuMount').onclick = emuMountSelected;
  $('emuNew').onclick = emuNew;
  $('emuEject').onclick = function () { S.emu.mounted = null; if (S.emu.run && S.emu.run.c64) S.emu.run.c64.eject(); H.setSettings({emuDisk: ''}); renderEmu(); updateUi(); };
  $('emuPrnModel').onchange = function () { mps.setModel($('emuPrnModel').value); drawPaper(); };
  $('paperClear').onclick = function () { mps.clear(); drawPaper(); };
  function stamp() { var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }
  $('paperPdf').onclick = async function () {
    if (!mps.pageCount()) return;
    var path = await H.fs.write(await pcPath('stampa-c64-' + stamp() + '.pdf'), RF.printerPdf(mps, {title: 'RFIEC'}), true);
    toast(t('savedFile', {p: path})); pcLoad(S.pc.path, true);
  };
  $('paperPrn').onclick = async function () {
    if (!mps.pageCount()) return;
    var path = await H.fs.write(await pcPath('stampa-c64-' + stamp() + '.prn'), mps.rawBytes(), true);
    toast(t('savedFile', {p: path})); pcLoad(S.pc.path, true);
  };

  /* ================= stampa sulla stampante vera ================= */
  async function printLoad() {
    var s = pcSelected().filter(function (e) { return !e.dir; });
    if (s.length !== 1) { toast(t('noSelPc'), true); return; }
    var data = await H.fs.read(await pcPath(s[0].name)), text;
    if (/\.(prg|p00)$/i.test(s[0].name)) {
      var p00 = /\.p00$/i.test(s[0].name) && RF.parseP00(data), l = RF.basicList(p00 ? p00.data : data);
      if (!l || !l.lines) { toast(t('prNoBasic'), true); return; }
      text = l.lines.join('\n');
    } else text = new TextDecoder('utf-8').decode(data);
    $('prText').value = text.replace(/\r\n?/g, '\n');
    $('prInfo').textContent = t('prLoaded', {n: s[0].name});
  }
  async function sendToPrinter(bytes, sa) {
    var d = await needDrive(); if (!d) return;
    var dev = +$('prDev').value;
    var n = await op(t('printing', {d: dev}), function (p) {
      return d.run(async function (c) {
        if (await c.listen(dev, sa)) { await c.unlisten(); throw new Error(t('notPresent', {0: dev})); }
        var sent = 0;
        for (var i = 0; i < bytes.length; i += 64) {
          if (c.abort) { await c.unlisten(); throw new Error(t('aborted')); }
          var chunk = new Uint8Array(bytes.slice(i, i + 64)), k = await c.rawWrite(chunk);
          sent += k; p(sent, bytes.length);
          if (k !== chunk.length) { await c.unlisten(); throw new Error(t('notPresent', {0: dev})); }
        }
        await c.unlisten();
        return sent;
      });
    });
    if (n) toast(t('printed', {n: nfmt(n)}));
  }
  $('prLoad').onclick = printLoad;
  $('prGo').onclick = function () {
    var text = $('prText').value; if (!text.trim()) { toast(t('prNeed'), true); return; }
    var lower = $('prLower').value === '1';
    sendToPrinter(RF.textToPet(text + '\n', lower, 80), lower ? 7 : 0);
  };
  $('prRaw').onclick = async function () {
    var s = pcSelected().filter(function (e) { return !e.dir; });
    if (s.length !== 1) { toast(t('noSelPc'), true); return; }
    sendToPrinter(Array.from(await H.fs.read(await pcPath(s[0].name))), 0);
  };
  $('prDev').onchange = function () { H.setSettings({prDev: $('prDev').value}); };

  /* ================= firmware del Pro Micro ================= */
  async function firmware() {
    if (S.busy) { toast(t('busy'), true); return; }
    var keys = Object.keys(RF.FIRMWARE || {});
    var r = await ask({title: t('fwT'), html: t('fwB'), ok: t('fwGo'),
      fields: [{id: 'f', type: 'select', label: t('fwWhich'), value: 'rfiec', options: keys.map(function (k) { return [k, RF.FIRMWARE[k].name]; })}]});
    if (!r) return;
    var fw = RF.FIRMWARE[r.f], img = RF.firmwareImage(r.f), auto = false;
    if (S.conn && S.conn.kind === 'rfiec') {
      var port = S.conn.port; await disconnect(true);
      try { await RF.SerialLink.touch1200(port); auto = true; } catch (e) { log('err', errMsg(e)); }
    } else if (S.conn) await disconnect(true);
    await ask({title: t('fwT'), html: t(auto ? 'fwBootAuto' : 'fwBootManual'), buttons: [{v: 'cancel', label: t('close')}, {v: 'go', label: t('fwPick'), cls: 'pri'}],
      onSubmit: async function (v, out) {
        var link = null;
        try {
          var bp = await navigator.serial.requestPort({});
          link = new RF.SerialLink(bp, log);
          await link.open(57600);
          await new RF.Avr109(link, log).program(img, function (d, tot, ph) { out.textContent = t(ph === 'write' ? 'fwWriting' : 'fwVerify') + ' ' + Math.round(d / tot * 100) + '%'; });
          await link.close();
          out.textContent = t('fwDone', {n: fw.name}); out.className = 'out';
          log('info', t('fwDone', {n: fw.name}));
        } catch (e) {
          if (link) { try { await link.close(); } catch (x) {} }
          out.textContent = errMsg(e); out.className = 'out err';
        }
      }});
  }

  /* ================= schede, lingua, stato dei pulsanti ================= */
  function setTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'); });
    $('tabDrive').hidden = tab !== 'drive'; $('tabEmu').hidden = tab !== 'emu'; $('tabPrint').hidden = tab !== 'print';
    H.setSettings({tab: tab});
    updateUi();
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { setTab(b.dataset.tab); }; });
  function applyLang() {
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-t]').forEach(function (e) { e.textContent = t(e.dataset.t); });
    document.querySelectorAll('[data-tt]').forEach(function (e) { e.title = t(e.dataset.tt); });
    document.querySelectorAll('.lang button').forEach(function (b) { b.classList.toggle('on', b.dataset.lang === LANG); });
    $('logToggle').textContent = t($('log').hidden ? 'logShow' : 'logHide');
    pcRender(); renderDir(); renderEmu(); drawPaper(); updateUi();
  }
  function updateUi() {
    var c = S.conn, busy = S.busy, master = !!(c && c.master), emuRun = !!S.emu.run;
    $('ifName').textContent = ifaceLabel(); $('ifName').className = 'iname' + (c ? ' on' : '');
    $('ifLed').className = 'led' + (busy ? ' busy' : c ? ' on' : '');
    $('btnRfiec').hidden = !!c; $('btnXum').hidden = !!c || !navigator.usb; $('btnOff').hidden = !c;
    var pcSel = pcSelected(), files = pcSel.filter(function (e) { return !e.dir; });
    var imgs = files.filter(function (e) { return IMGEXT.test(e.name); });
    $('cpToDisk').disabled = busy || !c || !files.some(function (e) { return !IMGEXT.test(e.name); });
    $('cpToPc').disabled = busy || !master || !S.dirSel.size;
    $('imgFromDisk').disabled = busy || !c;
    $('imgToDisk').disabled = busy || !c || imgs.length !== 1;
    ['dDir', 'dStatus', 'dFormat', 'dValidate', 'dInit', 'dCmd', 'dReset'].forEach(function (id) { $(id).disabled = busy || !c; });
    $('dRename').disabled = busy || !master || S.dirSel.size !== 1;
    $('dScratch').disabled = busy || !master || !S.dirSel.size;
    $('devNr').disabled = busy;
    $('pcRename').disabled = pcSel.length !== 1; $('pcTrash').disabled = !pcSel.length;
    $('emuGo').hidden = emuRun; $('emuStop').hidden = !emuRun;
    $('emuGo').disabled = busy || !c || c.kind !== 'rfiec';
    ['emuDriveOn', 'emuDev', 'emuPrnOn', 'emuPrnDev', 'emuPrnModel'].forEach(function (id) { $(id).disabled = emuRun; });
    $('emuMount').disabled = imgs.length !== 1;
    $('emuEject').disabled = !S.emu.mounted;
    var pages = mps.pageCount();
    $('paperPdf').disabled = !pages; $('paperPrn').disabled = !pages; $('paperClear').disabled = !pages;
    $('prGo').disabled = busy || !c; $('prRaw').disabled = busy || !c || files.length !== 1; $('prLoad').disabled = files.length !== 1;
  }
  document.querySelectorAll('.lang button').forEach(function (b) {
    b.onclick = function () { if (b.dataset.lang === LANG) return; LANG = b.dataset.lang; H.setSettings({lang: LANG}); applyLang(); };
  });
  $('btnRfiec').onclick = connectRfiec;
  $('btnXum').onclick = connectXum;
  $('btnOff').onclick = function () { disconnect(); };
  $('logToggle').onclick = function () { $('log').hidden = !$('log').hidden; $('logToggle').textContent = t($('log').hidden ? 'logShow' : 'logHide'); };

  H.onMenu(function (cmd) {
    if (cmd === 'connectRfiec') connectRfiec();
    else if (cmd === 'connectXum') connectXum();
    else if (cmd === 'disconnect') disconnect();
    else if (cmd === 'busReset') busReset();
    else if (cmd === 'firmware') firmware();
    else if (cmd === 'pickFolder') $('pcPick').click();
    else if (cmd === 'log') $('logToggle').click();
    else if (cmd.indexOf('tab:') === 0) setTab(cmd.slice(4));
    else if (cmd.indexOf('lang:') === 0) { LANG = cmd.slice(5); applyLang(); }
  });

  // avvio
  (async function init() {
    var s = await H.settings();
    LANG = s.lang === 'en' ? 'en' : 'it';
    if (s.dev) $('devNr').value = String(s.dev);
    if (s.prDev) $('prDev').value = String(s.prDev);
    $('pcC64Only').checked = !!s.c64Only;
    var roots = await H.fs.roots(), sel = $('pcRoots');
    sel.innerHTML = '<option value="">⌂ …</option>' + roots.map(function (r) { return '<option value="' + esc(r.path) + '">' + esc(r.name) + '</option>'; }).join('');
    applyLang();
    setTab(s.tab || 'drive');
    var start = s.lastDir && await H.fs.exists(s.lastDir) ? s.lastDir : await H.fs.home();
    await pcLoad(start);
    if (s.emuDisk && await H.fs.exists(s.emuDisk)) {
      try { var data = await H.fs.read(s.emuDisk); S.emu.mounted = {path: s.emuDisk, disk: new RF.Disk(data, s.emuDisk)}; } catch (e) {}
    }
    renderEmu(); drawPaper(); updateUi();
    $('pcWrap').focus();
  })();

  // per le prove automatiche
  window.__rfiec = {S: S, mps: mps, refreshAll: refreshAll, pcLoad: pcLoad, setTab: setTab};
})();
