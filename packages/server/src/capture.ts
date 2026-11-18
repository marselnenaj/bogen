import type { Page } from 'puppeteer-core';
import { nameSpecTree, RESET_CSS, sanitizeSvgMarkup, type BogenDoc, type NewNode, type StoredFontFace, type TokenKind } from '@bogen/core';
import { fetchPublic, isPublicUrl } from './net-guard.ts';
import { lengthKind } from './mcp/css-vars.ts';
import { findBrowser, sharesLocalPorts, TILE, type Renderer } from './render.ts';
import { fontFetcher, scanArgs, SHEET_SCAN, storeFonts, watchResources, type FontReport, type PageResources, type ScannedRule, type SheetScan } from './capture-sheets.ts';
import type { Storage } from './storage.ts';

/**
 * Capture: opens a live page in headless Chromium and turns what it renders into editable layers.
 * Computed styles are compared with what the canvas would give that element anyway, so layers only
 * carry what matters, sizes stay automatic wherever removing them changes nothing, and the page's
 * custom properties come along as tokens that the layers refer to.
 */
export interface CaptureOptions {
  url: string;
  /** Match colours to the file's tokens by the page's own values of those variables. */
  liveTokens?: boolean;
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
  /** Whole-page capture of a dev server. Only for requests from the person, never for agents. */
  allowLocal?: boolean;
  /** Keep the page's own font files with the document. On unless turned off. */
  captureFonts?: boolean;
  /** Store the page's images with the file. On unless turned off; off leaves their addresses as they are. */
  media?: boolean;
}

export interface CaptureResult {
  root: NewNode & { key?: number };
  fontFaces: StoredFontFace[];
  fonts: FontReport;
  /** Hover and focus rules, with the capture's element numbers. See `resolveRuleLayers`. */
  rules: ScannedRule[];
  url: string;
  /** Every link on the page as an absolute URL, for finding the rest of a site. */
  links: string[];
  /** The HTTP status of the page, when it came from the network. */
  status?: number;
  /** Where the page ended up after redirects. */
  finalUrl?: string;
  tokens: { name: string; kind: TokenKind; value: string }[];
  title: string;
  /** PNG of the page as the browser showed it, for comparing against the result. */
  original: Uint8Array;
  stats: { layers: number; images: number; failedImages: string[] };
}

// A string, not a function: it must reach the browser exactly as written, untouched by the bundler. The browser
// extension (integrations/browser-extension) runs this same text in the person's own tab, so it leaves the page as it
// found it, and it can start at one element (`args.root`, a selector) instead of the body.
export const CAPTURE = String.raw`(args) => {
  const SKIP = /^(-webkit-(?!font-smoothing|text-stroke|text-fill-color|background-clip|line-clamp|box-orient)|animation|transition|view-|timeline|scroll-|anchor|position-|interpolate|overscroll|perspective-origin|block-size|inline-size|min-block|min-inline|max-block|max-inline|margin-block|margin-inline|padding-block|padding-inline|border-block|border-inline|inset-|cursor|pointer-events|user-select|caret|forced-color|color-scheme|text-size-adjust|white-space-collapse|text-wrap-mode|font-optical-sizing|tab-size|orphans|widows|will-change|contain|content-visibility|field-sizing|app-region|shape-|counter-|quotes|ruby-|image-|speak|math-|dynamic-range|hyphenate-|buffered|stop-|flood-|lighting-|marker|paint-order|vector-effect|r$|rx$|ry$|cx$|cy$|d$|x$|y$|mask-(type|repeat|position|size|origin|clip|composite|mode)$|row-rule|text-emphasis-|column-rule-(color|width|style)$)/;
  const INHERITED = new Set(['color','font-family','font-feature-settings','font-kerning','font-size','font-stretch','font-style','font-synthesis-weight','font-synthesis-style','font-synthesis-small-caps','font-variant-caps','font-variant-east-asian','font-variant-ligatures','font-variant-numeric','font-variation-settings','font-weight','hyphens','letter-spacing','line-break','line-height','list-style-image','list-style-position','list-style-type','overflow-wrap','text-align','text-align-last','text-indent','text-rendering','text-shadow','text-transform','text-wrap-style','text-wrap','visibility','word-break','word-spacing','-webkit-font-smoothing','-webkit-text-fill-color','-webkit-text-stroke-color','-webkit-text-stroke-width','direction','writing-mode','text-orientation','text-decoration-skip-ink','text-underline-position','text-emphasis-color','text-emphasis-style','text-emphasis-position','text-combine-upright','text-autospace','text-spacing-trim','font-palette','font-variant-alternates','font-variant-position','font-variant-emoji','font-size-adjust','font-language-override','border-collapse','border-spacing','caption-side','empty-cells','image-orientation','word-wrap','ruby-position']);
  const COLOR_PROPS = new Set(['color','background-color','border-top-color','border-right-color','border-bottom-color','border-left-color','outline-color','text-decoration-color','-webkit-text-fill-color','-webkit-text-stroke-color']);
  const SVG_PROPS = ['fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','stroke-miterlimit','opacity','fill-opacity','stroke-opacity','fill-rule','clip-rule','font-family','font-size','font-weight','letter-spacing','text-anchor','transform','transform-origin','transform-box','mix-blend-mode','paint-order','stop-color','stop-opacity','visibility','display'];
  const ATTRS = ['alt','aria-label','role','title','placeholder','value','type','poster','loop','autoplay','muted','controls','datetime','target','rel','aria-disabled','aria-pressed','aria-selected','aria-checked','aria-current','aria-hidden','translate'];
  // Controls that can be switched off. One that is keeps that on the canvas, where checks can tell an inactive control.
  const DISABLEABLE = /^(button|input|select|textarea|fieldset|optgroup|option)$/;
  const camel = (p) => p.startsWith('-webkit-') ? 'Webkit' + p.slice(8).replace(/(^|-)([a-z])/g, (_, _d, c) => c.toUpperCase()) : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const unsafe = /javascript:|expression\s*\(|@import/i;
  let layers = 0;
  const LIMIT = 20000;
  // Changes made to the live page on the way, put back at the end.
  const restore = [];

  // What each element looks like on the canvas with no style of its own.
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  document.documentElement.appendChild(frame);
  const bdoc = frame.contentDocument;
  bdoc.open();
  bdoc.write('<!doctype html><html><head><style>' + args.reset + '</style></head><body></body></html>');
  bdoc.close();
  const baselines = new Map();
  const baseline = (tag, disabled, type, size) => {
    const key = (disabled ? tag + ':disabled' : tag) + (type ? '[' + type + ']' : '') + (size ? '@' + size : '');
    const known = baselines.get(key);
    if (known) return known;
    // Some elements look different on their own than in the element that holds them: an option is laid out by its select.
    // Its defaults are in em, such as the gap of 0.5em, so it is compared at the size it is set in.
    const holder = tag === 'li' ? bdoc.createElement('ul') : tag === 'option' || tag === 'optgroup' ? bdoc.createElement('select') : bdoc.body;
    if (size && holder !== bdoc.body) holder.style.fontSize = size;
    if (holder !== bdoc.body) bdoc.body.appendChild(holder);
    const el = bdoc.createElement(/^[a-z][a-z0-9]*$/.test(tag) ? tag : 'div');
    // A disabled control looks different with no style of its own, and it stays disabled on the canvas.
    if (disabled) el.setAttribute('disabled', '');
    // A checkbox, a radio or a range has defaults of its own, such as the margin around a checkbox.
    if (type) el.setAttribute('type', type);
    holder.appendChild(el);
    const cs = frame.contentWindow.getComputedStyle(el);
    const out = {};
    for (let i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]);
    out['white-space'] = cs.getPropertyValue('white-space');
    if (holder !== bdoc.body) holder.remove(); else el.remove();
    baselines.set(key, out);
    return out;
  };

  // Tokens.
  const rootStyle = getComputedStyle(document.documentElement);
  const pageTokens = [];
  const seen = new Set();
  const visitRules = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules && !rule.selectorText) { try { visitRules(rule.cssRules); } catch {} continue; }
      if (!rule.style || !/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText || '')) continue;
      for (let i = 0; i < rule.style.length; i++) {
        const name = rule.style[i];
        if (!name.startsWith('--') || seen.has(name)) continue;
        seen.add(name);
        pageTokens.push({ name: name.slice(2), value: rootStyle.getPropertyValue(name).trim() });
      }
    }
  };
  for (const sheet of document.styleSheets) { try { visitRules(sheet.cssRules); } catch {} }
  // A capture for a theme mode wants the page's values of these variables, not the ones in the file.
  const source = args.known.length ? args.known.map((t) => (args.liveTokens && rootStyle.getPropertyValue('--' + t.name).trim() ? { name: t.name, value: rootStyle.getPropertyValue('--' + t.name).trim() } : t)) : pageTokens;
  const probe = document.createElement('div');
  document.documentElement.appendChild(probe);
  const colorToToken = new Map();
  const fontToToken = new Map();
  const normFont = (v) => v.replace(/["']/g, '').replace(/\s*,\s*/g, ',').toLowerCase();
  for (const t of source) {
    if (/^[\w-]+$/.test(t.name)) {
      probe.style.color = '';
      probe.style.color = t.value;
      if (probe.style.color) {
        const rgb = getComputedStyle(probe).color;
        if (!colorToToken.has(rgb)) colorToToken.set(rgb, t.name);
      } else if (/,|["']/.test(t.value) && !/\(/.test(t.value)) fontToToken.set(normFont(t.value), t.name);
    }
  }
  probe.remove();

  // The variables the page's own rules set each element's properties with, such as padding: 0 var(--space-sm). A layer
  // keeps such a reference where the variable gives exactly the value the element has, so the design stays bound to its
  // tokens as the source is. Anything else, and every rule the page cannot read (another origin), keeps the computed value.
  const bindings = new Map();
  const pseudoBindings = { before: new Map(), after: new Map() };
  const VAR_ONLY = /^var\(\s*--([\w-]+)\s*(?:,[^()]*)?\)$/;
  // Arithmetic on variables and pixels, such as calc(var(--space-sm) + 2 * var(--space-lg)) for an indent. The canvas
  // works it out the same way as long as every variable in it is a token of the file, so such a value is kept too.
  // max() and min() too, as a page writes max(var(--space-sm), env(safe-area-inset-left)) for a notch: a safe area is 0
  // on the canvas, so such a value is kept where it gives the same with the safe areas at 0.
  const CALC_OF_VARS = /^(?:calc|max|min)\((?:\s|var\(\s*--[\w-]+\s*\)|env\(\s*safe-area-inset-(?:top|right|bottom|left)\s*\)|max\(|min\(|calc\(|,|-?\d*\.?\d+(?:px)?|[-+*\/()])+\)$/;
  const SIDES = {
    margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
    inset: ['top', 'right', 'bottom', 'left'],
    'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
    gap: ['row-gap', 'column-gap'],
    'padding-inline': ['padding-inline-start', 'padding-inline-end'], 'padding-block': ['padding-block-start', 'padding-block-end'],
    'margin-inline': ['margin-inline-start', 'margin-inline-end'], 'margin-block': ['margin-block-start', 'margin-block-end'],
    'inset-inline': ['inset-inline-start', 'inset-inline-end'], 'inset-block': ['inset-block-start', 'inset-block-end'],
  };
  // A computed style lists the physical sides and both kinds of corners; a rule may say either. Read left to right and
  // top to bottom, which the value check below confirms, so a page that runs right to left is not bound wrongly.
  const TWINS = {};
  const twin = (a, b) => { TWINS[a] = b; TWINS[b] = a; };
  for (const [logical, physical] of [['inline-start', 'left'], ['inline-end', 'right'], ['block-start', 'top'], ['block-end', 'bottom']]) {
    twin('padding-' + logical, 'padding-' + physical);
    twin('margin-' + logical, 'margin-' + physical);
    twin('inset-' + logical, physical);
  }
  twin('border-top-left-radius', 'border-start-start-radius'); twin('border-top-right-radius', 'border-start-end-radius');
  twin('border-bottom-right-radius', 'border-end-end-radius'); twin('border-bottom-left-radius', 'border-end-start-radius');
  const splitTop = (v, sep) => {
    const out = [];
    let depth = 0, cur = '';
    for (const c of v.trim()) {
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (depth === 0 && (sep === ',' ? c === ',' : /\s/.test(c))) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const declared = (style) => {
    const out = [];
    for (let i = 0; i < style.length; i++) {
      const value = style.getPropertyValue(style[i]).trim();
      const m = VAR_ONLY.exec(value);
      if (m) out.push([style[i], m[1]]);
      else if (CALC_OF_VARS.test(value) && value.includes('var(')) out.push([style[i], { calc: value }]);
    }
    // A shorthand with a variable in it leaves its longhands empty until the value is computed.
    for (const short of Object.keys(SIDES)) {
      const v = style.getPropertyValue(short);
      if (!v || !v.includes('var(') || v.includes('/')) continue;
      const parts = splitTop(v, ' ');
      const sides = SIDES[short];
      if (!parts.length || parts.length > sides.length) continue;
      const full = sides.length === 2 ? [parts[0], parts[1] || parts[0]] : [parts[0], parts[1] || parts[0], parts[2] || parts[0], parts[3] || parts[1] || parts[0]];
      full.forEach((x, i) => {
        const m = VAR_ONLY.exec(x);
        if (m) out.push([sides[i], m[1]]);
        else if (CALC_OF_VARS.test(x) && x.includes('var(')) out.push([sides[i], { calc: x }]);
      });
    }
    const bg = VAR_ONLY.exec((style.getPropertyValue('background') || '').trim());
    if (bg) out.push(['background-color', bg[1]]);
    // font: var(--text-sm)/16px var(--ui-font). Which part is the size is left to the value check.
    const font = style.getPropertyValue('font');
    if (font && font.includes('var(')) {
      for (const part of splitTop(font, ' ').flatMap((x) => x.split('/'))) {
        const m = VAR_ONLY.exec(part);
        if (m) for (const p of ['font-size', 'line-height', 'font-family', 'font-weight']) out.push([p, m[1]]);
      }
    }
    for (const [p, name] of out.slice()) if (TWINS[p]) out.push([TWINS[p], name]);
    return out;
  };
  const bindRules = (list, parent) => {
    for (const rule of list) {
      if (rule.selectorText !== undefined && rule.style) {
        const selector = parent ? splitTop(rule.selectorText, ',').map((s) => s.includes('&') ? s.replaceAll('&', ':is(' + parent + ')') : parent + ' ' + s).join(', ') : rule.selectorText;
        if (rule.style.length && rule.style.cssText.includes('var(') && !selector.includes('::')) {
          const decl = declared(rule.style);
          let found = [];
          if (decl.length) { try { found = document.querySelectorAll(selector); } catch {} }
          for (const el of found) {
            let own = bindings.get(el);
            if (!own) bindings.set(el, own = new Map());
            for (const [p, name] of decl) { if (!own.has(p)) own.set(p, []); own.get(p).push(name); }
          }
        } else if (rule.style.length && rule.style.cssText.includes('var(')) {
          // The words or the mark a ::before or ::after puts in keep their tokens too, such as a count in a pin.
          const decl = declared(rule.style);
          for (const part of decl.length ? splitTop(selector, ',') : []) {
            const m = /^(.*?)::?(before|after)$/.exec(part.trim());
            if (!m) continue;
            let found = [];
            try { found = document.querySelectorAll(m[1] || '*'); } catch {}
            const map = pseudoBindings[m[2]];
            for (const el of found) {
              let own = map.get(el);
              if (!own) map.set(el, own = new Map());
              for (const [p, name] of decl) { if (!own.has(p)) own.set(p, []); own.get(p).push(name); }
            }
          }
        }
        if (rule.cssRules && rule.cssRules.length) bindRules(rule.cssRules, selector);
        continue;
      }
      if (rule.cssRules) { try { bindRules(rule.cssRules, parent); } catch {} }
    }
  };
  for (const sheet of document.styleSheets) { try { bindRules(sheet.cssRules, ''); } catch {} }
  // Only variables that end up as the file's tokens with the same value, plain colours and pixel lengths: a rem or a
  // calc() could come out differently on the canvas, and a value the file cannot keep would leave the reference empty.
  const STORABLE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()|^-?[\d.]+px$/i;
  const sourceValues = new Map(source.map((t) => [t.name, String(t.value).trim()]));
  const usable = new Map();
  const usableToken = (name) => {
    if (!usable.has(name)) {
      const root = rootStyle.getPropertyValue('--' + name).trim();
      usable.set(name, sourceValues.get(name) === root && STORABLE.test(root) ? root : null);
    }
    return usable.get(name);
  };
  const colorProbe = document.createElement('div');
  const colorOf = new Map();
  const asColor = (v) => {
    if (!colorOf.has(v)) {
      colorProbe.style.color = '';
      colorProbe.style.color = v;
      document.documentElement.appendChild(colorProbe);
      colorOf.set(v, colorProbe.style.color ? getComputedStyle(colorProbe).color : null);
      colorProbe.remove();
    }
    return colorOf.get(v);
  };
  /**
   * The pixels a calc() of variables and pixels comes to, with each variable as the file's token, or null when one is
   * not a token in px or the element sees another value of it. Only + - * / and brackets: anything else is not kept.
   */
  function calcPx(expr, cs) {
    let ok = true;
    const plain = expr.replace(/env\(\s*safe-area-inset-\w+\s*\)/g, '0').replace(/calc\(/g, '(').replace(/var\(\s*--([\w-]+)\s*\)/g, (_, name) => {
      const root = usableToken(name);
      if (root === null || !/px$/.test(root) || cs.getPropertyValue('--' + name).trim() !== root) { ok = false; return '0'; }
      return '(' + Number.parseFloat(root) + ')';
    }).replace(/(\d*\.?\d+)px/g, '$1');
    if (!ok || !/^(?:[\d.\s+\-*\/(),]|max|min)+$/.test(plain)) return null;
    // A small reader for + - * /, brackets, max and min: the page may forbid eval, and an extension always does.
    const tokens = plain.match(/max|min|\d*\.?\d+|[-+*\/(),]/g) || [];
    let at = 0;
    const factor = () => {
      const t = tokens[at++];
      if (t === '(') { const v = sum(); return tokens[at++] === ')' ? v : NaN; }
      if (t === 'max' || t === 'min') {
        if (tokens[at++] !== '(') return NaN;
        const args = [sum()];
        while (tokens[at] === ',') { at++; args.push(sum()); }
        return tokens[at++] === ')' ? (t === 'max' ? Math.max(...args) : Math.min(...args)) : NaN;
      }
      if (t === '-') return -factor();
      return t !== undefined && /\d/.test(t) ? Number(t) : NaN;
    };
    const product = () => {
      let v = factor();
      while (tokens[at] === '*' || tokens[at] === '/') v = tokens[at++] === '*' ? v * factor() : v / factor();
      return v;
    };
    const sum = () => {
      let v = product();
      while (tokens[at] === '+' || tokens[at] === '-') v = tokens[at++] === '+' ? v + product() : v - product();
      return v;
    };
    const n = sum();
    return at === tokens.length && Number.isFinite(n) ? n : null;
  }

  /** var(--name) for this property of this element, when one of its rules says so and it gives exactly this value. */
  function boundValue(el, cs, p, v, pseudo) {
    const own = pseudo ? pseudoBindings[pseudo].get(el) : bindings.get(el);
    let names = own && own.get(p);
    if (!pseudo && el.style && el.style.length && el.style.cssText.includes('var(')) {
      const inline = declared(el.style).filter((d) => d[0] === p).map((d) => d[1]);
      if (inline.length) names = (names || []).concat(inline);
    }
    if (!names) return null;
    for (let i = names.length - 1; i >= 0; i--) {
      if (typeof names[i] === 'object') {
        const sum = calcPx(names[i].calc, cs);
        if (sum !== null && /px$/.test(v) && Math.abs(sum - Number.parseFloat(v)) < 0.01) return names[i].calc;
        continue;
      }
      const root = usableToken(names[i]);
      if (root === null) continue;
      // The element may see another value of the variable than the page's root does, and the file only has that one.
      const here = cs.getPropertyValue('--' + names[i]).trim();
      if (here !== root) continue;
      if (here === v || (/color$/.test(p) && asColor(here) === v)) return 'var(--' + names[i] + ')';
    }
    return null;
  }

  // Ids that same-page links on this page point at. They stay, so that those links keep working.
  const here = location.href.split('#')[0];
  const anchorTargets = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.href.split('#')[0] === here && a.hash.length > 1) { try { anchorTargets.add(decodeURIComponent(a.hash.slice(1))); } catch {} }
  }
  let nextKey = 0;

  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const absCssUrls = (v) => v.replace(/url\((["']?)([^"')]+)\1\)/g, (m, q, u) => u.startsWith('#') || u.startsWith('data:') ? m : 'url("' + absUrl(u) + '")');

  // Computed line heights are rounded to a few digits. As a length that often lands on the next
  // 1/64 of a pixel, and on a long page those add up to a visible shift. A plain ratio usually gives
  // the browser the number the page gave it, and the element itself can say whether it does.
  const lineHeights = new Map();
  function lineHeightValue(v, cs, el) {
    if (!v.endsWith('px')) return v;
    const size = parseFloat(cs.getPropertyValue('font-size'));
    const px = parseFloat(v);
    if (!size || !px) return v;
    const key = size + '|' + px;
    const known = lineHeights.get(key);
    if (known) return known;
    const ratio = String(Math.round((px / size) * 10000) / 10000);
    if (Math.abs(parseFloat(ratio) * size - px) > 0.02) return v;
    if (!el || !(el instanceof HTMLElement) || cs.getPropertyValue('display') === 'inline' || !el.textContent.trim()) return ratio;
    const before = el.getBoundingClientRect().height;
    const inline = el.style.getPropertyValue('line-height');
    const priority = el.style.getPropertyPriority('line-height');
    el.style.setProperty('line-height', ratio, 'important');
    const kept = Math.abs(el.getBoundingClientRect().height - before) < 0.005;
    if (inline) el.style.setProperty('line-height', inline, priority); else el.style.removeProperty('line-height');
    const chosen = kept ? ratio : v;
    lineHeights.set(key, chosen);
    return chosen;
  }

  function styleOf(cs, parentCs, tag, opts) {
    const el = opts && opts.el;
    const inputType = el && tag === 'input' ? (el.getAttribute('type') || '').toLowerCase().replace(/[^a-z-]/g, '') : '';
    const optionSize = tag === 'option' || tag === 'optgroup' ? cs.getPropertyValue('font-size') : '';
    const base = baseline(tag, Boolean(el && DISABLEABLE.test(tag) && el.hasAttribute('disabled')), inputType, optionSize);
    const neutral = baseline('div');
    const out = {};
    const isText = opts && opts.isText;
    const hasBgImage = cs.getPropertyValue('background-image') !== 'none';
    const hasTransform = cs.getPropertyValue('transform') !== 'none' || cs.getPropertyValue('rotate') !== 'none' || cs.getPropertyValue('scale') !== 'none' || cs.getPropertyValue('translate') !== 'none';
    const positioned = cs.getPropertyValue('position') !== 'static';
    // An absolute layer is placed by its left and top alone (see placeFixed), where an auto margin would count as 0.
    const inFlow = !/^(absolute|fixed)$/.test(cs.getPropertyValue('position'));
    let specified = null;
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (p.startsWith('--') || SKIP.test(p)) continue;
      if (p === 'width' || p === 'height') continue;
      let v = cs.getPropertyValue(p);
      // A computed margin is the space it took, such as 892.08px for margin-left: auto. The auto is what the page
      // said, and it takes the same space on the canvas.
      if (el && !opts.pseudo && inFlow && v !== '0px' && /^margin-(top|right|bottom|left)$/.test(p) && el.computedStyleMap) {
        try { specified = specified || el.computedStyleMap(); if (String(specified.get(p)) === 'auto') v = 'auto'; } catch {}
      }
      if ((p === 'min-width' || p === 'min-height') && v === 'auto') continue;
      // These follow color unless a page sets them apart. Kept as a copy of it, a later change of color would not show.
      if ((p === '-webkit-text-fill-color' || p === '-webkit-text-stroke-color') && v === cs.getPropertyValue('color')) continue;
      // A flex or grid item reads min-width: auto as the size of its content, where the baseline, not being one, reads
      // 0px. The 0px that lets a field shrink in a row has to be said, or the field takes its default width again.
      const itemMin = (p === 'min-width' || p === 'min-height') && opts && opts.parentDisplay && /flex|grid/.test(opts.parentDisplay);
      if (v === base[p] && !itemMin) { if (!(parentCs && INHERITED.has(p) && parentCs.getPropertyValue(p) !== v)) continue; }
      // A ratio is inherited as a ratio, so a child in another size cannot rely on its parent's length.
      const sameRatio = p !== 'line-height' || !parentCs || parentCs.getPropertyValue('font-size') === cs.getPropertyValue('font-size');
      if (INHERITED.has(p) && parentCs && parentCs.getPropertyValue(p) === v && base[p] === neutral[p] && sameRatio) continue;
      if (p === 'line-height') v = lineHeightValue(v, cs, opts && !opts.pseudo ? opts.el : null);
      if (/^(top|right|bottom|left)$/.test(p) && !positioned) continue;
      if (p === 'transform-origin' && !hasTransform) continue;
      if (/^background-(position|size|repeat|attachment|origin|clip)/.test(p) && !hasBgImage && !/^background-clip/.test(p)) continue;
      const side = /^border-(top|right|bottom|left)-(color|width|style)$/.exec(p);
      if (side) {
        if (cs.getPropertyValue('border-' + side[1] + '-style') === 'none' || cs.getPropertyValue('border-' + side[1] + '-width') === '0px') continue;
      }
      if (/^outline-/.test(p) && cs.getPropertyValue('outline-style') === 'none') continue;
      if (/^text-decoration-/.test(p) && cs.getPropertyValue('text-decoration-line') === 'none') continue;
      if (/^column-rule-/.test(p) && cs.getPropertyValue('column-rule-style') === 'none') continue;
      if (/^(flex-basis|flex-grow|flex-shrink|order|align-self|justify-self)$/.test(p) && opts && opts.parentDisplay && !/flex|grid/.test(opts.parentDisplay)) continue;
      if (v.includes('url(')) v = absCssUrls(v);
      if (unsafe.test(v)) continue;
      const bound = el && v !== 'auto' ? boundValue(el, cs, p, v, opts.pseudo) : null;
      if (bound) { out[camel(p)] = bound; continue; }
      // A heading or a control has a font of its own in the browser, so a page that wants it to follow the text around
      // says inherit (font: inherit). The parent's value where the element would have another is that, and stays it,
      // so that it follows the parent's token on the canvas too.
      if (el && /^(font-(family|size|weight|style)|line-height|letter-spacing)$/.test(p) && parentCs && parentCs.getPropertyValue(p) === v && base[p] !== v) { out[camel(p)] = 'inherit'; continue; }
      if (COLOR_PROPS.has(p) && colorToToken.has(v)) v = 'var(--' + colorToToken.get(v) + ')';
      if (p === 'font-family' && fontToToken.has(normFont(v))) v = 'var(--' + fontToToken.get(normFont(v)) + ')';
      out[camel(p)] = v;
    }
    // Sides that agree read and edit far better as one property.
    for (const prop of ['margin', 'padding']) {
      const sides = ['Top','Right','Bottom','Left'].map((s) => out[prop + s]);
      if (sides.every((s) => s !== undefined)) {
        const [t, r, b, l] = sides;
        out[prop] = t === b && r === l ? (t === r ? t : t + ' ' + r) : t + ' ' + r + ' ' + b + ' ' + l;
        for (const s of ['Top','Right','Bottom','Left']) delete out[prop + s];
      }
    }
    const b = ['Top','Right','Bottom','Left'];
    if (b.every((s) => out['border' + s + 'Style'] !== undefined && out['border' + s + 'Width'] === out.borderTopWidth && out['border' + s + 'Style'] === out.borderTopStyle && out['border' + s + 'Color'] === out.borderTopColor)) {
      out.border = out.borderTopWidth + ' ' + out.borderTopStyle + ' ' + out.borderTopColor;
      for (const s of b) { delete out['border' + s + 'Width']; delete out['border' + s + 'Style']; delete out['border' + s + 'Color']; }
    }
    const radii = ['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'];
    if (radii.every((r) => out[r] !== undefined && out[r] === out.borderTopLeftRadius)) {
      out.borderRadius = out.borderTopLeftRadius;
      for (const r of radii) delete out[r];
    }
    if (isText) out.whiteSpace = cs.getPropertyValue('white-space');
    return out;
  }

  function placeFixed(style, el, cs) {
    const pos = cs.getPropertyValue('position');
    // Computed sides are all resolved, so left and top say everything. Keeping bottom too would
    // stretch a layer whose size came from its content.
    if (pos !== 'static') { delete style.right; delete style.bottom; }
    if (pos === 'absolute') {
      style.width = cs.getPropertyValue('width');
      style.height = cs.getPropertyValue('height');
    }
    if (pos === 'sticky') {
      style.position = 'relative';
      delete style.top; delete style.bottom; delete style.left; delete style.right;
    } else if (pos === 'fixed') {
      const r = el.getBoundingClientRect();
      style.position = 'absolute';
      style.left = (r.left + scrollX) + 'px';
      style.top = (r.top + scrollY) + 'px';
      style.width = cs.getPropertyValue('width');
      style.height = cs.getPropertyValue('height');
    }
  }

  /**
   * Keeps a size only if taking it away would change the element. A size that is left out stays out on the page until
   * the capture ends: two buttons of 28px in a row each look free to go while the other one holds the row up, and only
   * one of them may go, or the row falls to the height of its text on the canvas.
   */
  function sizes(style, el, cs) {
    const display = cs.getPropertyValue('display');
    if (display === 'inline') return;
    const before = el.getBoundingClientRect();
    for (const dim of ['width', 'height']) {
      const inlineValue = el.style.getPropertyValue(dim);
      const inlinePriority = el.style.getPropertyPriority(dim);
      const value = cs.getPropertyValue(dim);
      el.style.setProperty(dim, 'auto', 'important');
      const after = el.getBoundingClientRect();
      const same = Math.abs(after.width - before.width) < 0.6 && Math.abs(after.height - before.height) < 0.6;
      const put = () => { if (inlineValue) el.style.setProperty(dim, inlineValue, inlinePriority); else el.style.removeProperty(dim); };
      if (same) { restore.push(put); continue; }
      put();
      style[dim] = boundValue(el, cs, dim, value) || value;
    }
  }

  function attrsOf(el) {
    const out = {};
    for (const a of ATTRS) if (el.hasAttribute(a)) out[a] = el.getAttribute(a);
    if (DISABLEABLE.test(el.tagName.toLowerCase()) && el.hasAttribute('disabled')) out.disabled = '';
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      const h = el.href;
      if (h.split('#')[0] === here && (el.hash || el.getAttribute('href').startsWith('#'))) out.href = el.hash || '#';
      else if (/^(https?:|mailto:|tel:)/i.test(h)) out.href = h;
    }
    if (el.id && anchorTargets.has(el.id)) out.id = el.id;
    return Object.keys(out).length ? out : undefined;
  }

  function svgSpec(el, cs, parentCs, parentDisplay) {
    // Inline <use>, since a design has no shared defs and the sanitizer keeps only local references.
    for (const use of [...el.querySelectorAll('use')]) {
      const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      const target = ref.startsWith('#') ? document.getElementById(ref.slice(1)) : null;
      if (!target) { use.remove(); continue; }
      const NS = 'http://www.w3.org/2000/svg';
      const x = use.getAttribute('x') || 0, y = use.getAttribute('y') || 0;
      let copy;
      if (target.tagName.toLowerCase() === 'symbol') {
        copy = document.createElementNS(NS, 'svg');
        for (const a of ['viewBox', 'preserveAspectRatio']) if (target.hasAttribute(a)) copy.setAttribute(a, target.getAttribute(a));
        copy.setAttribute('x', x); copy.setAttribute('y', y);
        copy.setAttribute('width', use.getAttribute('width') || '100%');
        copy.setAttribute('height', use.getAttribute('height') || '100%');
        for (const c of target.childNodes) copy.appendChild(c.cloneNode(true));
      } else {
        copy = document.createElementNS(NS, 'g');
        copy.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
        const inner = target.cloneNode(true);
        inner.removeAttribute('id');
        copy.appendChild(inner);
      }
      for (const a of use.attributes) if (a.name === 'class' || a.name === 'style' || a.name === 'fill' || a.name === 'stroke' || a.name === 'transform') {
        if (a.name === 'transform') copy.setAttribute('transform', a.value + ' ' + (copy.getAttribute('transform') || ''));
        else copy.setAttribute(a.name, a.value);
      }
      use.replaceWith(copy);
      restore.push(() => copy.replaceWith(use));
    }
    const clone = el.cloneNode(true);
    const liveAll = [el, ...el.querySelectorAll('*')];
    const copyAll = [clone, ...clone.querySelectorAll('*')];
    const parents = new Map();
    liveAll.forEach((live, i) => {
      const c = copyAll[i];
      if (!c || live.tagName.toLowerCase() === 'title') return;
      const lcs = getComputedStyle(live);
      parents.set(live, lcs);
      const pcs = i === 0 ? null : parents.get(live.parentElement);
      const parts = [];
      for (const p of SVG_PROPS) {
        // The layer around the root already carries these, and doing them twice would double them.
        if (i === 0 && /^(opacity|transform|transform-origin|transform-box|mix-blend-mode|display|visibility)$/.test(p)) continue;
        let v = lcs.getPropertyValue(p);
        if (!v || (i !== 0 && pcs && pcs.getPropertyValue(p) === v && p !== 'transform' && p !== 'opacity' && p !== 'display')) continue;
        if ((p === 'transform' || p === 'mix-blend-mode') && (v === 'none' || v === 'normal')) continue;
        if (p === 'transform-origin' && lcs.getPropertyValue('transform') === 'none') continue;
        if (p === 'transform-box' && lcs.getPropertyValue('transform') === 'none') continue;
        if (p === 'opacity' && v === '1') continue;
        if (p === 'display' && v !== 'none') continue;
        if (p === 'paint-order' && v === 'normal') continue;
        v = v.replace(/url\("?[^"#)]*(#[^")]+)"?\)/g, 'url($1)');
        if (!unsafe.test(v)) parts.push(p + ':' + v);
      }
      c.removeAttribute('class');
      const had = c.getAttribute('style');
      c.setAttribute('style', parts.join(';'));
      if (!parts.length && !had) c.removeAttribute('style');
    });
    if (!clone.getAttribute('viewBox') && clone.getBBox) {
      const r = el.getBoundingClientRect();
      clone.setAttribute('viewBox', '0 0 ' + r.width + ' ' + r.height);
    }
    // The element goes along so that a margin or size the page set with a token keeps it.
    const style = styleOf(cs, parentCs, 'div', { parentDisplay, el });
    style.width = boundValue(el, cs, 'width', cs.getPropertyValue('width')) || cs.getPropertyValue('width');
    style.height = boundValue(el, cs, 'height', cs.getPropertyValue('height')) || cs.getPropertyValue('height');
    placeFixed(style, el, cs);
    clone.setAttribute('width', '100%');
    clone.setAttribute('height', '100%');
    clone.style.display = 'block';
    layers++;
    return { type: 'svg', tag: 'svg', name: el.getAttribute('aria-label') || 'Vector', style, svg: new XMLSerializer().serializeToString(clone) };
  }

  function pseudoSpec(el, which, parentCs, parentDisplay) {
    const cs = getComputedStyle(el, which);
    const content = cs.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal' || cs.getPropertyValue('display') === 'none') return null;
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
    const text = m ? m[1].replace(/\\(.)/g, '$1') : '';
    const style = styleOf(cs, parentCs, 'span', { isText: Boolean(text), parentDisplay, el, pseudo: which.replace(/^::?/, '') });
    if (cs.getPropertyValue('display') !== 'inline') {
      style.width = cs.getPropertyValue('width');
      style.height = cs.getPropertyValue('height');
    }
    delete style.right; delete style.bottom;
    if (cs.getPropertyValue('display') === 'inline' && !text) style.display = 'inline-block';
    layers++;
    return text
      ? { type: 'text', tag: 'span', name: text.slice(0, 40), text, style }
      : { type: 'frame', tag: 'span', name: which === '::before' ? 'Before' : 'After', style };
  }

  const collapse = (s) => s.replace(/[ \t\r\n\f]+/g, ' ');
  const preserves = (cs) => /^pre|break-spaces/.test(cs.getPropertyValue('white-space'));

  function textRun(raw, parentCs) {
    const keep = preserves(parentCs);
    const text = keep ? raw : collapse(raw);
    layers++;
    return { type: 'text', tag: 'span', name: text.trim().slice(0, 40) || 'Space', text, style: { whiteSpace: parentCs.getPropertyValue('white-space') } };
  }

  function walk(el, parentCs, parentDisplay) {
    const node = walkElement(el, parentCs, parentDisplay);
    if (node) {
      el.__bogenKey = ++nextKey;
      node.key = el.__bogenKey;
    }
    return node;
  }

  function walkElement(el, parentCs, parentDisplay) {
    if (layers > LIMIT) return null;
    const tag = el.tagName.toLowerCase();
    if (/^(script|style|noscript|template|head|meta|link|title|base|iframe-resizer)$/.test(tag)) return null;
    const cs = getComputedStyle(el);
    if (cs.getPropertyValue('display') === 'none') return null;

    if (el instanceof SVGElement) {
      if (tag !== 'svg') return null;
      const r = el.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) return null;
      return svgSpec(el, cs, parentCs, parentDisplay);
    }
    if (tag === 'img' || tag === 'video' || tag === 'canvas' || tag === 'iframe') {
      const style = styleOf(cs, parentCs, tag === 'canvas' || tag === 'iframe' ? 'div' : tag, { parentDisplay, el });
      style.width = cs.getPropertyValue('width');
      style.height = cs.getPropertyValue('height');
      placeFixed(style, el, cs);
      layers++;
      if (tag === 'img') return { type: 'image', tag: 'img', name: el.alt || 'Image', style, src: el.currentSrc || el.src, attrs: attrsOf(el) };
      if (tag === 'video') return { type: 'video', tag: 'video', name: 'Video', style, src: el.currentSrc || el.src, attrs: attrsOf(el) };
      if (tag === 'iframe') return { type: 'embed', tag: 'iframe', name: 'Embed', style, src: el.src };
      try { return { type: 'image', tag: 'img', name: 'Canvas', style, src: el.toDataURL('image/png') }; } catch { return { type: 'frame', tag: 'div', name: 'Canvas', style }; }
    }

    const outTag = tag === 'details' || tag === 'summary' ? 'div' : tag === 'body' ? 'div' : tag;
    const closedDetails = tag === 'details' && !el.open;
    const display = cs.getPropertyValue('display');
    const before = pseudoSpec(el, '::before', cs, display);
    const after = pseudoSpec(el, '::after', cs, display);

    const nodes = [...el.childNodes].filter((n) => {
      if (n.nodeType === 3) return true;
      if (n.nodeType !== 1) return false;
      if (closedDetails && n.tagName.toLowerCase() !== 'summary') return false;
      return true;
    });
    const meaningful = nodes.filter((n) => n.nodeType === 1 || n.data.trim());
    const onlyText = !before && !after && meaningful.length > 0 && meaningful.every((n) => n.nodeType === 3);
    const style = styleOf(cs, parentCs, outTag, { isText: onlyText, parentDisplay, el });
    sizes(style, el, cs);
    placeFixed(style, el, cs);
    if (tag === 'summary' && display === 'list-item') {
      // A div cannot draw the disclosure triangle unless it is told to be a list item.
      style.display = 'list-item';
      style.listStyleType = el.parentElement && el.parentElement.open ? 'disclosure-open' : 'disclosure-closed';
      style.listStylePosition = 'inside';
    }
    layers++;

    if (onlyText) {
      const raw = nodes.map((n) => n.data).join('');
      const text = preserves(cs) ? raw : collapse(raw).trim();
      return { type: 'text', tag: outTag, name: el.getAttribute('aria-label') || text.slice(0, 40), text, style, attrs: attrsOf(el) };
    }

    const children = [];
    if (before) children.push(before);
    const flowText = !/flex|grid/.test(display);
    nodes.forEach((n, i) => {
      if (n.nodeType === 3) {
        if (n.data.trim() || (preserves(cs) && n.data)) { children.push(textRun(flowText ? n.data : n.data.trim(), cs)); return; }
        if (!flowText) return;
        const prev = nodes[i - 1], next = nodes[i + 1];
        const inlineEl = (x) => x && (x.nodeType === 3 || /^inline/.test(getComputedStyle(x).getPropertyValue('display')));
        if (inlineEl(prev) && inlineEl(next)) children.push(textRun(' ', cs));
        return;
      }
      if (n.tagName.toLowerCase() === 'br') { children.push({ type: 'frame', tag: 'br', name: 'Line break', style: {} }); return; }
      const child = walk(n, cs, display);
      if (child) children.push(child);
    });
    if (after) children.push(after);
    const NAMES = { nav: 'Navigation', header: 'Header', footer: 'Footer', section: 'Section', main: 'Main', aside: 'Sidebar', article: 'Article', ul: 'List', ol: 'List', li: 'Item', button: 'Button', a: 'Link', form: 'Form', table: 'Table' };
    const name = el.getAttribute('aria-label') || (el.id ? el.id : null) || NAMES[tag] || (el.classList[0] ?? 'Frame');
    return { type: 'frame', tag: outTag, name, style, attrs: attrsOf(el), children };
  }

  let body = document.body;
  if (args.root) { try { body = document.querySelector(args.root) || document.body; } catch {} }
  const bodyCs = getComputedStyle(body);
  let root;
  try { root = walk(body, null, null); } finally { for (const undo of restore.reverse()) { try { undo(); } catch {} } }
  if (root && bodyCs.getPropertyValue('background-color') === 'rgba(0, 0, 0, 0)') {
    // An element on its own keeps the ground it was seen on: the nearest ancestor with a background colour.
    for (let up = body.parentElement; up; up = up.parentElement) {
      const bg = getComputedStyle(up).getPropertyValue('background-color');
      if (bg !== 'rgba(0, 0, 0, 0)') { root.style.backgroundColor = bg; break; }
    }
  }
  if (root && body !== document.body) for (const k of Object.keys(root.style)) if (/^(margin|top|left|right|bottom|position|inset)/.test(k)) delete root.style[k];
  frame.remove();
  return { root, tokens: pageTokens, title: document.title, layers, links: [...document.querySelectorAll('a[href]')].map((a) => a.href) };
}`;

const SETTLE = String.raw`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const h = () => document.documentElement.scrollHeight;
  for (let y = 0; y < h() && y < 60000; y += innerHeight * 0.8) { scrollTo(0, y); await wait(40); }
  scrollTo(0, 0);
  await wait(80);
  for (const img of document.images) img.loading = 'eager';
  await Promise.race([Promise.all([...document.images].map((i) => i.decode().catch(() => {}))), wait(6000)]);
  await Promise.race([document.fonts.ready, wait(4000)]);
  for (const a of document.getAnimations()) {
    try { a.finish(); } catch { try { a.cancel(); } catch {} }
  }
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;caret-color:transparent!important}';
  document.head.appendChild(s);
  await wait(60);
})()`;

/**
 * What a page's custom property is, by its value and, for a length, by its name: --radius 4px is a corner, --text-sm
 * 12px a type size, and neither is a step of the spacing scale, though all three are lengths.
 */
export function tokenKind(value: string, name = ''): TokenKind | null {
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i.test(value)) return 'color';
  if (/\(/.test(value)) return null;
  if (/,|["']/.test(value)) return 'font-family';
  if (/^-?[\d.]+(px|rem|em)$/.test(value)) return lengthKind(name) ?? 'spacing';
  return null;
}

export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127(\.\d+){3}|\[::1\])$/i.test(host);
}

/** Walks the captured tree, storing images and background images with the file. */
async function storeMedia(root: NewNode, storage: Storage, pageUrl: string, allowLocal: boolean, stats: CaptureResult['stats']): Promise<void> {
  const cache = new Map<string, Promise<string | null>>();
  const store = (raw: string): Promise<string | null> => {
    let pending = cache.get(raw);
    if (!pending) {
      pending = (async () => {
        try {
          const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(raw);
          if (data) {
            const bytes = data[2] ? Buffer.from(data[3]!, 'base64') : Buffer.from(decodeURIComponent(data[3]!));
            return (await storage.putAsset(bytes, data[1]!)).src;
          }
          const url = new URL(raw, pageUrl);
          const onlyLoopback = allowLocal && isLoopbackHost(url.host.split(':')[0]!);
          const got = await fetchPublic(url.toString(), { timeoutMs: 15_000, maxBytes: 64 * 1024 * 1024, onlyLoopback });
          return (await storage.putAsset(got.bytes, got.contentType.split(';')[0]!.trim())).src;
        } catch {
          stats.failedImages.push(raw.slice(0, 200));
          return null;
        }
      })();
      cache.set(raw, pending);
    }
    return pending;
  };
  const visit = async (node: NewNode): Promise<void> => {
    if (node.src) {
      const src = await store(node.src);
      if (src) {
        node.src = src;
        stats.images++;
      }
    }
    for (const key of ['backgroundImage', 'maskImage', 'WebkitMaskImage', 'listStyleImage', 'borderImageSource'] as const) {
      const value = node.style?.[key];
      if (!value?.includes('url(')) continue;
      let next = value;
      for (const m of value.matchAll(/url\("?([^")]+)"?\)/g)) {
        if (m[1]!.startsWith('#')) continue;
        const src = await store(m[1]!);
        if (src) next = next.replace(m[1]!, src);
      }
      node.style![key] = next;
    }
    if (node.svg) node.svg = sanitizeSvgMarkup(node.svg);
    await Promise.all((node.children ?? []).map(visit));
  };
  await visit(root);
}

/**
 * A layer refers to the page's variables by name. Where the file has no token of that name, such as a capture into a
 * file that already had tokens of its own, the reference takes the page's value instead, so nothing renders empty.
 */
export function settleTokenRefs(root: NewNode, have: ReadonlySet<string>, values: ReadonlyMap<string, string>): void {
  const visit = (node: NewNode): void => {
    for (const [k, v] of Object.entries(node.style ?? {})) {
      if (!v.includes('var(')) continue;
      const next = v.replace(/var\(\s*--([\w-]+)\s*\)/g, (m, name: string) => (have.has(name) || !values.has(name) ? m : values.get(name)!));
      if (next !== v) node.style![k] = next;
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(root);
}

function sanitizeSvgs(node: NewNode): void {
  if (node.svg) node.svg = sanitizeSvgMarkup(node.svg);
  for (const c of node.children ?? []) sanitizeSvgs(c);
}

function countLayers(node: NewNode): number {
  return 1 + (node.children ?? []).reduce((sum, c) => sum + countLayers(c), 0);
}

export interface LivePageOptions {
  url: string;
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
  /** Pages on this computer. Only for requests from the person, never for agents. */
  allowLocal?: boolean;
}

export interface LivePage {
  page: Page;
  url: URL;
  /** The page is on this computer. */
  local: boolean;
  status?: number;
}

/**
 * Opens a live page the way Capture does: only http and https, this computer only when the person asks from it,
 * never a private address, every request of the page checked again, in a browser context of its own. Waits until
 * the page has scrolled through, loaded its images and fonts and finished its animations.
 */
export async function withLivePage<T>(renderer: Renderer, options: LivePageOptions, fn: (live: LivePage) => Promise<T>, beforeLoad?: (page: Page) => void): Promise<T> {
  const url = new URL(options.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https pages can be captured.');
  const local = isLoopbackHost(url.hostname);
  if (local && !options.allowLocal) throw new Error('Pages on this computer can only be captured from the command line or the editor on this computer, not by an agent.');
  if (!local && !(await isPublicUrl(url.toString()))) throw new Error(`${url.hostname} is a private address and is not captured.`);
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  // A browser that reaches no local port it was not started with (secure-chromium) is given this page's port.
  const scoped = local && sharesLocalPorts(findBrowser() ?? '');
  if (scoped) renderer.shareLocalPort(Number(url.port) || (url.protocol === 'https:' ? 443 : 80));
  // The browser's proxy reaches this computer only for this page, and only while it is captured.
  const release = local ? renderer.openLocalPort(Number(url.port) || (url.protocol === 'https:' ? 443 : 80)) : () => {};
  return renderer.withSitePage(async (page: Page) => {
    beforeLoad?.(page);
    await page.setBypassCSP(true);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const target = req.url();
      if (target.startsWith('data:') || target.startsWith('blob:')) return void req.continue().catch(() => {});
      const allowed = local ? Promise.resolve(true) : isPublicUrl(target);
      allowed.then((ok) => (ok ? req.continue() : req.abort())).catch(() => req.abort().catch(() => {}));
    });
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: options.colorScheme ?? 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
    const response = await page.goto(url.toString(), { waitUntil: 'networkidle2', timeout: 45_000 });
    // That wrapper answers a port it does not share with an empty 403: say so, rather than capture a blank page.
    if (scoped && response?.status() === 403 && response.headers()['content-length'] === '0') {
      throw new Error(`The browser (${findBrowser()}) did not reach ${url.host}: it only reaches local ports it was started with, and it was busy with other work when this one was shared. Try again in a moment.`);
    }
    await page.evaluate(SETTLE);
    return fn({ page, url, local, status: response?.status() });
  }).finally(release);
}

export interface Tile { x: number; y: number; bytes: Uint8Array }

/** The tallest picture of a live page: a canvas holds 32767 pixels each way. */
const MAX_SHOT = 30_000;

/**
 * A live page from the top down to `height`, in tiles: past 8192 pixels one screenshot repeats its first rows. Join
 * them with `joinShot` once the page is closed, since the join needs a renderer page of its own.
 */
export async function shootLivePage(page: Page, width: number, height: number): Promise<Tile[]> {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += TILE) {
    tiles.push({ x: 0, y, bytes: new Uint8Array(await page.screenshot({ type: 'png', clip: { x: 0, y, width, height: Math.min(TILE, height - y) }, captureBeyondViewport: true })) });
  }
  return tiles;
}

export async function joinShot(renderer: Renderer, tiles: Tile[], width: number, height: number): Promise<Uint8Array> {
  return tiles.length === 1 ? tiles[0]!.bytes : renderer.joinTiles(tiles, width, height);
}

export async function capturePage(renderer: Renderer, storage: Storage, doc: BogenDoc, options: CaptureOptions): Promise<CaptureResult> {
  const width = options.width ?? 1440;
  // The watcher only sees what arrives after it, so it starts before the page loads.
  let resources: ReturnType<typeof watchResources> | undefined;
  const raw = await withLivePage(renderer, { ...options, width }, async ({ page, url, local, status }) => {
    const fullHeight = await page.evaluate('document.documentElement.scrollHeight') as number;
    const original = await shootLivePage(page, width, Math.min(fullHeight, MAX_SHOT));
    const known = doc.getTokens().map((t) => ({ name: t.name, value: t.value }));
    const captured = await page.evaluate(`(${CAPTURE})(${JSON.stringify({ reset: RESET_CSS, known, liveTokens: Boolean(options.liveTokens) })})`) as SerializedCapture;
    await resources!.settle();
    const scan = await page.evaluate(`(${SHEET_SCAN})(${scanArgs(resources!)})`) as SheetScan;
    return { captured, scan, resources: resources!, shots: original, shotHeight: Math.min(fullHeight, MAX_SHOT), status, finalUrl: page.url(), url, local };
  }, (page) => { resources = watchResources(page); });
  const originalShot = await joinShot(renderer, raw.shots, width, raw.shotHeight);
  return finishCapture(storage, { ...raw, width, original: originalShot, captureFonts: options.captureFonts, media: options.media });
}

/** What the capture script gives back, from headless Chromium or from the browser extension. */
export interface SerializedCapture { root: NewNode | null; tokens: { name: string; value: string }[]; title: string; links: string[] }

/**
 * The second half of a capture, the same whichever browser ran the script: names the layers, stores images and font
 * files with the document, and reads the page's tokens. `local` lets it fetch from this computer, which only a
 * capture the person started on this computer may; anything else is fetched only from public addresses.
 */
export async function finishCapture(storage: Storage, raw: {
  captured: SerializedCapture; scan: SheetScan; resources: Pick<PageResources, 'fonts'>; url: URL; local: boolean; width: number; original: Uint8Array;
  status?: number; finalUrl?: string; captureFonts?: boolean; media?: boolean;
}): Promise<CaptureResult> {
  const { url, local, width } = raw;
  if (!raw.captured.root) throw new Error('The page rendered nothing that could be captured.');
  const root = nameSpecTree(raw.captured.root, true) as NewNode & { key?: number };
  const stats: CaptureResult['stats'] = { layers: 0, images: 0, failedImages: [] };
  if (raw.media === false) sanitizeSvgs(root);
  else await storeMedia(root, storage, url.toString(), local, stats);
  stats.layers = countLayers(root);
  root.artboard = true;
  root.style = { ...root.style, width: `${width}px`, position: 'absolute', overflow: 'hidden' };
  delete root.style.height;
  const tokens = raw.captured.tokens.flatMap((t) => {
    const kind = tokenKind(t.value, t.name);
    return kind ? [{ name: t.name, kind, value: t.value }] : [];
  });
  const stored = raw.captureFonts === false
    ? { faces: [], report: { stored: 0, families: [], google: [], failed: [] } }
    : await storeFonts(raw.scan, { sheets: [], settle: async () => {}, ...raw.resources }, storage, fontFetcher(local, isLoopbackHost));
  return { root, tokens, title: raw.captured.title, original: raw.original, stats, fontFaces: stored.faces, fonts: stored.report, rules: raw.scan.rules, url: url.toString(), links: raw.captured.links, status: raw.status, finalUrl: raw.finalUrl };
}
