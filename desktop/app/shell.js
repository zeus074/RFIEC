// App shell: two programs in iframes (kept alive, so a connection survives a tab switch), language, port chooser.
(function () {
  'use strict';
  var A = window.rfiecApp || {settings: function () { return Promise.resolve({lang: 'it'}); }, setLang: function () {}, choose: function () {}, onChoose: function () {}, onTab: function () {}, onLang: function () {}};
  var $ = function (id) { return document.getElementById(id); };
  var lang = 'it';
  var T = {
    it: {serial: 'Scegli la porta seriale', usb: 'Scegli il dispositivo USB',
         serialHelp: 'La RFIEC compare come «RFIEC»; durante l\'installazione del firmware il bootloader del Pro Micro compare per circa 8 secondi.',
         usbHelp: 'La xum1541 (o ZoomFloppy) compare con il codice 16d0:0504. Su Windows serve il driver WinUSB.',
         all: 'mostra tutte le porte', none: 'Nessuna porta trovata. Collega la scheda e riapri questa finestra.', ok: 'Collega', cancel: 'Annulla',
         rfiec: 'RFIEC', boot: 'bootloader', xum: 'xum1541', arduino: 'Arduino'},
    en: {serial: 'Choose the serial port', usb: 'Choose the USB device',
         serialHelp: 'The RFIEC shows up as "RFIEC"; while installing firmware the Pro Micro bootloader appears for about 8 seconds.',
         usbHelp: 'The xum1541 (or ZoomFloppy) shows up as 16d0:0504. On Windows it needs the WinUSB driver.',
         all: 'show all ports', none: 'No port found. Plug the board in and open this window again.', ok: 'Connect', cancel: 'Cancel',
         rfiec: 'RFIEC', boot: 'bootloader', xum: 'xum1541', arduino: 'Arduino'}
  };
  function t(k) { return T[lang][k]; }

  // ---------- tabs ----------
  function tab(name) {
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'); });
    $('fDrive').hidden = name !== 'drive';
    $('fPrinter').hidden = name !== 'printer';
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { tab(b.dataset.tab); }; });
  window.addEventListener('message', function (e) { if (e.data && e.data.rfiecTab) tab(e.data.rfiecTab); });
  A.onTab(tab);

  // ---------- language ----------
  function setLang(l, reload) {
    lang = l === 'en' ? 'en' : 'it';
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-' + lang + ']').forEach(function (e) { e.textContent = e.getAttribute('data-' + lang); });
    document.querySelectorAll('.lang button').forEach(function (b) { b.classList.toggle('on', b.dataset.lang === lang); });
    if (reload) {
      $('fDrive').src = 'drive.html?lang=' + lang;
      $('fPrinter').src = 'printer.html?lang=' + lang;
    }
  }
  document.querySelectorAll('.lang button').forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.lang === lang) return;
      var msg = lang === 'it' ? 'Cambiare lingua ricarica i programmi e chiude i collegamenti aperti. Continuare?'
                              : 'Changing language reloads the programs and closes open connections. Continue?';
      if (!confirm(msg)) return;
      A.setLang(b.dataset.lang); setLang(b.dataset.lang, true);
    };
  });
  A.onLang(function (l) { setLang(l, true); });

  // ---------- port / device chooser ----------
  var req = null;
  function tagFor(it) {
    if (req.kind === 'usb') return it.vid === '16d0' ? t('xum') : '';
    if (/rfiec/i.test(it.label + it.name)) return t('rfiec');
    if (it.vid === '2341' && /^00/.test(it.pid)) return t('boot');      // Caterina bootloader: 2341:0036 / 0037
    return it.known ? t('arduino') : '';
  }
  function draw() {
    var showAll = $('chAll').checked, list = $('chList');
    var items = req.items.filter(function (it) { return showAll || it.known || req.kind === 'usb'; });
    if (!items.length && !showAll) items = req.items;
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = '<div class="empty"></div>'; list.firstChild.textContent = t('none'); }
    items.forEach(function (it, i) {
      var l = document.createElement('label'), tg = tagFor(it);
      if (it.known) l.className = 'known';
      l.innerHTML = '<input type="radio" name="p"><span><span class="n"></span><br><span class="d"></span></span>' + (tg ? '<span class="tag"></span>' : '');
      l.querySelector('input').value = it.id;
      l.querySelector('input').checked = i === 0;
      l.querySelector('.n').textContent = it.name;
      l.querySelector('.d').textContent = [it.label, it.vid !== '0000' ? it.vid + ':' + it.pid : ''].filter(Boolean).join(' · ');
      if (tg) l.querySelector('.tag').textContent = tg;
      l.ondblclick = function () { finish(it.id); };
      list.appendChild(l);
    });
    $('chOk').disabled = !items.length;
  }
  function finish(id) {
    if (!req) return;
    req = null;
    A.choose(id || '');
    if ($('chooser').open) $('chooser').close();
  }
  A.onChoose(function (r) {
    req = r;
    $('chTitle').textContent = t(r.kind === 'usb' ? 'usb' : 'serial');
    $('chHelp').textContent = t(r.kind === 'usb' ? 'usbHelp' : 'serialHelp');
    $('chAllL').textContent = t('all');
    $('chAll').parentNode.hidden = r.kind === 'usb';
    $('chAll').checked = false;
    $('chOk').textContent = t('ok'); $('chCancel').textContent = t('cancel');
    draw();
    if (!$('chooser').open) $('chooser').showModal();
  });
  $('chAll').onchange = draw;
  $('chooser').addEventListener('close', function () {
    if (!req) return;
    var sel = document.querySelector('#chList input:checked');
    finish($('chooser').returnValue === 'ok' && sel ? sel.value : '');
  });

  A.settings().then(function (s) { setLang(s.lang || 'it', true); tab('drive'); });
})();
