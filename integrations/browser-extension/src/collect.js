// Runs in the tab, in the extension's own isolated world, after page-capture.js. It reads the page the way Bogen's
// capture does (the same script), then the files the page uses that the tab may read: same-origin images and fonts,
// and anything served with CORS. It changes nothing on the page and sends nothing anywhere: it hands its result back
// to the extension, which passes it to Bogen on this computer.
/* global __bogenCapture, __bogenSheetScan, __bogenReset */
'use strict';

(function () {
  var BUDGET = 40 * 1024 * 1024;
  var MAX_IMAGE = 8 * 1024 * 1024;
  var MAX_FONT = 16 * 1024 * 1024;
  var MAX_IMAGES = 400;
  var WEB_FONT = /^(woff2|woff|truetype|opentype)(-variations)?$/;

  function base64(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  /** The bytes of a file the tab may read, within what is left of the budget. */
  async function read(url, max, state) {
    try {
      var res = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' });
      if (!res.ok) return null;
      var declared = Number(res.headers.get('content-length') || 0);
      if (declared > max || declared > state.left) return null;
      var buf = await res.arrayBuffer();
      if (buf.byteLength > max || buf.byteLength > state.left) return null;
      state.left -= buf.byteLength;
      return { buf: buf, type: (res.headers.get('content-type') || '').split(';')[0].trim() };
    } catch (e) {
      return null;
    }
  }

  function imageUrls(node, out) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.src === 'string' && /^https?:/i.test(node.src)) out.add(node.src);
    var style = node.style || {};
    ['backgroundImage', 'maskImage', 'WebkitMaskImage', 'listStyleImage', 'borderImageSource'].forEach(function (key) {
      var v = style[key];
      if (typeof v !== 'string' || v.indexOf('url(') < 0) return;
      v.replace(/url\("?([^")]+)"?\)/g, function (_, u) { if (/^https?:/i.test(u)) out.add(u); return _; });
    });
    (node.children || []).forEach(function (c) { imageUrls(c, out); });
  }

  function swapImages(node, map) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.src === 'string' && map.has(node.src)) node.src = map.get(node.src);
    var style = node.style || {};
    ['backgroundImage', 'maskImage', 'WebkitMaskImage', 'listStyleImage', 'borderImageSource'].forEach(function (key) {
      var v = style[key];
      if (typeof v !== 'string' || v.indexOf('url(') < 0) return;
      style[key] = v.replace(/url\("?([^")]+)"?\)/g, function (m, u) { return map.has(u) ? 'url("' + map.get(u) + '")' : m; });
    });
    (node.children || []).forEach(function (c) { swapImages(c, map); });
  }

  /** The first web font file of each @font-face the page uses, by the address storeFonts on the server looks for. */
  function fontUrls(scan) {
    var used = new Set(scan.usedFamilies.map(function (f) { return f.toLowerCase(); }));
    var out = new Set();
    scan.faces.forEach(function (face) {
      if (!used.has(face.family.toLowerCase())) return;
      var re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)(?:\s*format\(\s*["']?([\w-]+)["']?\s*\))?/g;
      var m;
      while ((m = re.exec(face.src))) {
        var u = m[1] || m[2] || m[3] || '';
        var format = (m[4] || '').toLowerCase();
        if (!u || u.indexOf('data:') === 0 || (format && !WEB_FONT.test(format))) continue;
        try {
          var abs = new URL(u, face.base).href.split('#')[0];
          if (!/^https:\/\/fonts\.gstatic\.com\//.test(abs)) out.add(abs);
        } catch (e) { /* not a URL */ }
        break;
      }
    });
    return Array.from(out);
  }

  async function pool(items, size, fn) {
    var i = 0;
    async function next() { while (i < items.length) { var item = items[i++]; await fn(item); } }
    var workers = [];
    for (var w = 0; w < Math.min(size, items.length); w++) workers.push(next());
    await Promise.all(workers);
  }

  /**
   * options: { mode: 'page' | 'region' | 'element', root?: selector of the picked element, region?: viewport rect }.
   * Answers what POST /api/extension/capture takes, less the screenshot, plus the viewport rect to crop it to.
   */
  globalThis.__bogenCollect = async function (options) {
    options = options || {};
    var root = options.root ? document.querySelector(options.root) : null;
    var captured = __bogenCapture({ reset: __bogenReset, known: [], liveTokens: false, root: options.root || null });
    var sheets = [];
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sheet = document.styleSheets[s];
      try { void sheet.cssRules; } catch (e) {
        if (sheet.href) {
          try { var r = await fetch(sheet.href, { credentials: 'same-origin' }); if (r.ok) sheets.push({ url: sheet.href.split('#')[0], text: await r.text() }); } catch (e2) { /* left to the server */ }
        }
      }
    }
    var scan = __bogenSheetScan({ sheets: sheets, maxRules: 600, maxLayers: 40, maxDeclaration: 2000 });
    var state = { left: BUDGET };
    var fonts = {};
    await pool(fontUrls(scan), 4, async function (u) {
      var got = await read(u, MAX_FONT, state);
      if (got) fonts[u] = base64(got.buf);
    });
    var urls = new Set();
    imageUrls(captured.root, urls);
    var inlined = new Map();
    await pool(Array.from(urls).slice(0, MAX_IMAGES), 6, async function (u) {
      var got = await read(u, MAX_IMAGE, state);
      if (got && /^(image|video)\//.test(got.type)) inlined.set(u, 'data:' + got.type + ';base64,' + base64(got.buf));
    });
    swapImages(captured.root, inlined);
    var rect = null;
    var width = document.documentElement.clientWidth;
    if (root) {
      var b = root.getBoundingClientRect();
      rect = { x: b.left, y: b.top, width: b.width, height: b.height };
      width = b.width;
    } else if (options.mode === 'region' && options.region) {
      rect = options.region;
    } else {
      rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    }
    var out = {
      url: location.href, title: document.title, mode: options.mode || 'page', width: Math.max(20, Math.round(width)),
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      capture: { root: captured.root, tokens: captured.tokens, title: captured.title, links: captured.links.slice(0, 5000) },
      scan: scan, fonts: fonts, crop: rect, dpr: devicePixelRatio, viewport: innerWidth,
    };
    if (options.mode === 'region' && options.region) out.region = { x: options.region.x + scrollX, y: options.region.y + scrollY, width: options.region.width, height: options.region.height };
    return out;
  };
})();
