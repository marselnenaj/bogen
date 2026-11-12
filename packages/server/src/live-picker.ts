/**
 * Runs inside the person's own page, served by the proxy. It draws a hover outline, and tells the Bogen tab what was
 * clicked. It knows nothing of Bogen's API or the project folder, and what it says is only ever shown to the person,
 * who still has to ask for something: a page cannot start a run by talking to its parent.
 */
export function pickerScript(editorOrigin: string): string {
  return `(() => {
  if (window.__bogenPicker) return;
  window.__bogenPicker = true;
  const parentOrigin = ${JSON.stringify(editorOrigin)};
  if (window.parent === window) return;
  const STYLES = ['display','position','top','left','right','bottom','width','height','minWidth','maxWidth','margin','padding','gap','flexDirection','alignItems','justifyContent','gridTemplateColumns','color','backgroundColor','backgroundImage','border','borderRadius','boxShadow','opacity','overflow','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','textTransform','textDecorationLine','cursor','transition','transform','zIndex'];
  const HTML_LIMIT = 6000;
  let picking = false;
  let host = null;
  let box = null;
  let label = null;

  function outline() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-bogen-picker', '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:1.5px solid #2f80ed;background:rgba(47,128,237,.08);display:none;pointer-events:none;box-sizing:border-box';
    label = document.createElement('div');
    label.style.cssText = 'position:fixed;display:none;background:#2f80ed;color:#fff;font:12px/18px system-ui,sans-serif;padding:0 5px;border-radius:2px;white-space:nowrap;pointer-events:none';
    shadow.append(box, label);
    document.documentElement.appendChild(host);
  }

  function selectorOf(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.localName;
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === node.localName) : [];
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function fromUrl(url, via) {
    const m = /^(?:https?:\\/\\/[^/]+)?\\/?(.*?)(?:\\?[^:]*)?:(\\d+):(\\d+)\\)?$/.exec(String(url).trim());
    return m ? { file: m[1], line: Number(m[2]), column: Number(m[3]), via } : null;
  }

  // Each framework leaves this somewhere else, and only in development.
  function sourceOf(el) {
    for (let node = el, hops = 0; node && node.nodeType === 1 && hops < 12; node = node.parentElement, hops++) {
      const attr = node.getAttribute('data-source') || node.getAttribute('data-source-file') || node.getAttribute('data-locator') || node.getAttribute('data-inspector-relative-path') || node.getAttribute('data-sveltekit-source');
      if (attr) {
        const parsed = /^(.*?):(\\d+)(?::(\\d+))?$/.exec(attr);
        const line = node.getAttribute('data-inspector-line');
        return parsed ? { file: parsed[1], line: Number(parsed[2]), column: parsed[3] ? Number(parsed[3]) : undefined, via: 'attribute' } : { file: attr, line: line ? Number(line) : undefined, via: 'attribute' };
      }
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (key) {
        for (let fiber = node[key], up = 0; fiber && up < 20; fiber = fiber.return, up++) {
          const s = fiber._debugSource;
          if (s && s.fileName) return { file: s.fileName, line: s.lineNumber, column: s.columnNumber, via: 'react' };
          const stack = fiber._debugStack && fiber._debugStack.stack;
          if (typeof stack === 'string') {
            const frames = stack.split('\\n').slice(1);
            for (const frame of frames) {
              const at = /(https?:\\/\\/[^\\s)]+:\\d+:\\d+)/.exec(frame);
              if (at && !/node_modules|react-dom|react-jsx|@react-refresh/.test(at[1])) { const found = fromUrl(at[1], 'react'); if (found) return found; }
            }
          }
        }
      }
      const vue = node.__vueParentComponent;
      if (vue && vue.type && vue.type.__file) return { file: vue.type.__file, via: 'vue' };
      const svelte = node.__svelte_meta;
      if (svelte && svelte.loc) return { file: svelte.loc.file, line: svelte.loc.line, column: svelte.loc.column, via: 'svelte' };
    }
    return null;
  }

  function describe(el) {
    const computed = getComputedStyle(el);
    const styles = {};
    for (const name of STYLES) { const v = computed[name]; if (v && v !== 'none' && v !== 'normal' && v !== 'auto') styles[name] = v; }
    const r = el.getBoundingClientRect();
    return {
      selector: selectorOf(el), tag: el.localName, text: (el.innerText || '').slice(0, 400),
      html: el.outerHTML.length > HTML_LIMIT ? el.outerHTML.slice(0, HTML_LIMIT) + '<!-- cut here -->' : el.outerHTML,
      styles, source: sourceOf(el), box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, url: location.pathname + location.search,
    };
  }

  function target(e) {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    return el && el.nodeType === 1 && el !== document.documentElement ? el : null;
  }

  function show(el) {
    outline();
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    label.style.display = 'block';
    label.textContent = el.localName + ' ' + Math.round(r.width) + ' x ' + Math.round(r.height);
    label.style.left = Math.max(0, r.left) + 'px'; label.style.top = Math.max(0, r.top - 20) + 'px';
  }

  function hide() { if (box) { box.style.display = 'none'; label.style.display = 'none'; } }
  function say(message) { window.parent.postMessage({ bogenLive: message.kind, ...message }, parentOrigin); }

  const onMove = (e) => { const el = target(e); if (el) show(el); };
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onClick = (e) => {
    const el = target(e);
    swallow(e);
    if (!el) return;
    say({ kind: 'pick', element: describe(el) });
    show(el);
  };
  const onKey = (e) => { if (e.key === 'Escape') { setPicking(false); say({ kind: 'mode', picking: false }); } };

  function setPicking(on) {
    if (picking === on) return;
    picking = on;
    for (const [type, fn] of [['mousemove', onMove], ['mousedown', swallow], ['mouseup', swallow], ['click', onClick], ['pointerdown', swallow], ['pointerup', swallow]]) {
      if (on) window.addEventListener(type, fn, true); else window.removeEventListener(type, fn, true);
    }
    if (on) window.addEventListener('keydown', onKey, true); else window.removeEventListener('keydown', onKey, true);
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) hide();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== parentOrigin || !e.data || e.data.bogenLive !== 'mode') return;
    setPicking(Boolean(e.data.picking));
  });
  say({ kind: 'ready', url: location.pathname + location.search, title: document.title });
})();
`;
}
