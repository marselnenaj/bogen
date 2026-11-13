// The extension's background: reads a tab when the person asks (activeTab), takes its picture, and sends both to Bogen
// on this computer with the pairing token. It talks to no other address: the extension's own content security policy
// allows connections to 127.0.0.1 and localhost only.
/* global chrome, importScripts, bogenSettings, bogenFetch, OffscreenCanvas */
'use strict';

if (typeof importScripts === 'function') importScripts('shared.js');

function bytesToBase64(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** What the tab shows, cut to the captured part. A tab that cannot be pictured still gets its layers. */
async function screenshot(tab, crop, dpr, viewport) {
  var shot;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    return undefined;
  }
  if (!crop || typeof OffscreenCanvas === 'undefined') return shot;
  try {
    // Decoded here rather than fetched: the extension's own policy lets it fetch nothing but Bogen.
    var raw = atob(shot.slice(shot.indexOf(',') + 1));
    var png = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) png[i] = raw.charCodeAt(i);
    var bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    var scale = viewport ? bitmap.width / viewport : (dpr || 1);
    var sx = Math.max(0, Math.round(crop.x * scale)), sy = Math.max(0, Math.round(crop.y * scale));
    var sw = Math.min(bitmap.width - sx, Math.round(crop.width * scale)), sh = Math.min(bitmap.height - sy, Math.round(crop.height * scale));
    if (sw < 2 || sh < 2) return shot;
    var canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    var blob = await canvas.convertToBlob({ type: 'image/png' });
    return 'data:image/png;base64,' + bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch (e) {
    return shot;
  }
}

/** Reads the tab with Bogen's capture script and sends the result. options: { mode, root?, region?, mark? }. */
async function captureTab(tab, options) {
  var settings = await bogenSettings();
  if (!settings.token) throw new Error('Pair with Bogen first: open this extension\'s popup.');
  if (!/^https?:/i.test(tab.url || '') && tab.url !== undefined) throw new Error('Only web pages (http and https) can be captured.');
  var target = { tabId: tab.id };
  await chrome.scripting.executeScript({ target: target, files: ['page-capture.js', 'collect.js'] });
  var ran = await chrome.scripting.executeScript({ target: target, func: function (opts) { return globalThis.__bogenCollect(opts); }, args: [{ mode: options.mode, root: options.root || null, region: options.region || null }] });
  var page = ran && ran[0] && ran[0].result;
  if (!page) throw new Error('The page gave nothing to capture.');
  var crop = options.mode === 'page' ? null : page.crop;
  var shot = await screenshot(tab, crop, page.dpr, page.viewport);
  var body = {
    url: page.url, title: page.title, mode: page.mode, width: page.width, colorScheme: page.colorScheme,
    capture: page.capture, scan: page.scan, fonts: page.fonts, reference: options.reference === undefined ? settings.reference : Boolean(options.reference), tags: settings.tags,
  };
  if (page.region) body.region = page.region;
  if (shot) body.screenshot = shot;
  var result = await bogenFetch(settings.base, '/api/extension/capture', { method: 'POST', token: settings.token, body: body });
  result.openUrl = settings.base + result.open;
  return result;
}

function summary(result) {
  var parts = [result.layers + ' layers', result.images + ' images'];
  if (result.fonts && result.fonts.length) parts.push(result.fonts.length + (result.fonts.length === 1 ? ' font family' : ' font families'));
  return parts.join(', ') + '.' + (result.failedImages ? ' ' + result.failedImages + ' images could not be read.' : '');
}

async function activeTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error('No tab to capture.');
  return tabs[0];
}

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
  if (!message || typeof message.type !== 'string') return false;
  // From the popup: capture the whole page, or start picking a region or an element.
  if (message.type === 'bogen-capture' && !sender.tab) {
    activeTab().then(function (tab) { return captureTab(tab, { mode: 'page', reference: message.reference }); })
      .then(function (result) { reply({ ok: true, result: result, summary: summary(result) }); }, function (e) { reply({ ok: false, error: e.message, status: e.status }); });
    return true;
  }
  if (message.type === 'bogen-pick' && !sender.tab) {
    activeTab().then(async function (tab) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: function (mode) { globalThis.__bogenPickMode = mode; }, args: [message.mode === 'element' ? 'element' : 'region'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
    }).then(function () { reply({ ok: true }); }, function (e) { reply({ ok: false, error: e.message }); });
    return true;
  }
  // From the picker in a tab, once the person chose.
  if (message.type === 'bogen-picked' && sender.tab) {
    var tab = sender.tab;
    captureTab(tab, { mode: message.mode, root: message.root, region: message.region })
      .then(function (result) { return chrome.tabs.sendMessage(tab.id, { type: 'bogen-result', mark: message.mark, summary: summary(result), open: result.openUrl }); },
        function (e) { return chrome.tabs.sendMessage(tab.id, { type: 'bogen-result', mark: message.mark, error: e.message }); })
      .catch(function () {});
    return false;
  }
  return false;
});

// For tests and for a person in the extension's console: the same capture, on a tab by id.
globalThis.bogenCaptureTab = function (tabId, options) {
  return chrome.tabs.get(tabId).then(function (tab) { return captureTab(tab, options || { mode: 'page' }); });
};
