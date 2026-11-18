import { baseMode, camelCss, type BogenDoc, type BogenNode } from '@bogen/core';
import type { Renderer, Target, ScreenshotOptions, ImageBytes } from './render.ts';
import { appBoardOf, appIssues, appIssuesFrom, appProbe, edgeSlip, linkedPlatformKits } from './mcp/app-checks.ts';
import { lintProbe, staticIssues, type LintIssue, type RenderedBox } from './mcp/lint.ts';

export const MAP_BUDGET = 3000;
export const AGENT_PICTURE = { format: 'jpg', quality: 75, scale: 1, maxDimension: 768, maxBytes: 2_800_000 } as const satisfies ScreenshotOptions;
const round = Math.round;
const short = (s: string, n = 36) => { const text = s.replace(/\s+/g, ' '); return text.length > n ? text.slice(0, n - 1) + '…' : text; };
const clear = (s: string) => !s || s === 'transparent' || s === 'rgba(0, 0, 0, 0)';

/** Use the original reference, never rename a literal just because it happens to equal a token. */
function named(doc: BogenDoc, node: BogenNode | undefined, prop: string, value: string): string {
  const key = camelCss(prop);
  for (const n of node ? [node, ...doc.ancestors(node.id).flatMap((id) => doc.getNode(id) ?? [])] : []) {
    const raw = n.style[key] ?? (prop === 'background-color' ? n.style.background : prop.startsWith('border-') ? n.style.border : undefined);
    if (raw) return raw.includes('var(') ? raw.replace(/var\((--[\w-]+)(?:,[^)]*)?\)/g, '$1') : value;
    if (!/^(color|font-)/.test(prop)) break;
  }
  return value;
}

/** Sibling geometry only: containment is intentional layering, not an overlap defect. */
export function geometryIssues(boxes: RenderedBox[], alignmentIds = new Set(boxes.map((b) => b.id))): LintIssue[] {
  const groups = new Map<string | null, RenderedBox[]>();
  for (const b of boxes) { const group = groups.get(b.parent) ?? []; group.push(b); groups.set(b.parent, group); }
  const out: LintIssue[] = [];
  for (const group of groups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i]!, b = group[j]!;
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    const contains = (a: RenderedBox, b: RenderedBox) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
    if (w > 1 && h > 1 && !contains(a, b) && !contains(b, a)) out.push({ rule: 'spacing', check: 'overlap', nodeId: a.id, name: '', message: `Overlaps ${b.id} by ${round(w)}x${round(h)}px (may be intentional).` });
    if (alignmentIds.has(a.id) && alignmentIds.has(b.id)) {
      const edges = h <= 0 ? [['left', a.x, b.x], ['right', a.x + a.width, b.x + b.width]] as const
        : w <= 0 ? [['top', a.y, b.y], ['bottom', a.y + a.height, b.y + b.height]] as const : [];
      const off = edges.find(([, x, y]) => edgeSlip(x, y));
      if (off) out.push({ rule: 'spacing', check: 'edge-slip', nodeId: b.id, name: '', message: `${off[0]} edge is ${round(Math.abs(off[1] - off[2]))}px from sibling ${a.id} (${round(off[1])} vs ${round(off[2])}px); check intended alignment.` });
    }
  }
  return out;
}

/** Pure formatter: all positions are CSS px, relative to the captured layer or the aligned page. */
export function formatLayoutMap(doc: BogenDoc, boxes: RenderedBox[], issues: LintIssue[], options: { nodeId?: string; budget?: number } = {}): string {
  const budget = Math.max(400, options.budget ?? MAP_BUDGET);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const selected = options.nodeId ? byId.get(options.nodeId) : undefined;
  const rootBoxes = boxes.filter((b) => !byId.has(b.parent ?? ''));
  const origin = selected ?? { x: Math.min(0, ...rootBoxes.map((b) => b.x)), y: Math.min(0, ...rootBoxes.map((b) => b.y)) };
  const width = selected?.width ?? Math.max(0, ...rootBoxes.map((b) => b.x + b.width)) - origin.x;
  const height = selected?.height ?? Math.max(0, ...rootBoxes.map((b) => b.y + b.height)) - origin.y;
  const theme = (id: string) => [id, ...doc.ancestors(id)].map((id) => doc.getNode(id)?.mode).find(Boolean) ?? baseMode(doc) ?? 'base';
  const header = `Layout map ${round(width)}x${round(height)} CSS px; x,y,w,h relative to capture; theme ${short([...new Set(rootBoxes.map((b) => theme(b.id)))].join('/') || 'base', 80)}; bg ${short([...new Set(rootBoxes.map((b) => named(doc, doc.getNode(b.id), 'background-color', b.style['background-color'] ?? 'transparent')))].join('/') || 'transparent', 120)}`;
  if (!boxes.length) return `${header}\n(no visible boxes)`;
  const kids = new Map<string | null, RenderedBox[]>();
  for (const b of boxes) { const key = byId.has(b.parent ?? '') ? b.parent : null; const list = kids.get(key) ?? []; list.push(b); kids.set(key, list); }
  const styleText = (b: RenderedBox) => {
    const n = doc.getNode(b.id), s = b.style;
    const pad = ['top', 'right', 'bottom', 'left'].map((p) => round(parseFloat(s[`padding-${p}`] ?? '') || 0));
    const parts = [pad.some(Boolean) ? `p=${pad.join('/')}` : ''];
    if (b.text) parts.push(`"${short(b.text, 64)}" ${short(named(doc, n, 'font-family', s['font-family'] ?? ''), 32)} ${s['font-size']}/${s['font-weight']} ${named(doc, n, 'color', s.color ?? '')} ${b.lines}L`);
    if (!clear(s['background-color'] ?? '')) parts.push(`fill=${named(doc, n, 'background-color', s['background-color']!)}`);
    if (s['background-image'] && s['background-image'] !== 'none') parts.push(`image=${short(s['background-image'], 45)}`);
    const borders = ['top', 'right', 'bottom', 'left'].map((p) => ({ prop: `border-${p}`, value: s[`border-${p}`] ?? '' })).filter(({ value }) => value && !/^0px| none /.test(value));
    if (borders.length) parts.push(`border=${[...new Set(borders.map(({ prop, value }) => named(doc, n, prop, value)))].join('/')}`);
    return parts.filter(Boolean).join(' ');
  };
  const signatures = new Map<string, string>();
  const signature = (b: RenderedBox): string => {
    const known = signatures.get(b.id); if (known) return known;
    // Text and names can vary in a repeated list; geometry, type and child offsets cannot.
    const key = JSON.stringify([b.tag, b.role, round(b.width), round(b.height), b.style, b.lines, !!b.text,
      (kids.get(b.id) ?? []).map((c) => [round(c.x - b.x), round(c.y - b.y), signature(c)])]);
    signatures.set(b.id, key); return key;
  };
  const rows: string[] = [];
  const walk = (list: RenderedBox[], depth: number) => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!, children = kids.get(b.id) ?? [];
      let count = 1;
      while (i + count < list.length && signature(b) === signature(list[i + count]!)) {
        const next = list[i + count]!, prev = list[i + count - 1]!;
        if (count > 1 && (round(next.x - prev.x) !== round(list[i + 1]!.x - b.x) || round(next.y - prev.y) !== round(list[i + 1]!.y - b.y))) break;
        count++;
      }
      if (!children.length && count < 3) count = 1;
      const prev = list[i - 1];
      const gap = prev ? (Math.min(b.y + b.height, prev.y + prev.height) > Math.max(b.y, prev.y) ? b.x - prev.x - prev.width : b.y - prev.y - prev.height) : undefined;
      rows.push(`${' '.repeat(depth)}${b.role || b.tag} ${short(doc.getNode(b.id)?.name ?? '')} [${b.id}] ${[b.x - (origin?.x ?? 0), b.y - (origin?.y ?? 0), b.width, b.height].map(round).join(',')}${gap === undefined ? '' : ` gap=${round(gap)}`} ${styleText(b)}${count > 1 ? ` ×${count} (text varies; step=${round(list[i + 1]!.x - b.x)},${round(list[i + 1]!.y - b.y)})` : ''}`.trimEnd());
      walk(children, depth + 1); i += count - 1;
    }
  };
  walk(kids.get(null) ?? [], 0);
  const unique = [...new Map(issues.filter((i) => byId.has(i.nodeId)).map((i) => [`${i.nodeId}:${i.check ?? i.rule}:${i.message}`, i])).values()];
  const issueRows = unique.map((i) => `! ${i.check ?? i.rule} [${i.nodeId}]: ${short(i.message, 210)}`);
  // Reserve room for findings so a large tree cannot hide defects; disclose every omission.
  const fit = (lines: string[], limit: number) => {
    const kept: string[] = []; let length = 0;
    for (const line of lines) { if (length + line.length + 1 > limit) break; kept.push(line); length += line.length + 1; }
    if (kept.length < lines.length) kept.push(`… ${lines.length - kept.length} more; narrow node_id or use design_lint/layer_tree.`);
    return kept.join('\n');
  };
  const findings = issueRows.length ? fit(issueRows, Math.min(budget * 0.45, issueRows.join('\n').length + 1)) : 'Issues: none detected (images and intentional layering need visual judgement).';
  return `${header}\n${fit(rows, budget - header.length - findings.length - 85)}\n${findings}`.slice(0, budget);
}

export async function layoutMap(doc: BogenDoc, renderer: Renderer, target: Target, options: { budget?: number; issues?: LintIssue[]; width?: number } = {}): Promise<string> {
  const roots = target.nodeIds ?? doc.getChildren(target.pageId ?? doc.getPages()[0]?.id ?? '').map((n) => n.id);
  for (const id of roots) if (!doc.getNode(id)) throw new Error(`No layer with id ${id}.`);
  const nodes = roots.flatMap((id) => [doc.getNode(id)!, ...doc.descendants(id)]);
  const arg = { ids: nodes.map((n) => n.id), minText: 11, minTarget: 24, map: true };
  const rendered = options.width && roots.length === 1
    ? (await renderer.atWidths(doc, roots[0]!, [options.width], lintProbe, arg))[0]!.result
    : await renderer.probe(doc, target, lintProbe, arg);
  const visible = new Set(rendered.boxes.map((b) => b.id));
  const live = nodes.filter((n) => visible.has(n.id));
  let app = options.issues;
  if (!app && options.width && roots.length === 1) {
    const board = appBoardOf(doc, roots[0]!);
    if (board) {
      const got = (await renderer.atWidths(doc, roots[0]!, [options.width], appProbe, { root: roots[0]! }))[0]!.result;
      app = appIssuesFrom(doc, { ...board, width: got.board.w, height: got.board.h }, got.els, { hasKit: linkedPlatformKits(doc)[board.platform], boardStyle: got.board.style });
    } else app = [];
  }
  app ??= (await appIssues(doc, renderer, live)).issues;
  const issues = [
    ...rendered.issues.map((i) => ({ rule: i.rule, nodeId: i.id, name: '', message: i.message })),
    ...staticIssues(doc, live).filter((i) => i.rule === 'spacing' || i.rule === 'grid'),
    ...app.filter((i) => i.rule === 'target' || i.check === 'edge-slip' || i.check === 'gap-slip'),
    ...geometryIssues(rendered.boxes, new Set(rendered.boxes.filter((b) => !appBoardOf(doc, b.id)).map((b) => b.id))),
  ];
  return formatLayoutMap(doc, rendered.boxes, issues, { nodeId: target.nodeIds?.length === 1 ? target.nodeIds[0] : undefined, budget: options.budget });
}

/** Diagnostic rasters are measured at full fidelity first, then compressed for agent delivery. */
export async function agentImage(renderer: Renderer, image: ImageBytes) {
  const small = await renderer.transcode(image, { type: 'image/jpeg', quality: 0.75, maxDimension: 768 });
  if (!small) throw new Error('The picture could not be encoded for the agent.');
  return { type: 'image' as const, data: Buffer.from(small.bytes).toString('base64'), mimeType: 'image/jpeg' };
}

/** Shared screen delivery for MCP tools. Export and diagnostic pixel comparisons keep their source rasters. */
export async function agentCapture(doc: BogenDoc, renderer: Renderer, target: Target, options: ScreenshotOptions & { mapOnly?: boolean } = {}) {
  const map = await layoutMap(doc, renderer, target);
  if (options.mapOnly) return { content: [{ type: 'text' as const, text: map }] };
  const shot = await renderer.screenshot(doc, target, { ...AGENT_PICTURE, ...options });
  return { content: [
    { type: 'image' as const, data: Buffer.from(shot.bytes).toString('base64'), mimeType: shot.mime },
    { type: 'text' as const, text: `${shot.width}x${shot.height}px at scale ${Math.round(shot.scale * 100) / 100}, ${shot.format}.\n${map}` },
  ] };
}
