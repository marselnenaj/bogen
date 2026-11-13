/* global chrome, bogenSettings, bogenSave, bogenFetch, bogenBase */
'use strict';

var $ = function (id) { return document.getElementById(id); };
var popup = document.querySelector('.popup');
var pollTimer = null;
var lastOpen = '';

function browserName() {
  if (/Firefox\//.test(navigator.userAgent)) return 'Firefox';
  var brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  var named = brands.map(function (b) { return b.brand; }).find(function (b) { return !/Not.?A.?Brand|Chromium/i.test(b); });
  return named || 'Chromium';
}

function show(state, status) {
  popup.dataset.state = state;
  $('status').textContent = status || '';
}

function fail(message) {
  var el = $('error');
  el.textContent = message || '';
  el.hidden = !message;
}

async function ready(settings) {
  show('ready', 'Paired');
  $('reference').checked = settings.reference;
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0] || {};
    $('tab-title').textContent = tab.title || 'This tab';
    $('tab-url').textContent = (tab.url || '').replace(/^https?:\/\//, '');
    var web = !tab.url || /^https?:/i.test(tab.url);
    ['capture-page', 'capture-region', 'capture-element'].forEach(function (id) { $(id).disabled = !web; });
    if (!web) fail('Only web pages (http and https) can be captured.');
  } catch (e) { /* the tab stays unnamed */ }
}

async function poll() {
  clearTimeout(pollTimer);
  var settings = await bogenSettings();
  var pending = settings.pending;
  if (!pending) return show('unpaired', 'Not paired');
  if (Date.now() > pending.expiresAt) {
    await bogenSave({ pending: null });
    fail('The request ended. Pair again.');
    return show('unpaired', 'Not paired');
  }
  try {
    var answer = await bogenFetch(settings.base, '/api/extension/pair/' + pending.id, { headers: { 'X-Bogen-Poll': pending.poll } });
    if (answer.state === 'approved' && answer.token) {
      await bogenSave({ token: answer.token, pairingId: answer.pairingId || '', pending: null });
      fail('');
      return ready(await bogenSettings());
    }
    if (answer.state === 'denied' || answer.state === 'gone') {
      await bogenSave({ pending: null });
      fail(answer.state === 'denied' ? 'Bogen did not allow this extension.' : 'The request ended. Pair again.');
      return show('unpaired', 'Not paired');
    }
  } catch (e) {
    fail(e.message);
  }
  pollTimer = setTimeout(poll, 1500);
}

async function start() {
  var settings = await bogenSettings();
  $('base').value = settings.base;
  if (settings.token) {
    try {
      await bogenFetch(settings.base, '/api/extension/status', { token: settings.token });
      return ready(settings);
    } catch (e) {
      if (e.status === 401) {
        await bogenSave({ token: '', pairingId: '' });
        fail('This extension was revoked in Bogen. Pair it again.');
        return show('unpaired', 'Not paired');
      }
      fail(e.message);
      return ready(settings);
    }
  }
  if (settings.pending) {
    show('waiting', 'Waiting');
    $('code').textContent = settings.pending.code;
    $('waiting-hint').textContent = 'No editor open? Open ' + settings.base + ' in a tab. The request ends in 5 minutes.';
    return poll();
  }
  show('unpaired', 'Not paired');
}

$('pair').addEventListener('click', async function () {
  fail('');
  var base = bogenBase($('base').value);
  if (!base) return fail('Use the address of Bogen on this computer, such as http://127.0.0.1:29990.');
  $('pair').disabled = true;
  try {
    var asked = await bogenFetch(base, '/api/extension/pair', { method: 'POST', body: { name: 'Bogen capture in ' + browserName() } });
    await bogenSave({ base: base, pending: { id: asked.id, poll: asked.poll, code: asked.code, expiresAt: asked.expiresAt } });
    show('waiting', 'Waiting');
    $('code').textContent = asked.code;
    $('waiting-hint').textContent = 'No editor open? Open ' + base + ' in a tab. The request ends in 5 minutes.';
    poll();
  } catch (e) {
    fail(e.message);
  } finally {
    $('pair').disabled = false;
  }
});

$('cancel').addEventListener('click', async function () {
  clearTimeout(pollTimer);
  var settings = await bogenSettings();
  if (settings.pending) bogenFetch(settings.base, '/api/extension/pair/' + settings.pending.id, { method: 'DELETE', headers: { 'X-Bogen-Poll': settings.pending.poll } }).catch(function () {});
  await bogenSave({ pending: null });
  show('unpaired', 'Not paired');
});

$('reference').addEventListener('change', function () { bogenSave({ reference: $('reference').checked }); });

$('capture-page').addEventListener('click', function () {
  fail('');
  show('busy', 'Capturing');
  chrome.runtime.sendMessage({ type: 'bogen-capture', reference: $('reference').checked }).then(function (answer) {
    if (!answer || !answer.ok) {
      fail((answer && answer.error) || 'Not captured.');
      return bogenSettings().then(ready);
    }
    lastOpen = answer.result.openUrl;
    $('sent-summary').textContent = answer.summary + (answer.result.reference ? ' Kept as a reference.' : '');
    show('sent', 'Paired');
  });
});

['region', 'element'].forEach(function (mode) {
  $('capture-' + mode).addEventListener('click', function () {
    fail('');
    chrome.runtime.sendMessage({ type: 'bogen-pick', mode: mode }).then(function (answer) {
      if (answer && answer.ok) window.close();
      else fail((answer && answer.error) || 'This page cannot be captured.');
    });
  });
});

$('open').addEventListener('click', function () { if (lastOpen) chrome.tabs.create({ url: lastOpen }); });
$('again').addEventListener('click', function () { bogenSettings().then(ready); });

$('unpair').addEventListener('click', async function () {
  var settings = await bogenSettings();
  // Revokes it in Bogen too, so that it no longer shows as paired there.
  await bogenFetch(settings.base, '/api/extension/status', { method: 'DELETE', token: settings.token }).catch(function () {});
  await bogenSave({ token: '', pairingId: '' });
  fail('');
  show('unpaired', 'Not paired');
});

start();
