// Runs in the tab when the person chose Region or Element: an overlay to drag a rectangle or click an element, then a
// short note with the result. Everything it draws sits in one shadow root and is gone before the screenshot.
/* global chrome */
'use strict';

(function () {
  if (globalThis.__bogenPicker) { globalThis.__bogenPicker.start(globalThis.__bogenPickMode); return; }
  var host = null, shadow = null, cleanup = null;

  function mount() {
    host = document.createElement('bogen-capture-overlay');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' +
      ':host{all:initial}*{box-sizing:border-box;font-family:"Source Sans 3",system-ui,sans-serif;font-size:13px;line-height:1.45}' +
      '.layer{position:fixed;inset:0;cursor:crosshair}' +
      '.box{position:fixed;border:2px solid #5b8ff5;background:rgba(91,143,245,.12);pointer-events:none;display:none}' +
      '.bar{position:fixed;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:12px;align-items:center;padding:8px 12px;background:#1c1c1b;color:#e8e7e4;border:1px solid #33332f;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:auto}' +
      '.bar{max-width:calc(100vw - 24px)}.bar strong{white-space:nowrap}.bar span{color:#9c9b97}button{all:unset;cursor:pointer;padding:2px 8px;border-radius:4px;background:#2d2d2c;color:#e8e7e4}button:focus-visible{outline:2px solid #5b8ff5}' +
      'a{color:#7d9ff7}</style>' +
      '<div class="layer" part="layer"></div><div class="box"></div><div class="bar" role="status"><strong></strong><span></span><button type="button">Cancel</button></div>';
    document.documentElement.appendChild(host);
  }

  function unmount() {
    if (cleanup) cleanup();
    cleanup = null;
    if (host) host.remove();
    host = shadow = null;
  }

  function say(title, detail, link) {
    if (!host) mount();
    var layer = shadow.querySelector('.layer');
    layer.style.display = 'none';
    host.style.inset = 'auto';
    host.style.left = '0';
    host.style.right = '0';
    host.style.top = '0';
    shadow.querySelector('.box').style.display = 'none';
    shadow.querySelector('strong').textContent = title;
    var span = shadow.querySelector('span');
    span.textContent = detail || '';
    if (link) {
      var a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open in Bogen';
      span.append(' ', a);
    }
    var button = shadow.querySelector('button');
    button.textContent = 'Close';
    button.onclick = unmount;
  }

  /** Waits two frames, so that the overlay is off the screen before the extension takes its picture. */
  function afterPaint() {
    return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  }

  function finish(message) {
    unmount();
    afterPaint().then(function () {
      say('Capturing', 'Sending to Bogen on this computer.');
      // The note itself is not in the picture: it is drawn after the extension took it.
      host.style.visibility = 'hidden';
      chrome.runtime.sendMessage(message).catch(function () {});
    });
  }

  function start(mode) {
    unmount();
    mount();
    var layer = shadow.querySelector('.layer');
    var box = shadow.querySelector('.box');
    shadow.querySelector('strong').textContent = mode === 'region' ? 'Drag over the part to capture' : 'Click the element to capture';
    shadow.querySelector('span').textContent = mode === 'region' ? 'Esc cancels' : 'Up arrow takes the parent, Enter captures, Esc cancels';
    shadow.querySelector('button').onclick = unmount;
    var show = function (r) { box.style.display = 'block'; box.style.left = r.x + 'px'; box.style.top = r.y + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px'; };
    var current = null;
    var pick = function (el) {
      if (!el || el === document.documentElement) return;
      var mark = 'p' + Math.random().toString(36).slice(2, 10);
      el.setAttribute('data-bogen-pick', mark);
      finish({ type: 'bogen-picked', mode: 'element', root: '[data-bogen-pick="' + mark + '"]', mark: mark });
    };
    var outline = function (el) { current = el; var r = el.getBoundingClientRect(); show({ x: r.left, y: r.top, width: r.width, height: r.height }); };
    var onKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); unmount(); return; }
      if (mode !== 'element' || !current) return;
      if (e.key === 'ArrowUp' && current.parentElement && current.parentElement !== document.documentElement) { e.preventDefault(); outline(current.parentElement); }
      if (e.key === 'Enter') { e.preventDefault(); pick(current); }
    };
    document.addEventListener('keydown', onKey, true);
    var from = null;
    var under = function (e) {
      // The overlay steps aside for a moment, so that the page's own element under the pointer answers.
      host.style.pointerEvents = 'none';
      var el = document.elementFromPoint(e.clientX, e.clientY);
      host.style.pointerEvents = '';
      return el && el !== host ? el : null;
    };
    layer.addEventListener('pointerdown', function (e) {
      if (mode !== 'region') return;
      from = { x: e.clientX, y: e.clientY };
      layer.setPointerCapture(e.pointerId);
    });
    layer.addEventListener('pointermove', function (e) {
      if (mode === 'region') {
        if (from) show({ x: Math.min(from.x, e.clientX), y: Math.min(from.y, e.clientY), width: Math.abs(e.clientX - from.x), height: Math.abs(e.clientY - from.y) });
        return;
      }
      var el = under(e);
      if (el && el !== current && !(current && current.contains(el) && e.movementX === 0 && e.movementY === 0)) outline(el);
    });
    layer.addEventListener('pointerup', function (e) {
      if (mode !== 'region' || !from) return;
      var rect = { x: Math.min(from.x, e.clientX), y: Math.min(from.y, e.clientY), width: Math.abs(e.clientX - from.x), height: Math.abs(e.clientY - from.y) };
      from = null;
      if (rect.width < 8 || rect.height < 8) return;
      finish({ type: 'bogen-picked', mode: 'region', region: rect });
    });
    layer.addEventListener('click', function (e) {
      if (mode !== 'element') return;
      pick(current || under(e));
    });
    cleanup = function () { document.removeEventListener('keydown', onKey, true); };
  }

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== 'bogen-result') return;
    if (message.mark) { var el = document.querySelector('[data-bogen-pick="' + message.mark + '"]'); if (el) el.removeAttribute('data-bogen-pick'); }
    if (host) host.style.visibility = '';
    if (message.error) say('Not captured', message.error);
    else say('Captured to Bogen', message.summary, message.open);
  });

  globalThis.__bogenPicker = { start: start };
  start(globalThis.__bogenPickMode);
})();
