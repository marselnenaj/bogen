/**
 * What a compliance check measures in the rendered artboard, in one page load: axe-core's WCAG rules, the contrast of
 * field boundaries and icons (1.4.11), and whether text survives the text spacing of 1.4.12. Runs in the page, so it
 * can only use its argument; text spacing goes last because it changes the page.
 */

export interface AxeNode { layer: string; summary: string; data?: Record<string, unknown> }
export interface AxeRuleResult { id: string; tags: string[]; impact: string | null; help: string; helpUrl: string; outcome: 'violation' | 'incomplete' | 'pass' | 'inapplicable'; nodes: AxeNode[]; count: number }
export interface NonTextFinding { layer: string; what: 'field' | 'icon'; ratio: number; colors: string }
export interface SpacingFinding { layer: string; text: string; clippedBy: string }
export interface ProbeResult { axe: AxeRuleResult[]; axeError?: string; nonText: NonTextFinding[]; spacing: SpacingFinding[]; checked: { fields: number; icons: number; texts: number } }

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
/**
 * Rules about the whole HTML document, which a render of one artboard does not have the way the export has it. Bogen
 * checks language and title from the layers themselves (bogen:lang-page, bogen:page-title).
 */
export const AXE_DISABLED = ['html-has-lang', 'html-lang-valid', 'html-xml-lang-mismatch', 'document-title', 'meta-viewport', 'meta-viewport-large'];
/** Off by default in axe as experimental, and still the one machine test of 2.5.3. */
export const AXE_ENABLED = ['label-content-name-mismatch'];

const MAX_NODES = 20;

export async function complianceProbe(arg: { source: string; root: string; tags: string[]; disabled: string[]; enabled: string[]; maxNodes: number }): Promise<ProbeResult> {
  const root = document.querySelector<HTMLElement>(`[data-bogen-id="${arg.root}"]`);
  const out: ProbeResult = { axe: [], nonText: [], spacing: [], checked: { fields: 0, icons: 0, texts: 0 } };
  if (!root) return out;
  const layerOf = (el: Element | null | undefined): string => (el?.closest<HTMLElement>('[data-bogen-id]')?.dataset.bogenId ?? arg.root);

  // axe-core, scoped to the artboard.
  try {
    const w = window as unknown as { axe?: { run: (ctx: unknown, opts: unknown) => Promise<Record<string, { id: string; tags: string[]; impact: string | null; help: string; helpUrl: string; nodes: { element?: Element; failureSummary?: string; any: { data?: unknown; message: string }[]; all: { message: string }[]; none: { message: string }[] }[] }[]>> } };
    if (!w.axe) (0, eval)(arg.source);
    const rules: Record<string, { enabled: boolean }> = {};
    for (const id of arg.disabled) rules[id] = { enabled: false };
    for (const id of arg.enabled) rules[id] = { enabled: true };
    const res = await w.axe!.run(root, { runOnly: { type: 'tag', values: arg.tags }, rules, elementRef: true, resultTypes: ['violations', 'incomplete'] });
    const kinds: [string, AxeRuleResult['outcome']][] = [['violations', 'violation'], ['incomplete', 'incomplete'], ['passes', 'pass'], ['inapplicable', 'inapplicable']];
    for (const [key, outcome] of kinds) {
      for (const r of res[key] ?? []) {
        out.axe.push({
          id: r.id, tags: r.tags, impact: r.impact ?? null, help: r.help, helpUrl: r.helpUrl, outcome, count: r.nodes.length,
          nodes: outcome === 'violation' || outcome === 'incomplete' ? r.nodes.slice(0, arg.maxNodes).map((n) => {
            const first = n.any[0] ?? n.all[0] ?? n.none[0];
            const data = (first as { data?: unknown } | undefined)?.data;
            return { layer: layerOf(n.element), summary: (n.failureSummary ?? first?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), ...(data && typeof data === 'object' ? { data: JSON.parse(JSON.stringify(data)) as Record<string, unknown> } : {}) };
          }) : [],
        });
      }
    }
  } catch (e) {
    out.axeError = String((e as Error)?.message ?? e).slice(0, 300);
  }

  // Colours as the browser paints them.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = (css: string): number[] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
  };
  const over = (top: number[], bottom: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
  const backdrop = (el: Element | null): number[] | null => {
    const layers: number[][] = [];
    for (let cur = el; cur; cur = cur.parentElement) {
      const s = getComputedStyle(cur);
      if (s.backgroundImage !== 'none') return null;
      const c = rgba(s.backgroundColor);
      if (c[3]! > 0) {
        layers.push(c);
        if (c[3]! >= 1) break;
      }
    }
    let base = [255, 255, 255, 1];
    for (const l of layers.reverse()) base = over(l, base);
    return base;
  };
  const lum = (c: number[]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
  };
  const hex = (c: number[]) => `#${c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };

  // 1.4.11: a text field must show where it is, by a border or a fill that stands out from what is around it.
  for (const el of root.querySelectorAll<HTMLElement>('input, select, textarea')) {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'range', 'color', 'file'].includes(type) || !visible(el)) continue;
    out.checked.fields++;
    const s = getComputedStyle(el);
    const around = backdrop(el.parentElement);
    if (!around) continue;
    const fill = over(rgba(s.backgroundColor), around);
    const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).filter((side) => parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none');
    const borderRatios = sides.map((side) => ratio(over(rgba(s.getPropertyValue(`border-${side.toLowerCase()}-color`)), fill), around));
    const best = Math.max(ratio(fill, around), ...borderRatios, 0);
    if (best < 3) out.nonText.push({ layer: layerOf(el), what: 'field', ratio: best, colors: `${sides.length ? `border ${hex(over(rgba(s.borderBottomColor), fill))}, ` : ''}fill ${hex(fill)} on ${hex(around)}` });
  }
  // 1.4.11: an icon that is the only content of a control must stand out from the control.
  for (const el of root.querySelectorAll<HTMLElement>('a, button, [role="button"]')) {
    if (!visible(el) || (el.textContent ?? '').trim()) continue;
    const shape = el.querySelector('svg path, svg circle, svg rect, svg line, svg polyline, svg polygon, svg ellipse');
    if (!shape) continue;
    out.checked.icons++;
    const around = backdrop(el);
    if (!around) continue;
    const ss = getComputedStyle(shape);
    const paints = [ss.fill, ss.stroke].filter((p) => p && p !== 'none' && !p.startsWith('url(')).map((p) => over(rgba(p), around));
    if (!paints.length) continue;
    const best = Math.max(...paints.map((p) => ratio(p, around)));
    if (best < 3) out.nonText.push({ layer: layerOf(el), what: 'icon', ratio: best, colors: `${paints.map(hex).join(', ')} on ${hex(around)}` });
  }

  // 1.4.12: text that fits now, cut off once people set their own spacing.
  const texts = [...root.querySelectorAll<HTMLElement>('[data-bogen-id]')].filter((el) => [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim()) && visible(el));
  out.checked.texts = texts.length;
  const clipped = (el: HTMLElement): string | null => {
    const s = getComputedStyle(el);
    if ((el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible') || (el.scrollHeight > el.clientHeight + 1 && s.overflowY !== 'visible')) return layerOf(el);
    if (s.webkitLineClamp && s.webkitLineClamp !== 'none') return layerOf(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const ink = range.getBoundingClientRect();
    for (let cur = el.parentElement; cur; cur = cur === root ? null : cur.parentElement) {
      const ps = getComputedStyle(cur);
      if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
      const clip = cur.getBoundingClientRect();
      if (ink.right > clip.right + 1 || ink.bottom > clip.bottom + 1) return layerOf(cur);
    }
    return null;
  };
  const before = new Map(texts.map((el) => [el, clipped(el)]));
  const style = document.createElement('style');
  style.textContent = '[data-bogen-id], [data-bogen-id] * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } [data-bogen-id] p { margin-bottom: 2em !important; }';
  document.head.appendChild(style);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (const el of texts) {
    if (before.get(el)) continue;
    const by = clipped(el);
    if (by) out.spacing.push({ layer: layerOf(el), text: (el.textContent ?? '').trim().slice(0, 60), clippedBy: by });
  }
  style.remove();
  return out;
}

export const PROBE_LIMITS = { maxNodes: MAX_NODES };
