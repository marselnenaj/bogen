// Shared by the popup and the background. Plain script, no modules, so the same file works in Chromium and Firefox.
/* global chrome */
'use strict';

var BOGEN_DEFAULT_BASE = 'http://127.0.0.1:29990';

/** Bogen on this computer only: a loopback address with a port, nothing else. */
function bogenBase(input) {
  var url;
  try { url = new URL(String(input || '').trim()); } catch (e) { return null; }
  if (url.protocol !== 'http:') return null;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) return null;
  return url.protocol + '//' + url.host;
}

function bogenSettings() {
  return chrome.storage.local.get(['base', 'token', 'pairingId', 'pending', 'reference', 'tags']).then(function (s) {
    return { base: bogenBase(s.base) || BOGEN_DEFAULT_BASE, token: s.token || '', pairingId: s.pairingId || '', pending: s.pending || null, reference: s.reference !== false, tags: Array.isArray(s.tags) ? s.tags : [] };
  });
}

function bogenSave(patch) {
  return chrome.storage.local.set(patch);
}

/** A call to Bogen. Errors carry the server's own message, and a status. */
function bogenFetch(base, path, options) {
  var safe = bogenBase(base);
  if (!safe) return Promise.reject(new Error('Bogen\'s address must be http://127.0.0.1 or http://localhost with a port.'));
  options = options || {};
  var headers = Object.assign({}, options.headers || {});
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(safe + path, { method: options.method || 'GET', headers: headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), credentials: 'omit', cache: 'no-store' })
    .catch(function () { throw Object.assign(new Error('Bogen is not running at ' + safe + '. Start it with: bogen serve'), { status: 0 }); })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw Object.assign(new Error(data.error || ('Bogen answered ' + res.status)), { status: res.status });
        return data;
      });
    });
}
