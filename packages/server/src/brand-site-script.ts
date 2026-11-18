/**
 * The one script a published brand site carries, as a file of the site (brand-site.js), never inline. It finds its
 * controls by what they are, since publishing keeps no data attributes: copy buttons (a button with a value and an
 * aria-label that starts with "Copy"), the type tester (a range and radios that name their sample in aria-controls)
 * and the construction switches (checkboxes that name what they show in aria-controls). It reads and writes nothing
 * else, loads nothing, and the page reads fully without it.
 */
export const BRAND_SITE_SCRIPT_PATH = 'brand-site.js';
export const BRAND_SITE_SCRIPT = `'use strict';
(function () {
  function byId(id) { return id ? document.getElementById(id) : null; }
  document.querySelectorAll('button[value][aria-label^="Copy"]').forEach(function (b) {
    b.addEventListener('click', function () {
      var label = b.textContent;
      var done = function (ok) { b.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(function () { b.textContent = label; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.value).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
  });
  document.querySelectorAll('input[type="range"][aria-controls]').forEach(function (r) {
    var apply = function () { var t = byId(r.getAttribute('aria-controls')); if (t) t.style.fontSize = r.value + 'px'; };
    r.addEventListener('input', apply);
  });
  document.querySelectorAll('input[type="radio"][aria-controls]').forEach(function (r) {
    r.addEventListener('change', function () { var t = byId(r.getAttribute('aria-controls')); if (t && r.checked) t.style.fontFamily = r.value; });
  });
  document.querySelectorAll('input[type="checkbox"][aria-controls]').forEach(function (c) {
    var apply = function () { var t = byId(c.getAttribute('aria-controls')); if (t) t.hidden = !c.checked; };
    c.addEventListener('change', apply);
  });
})();
`;
