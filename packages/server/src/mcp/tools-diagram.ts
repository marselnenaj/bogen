import { importHtml, type BogenDoc, type NewNode } from '@bogen/core';
import { dropInvalidCss } from '@bogen/core/css-check';
import { z } from 'zod';
import { diagramHtml, diagramPaint, layoutDiagram, MAX_DIAGRAM_SOURCE } from '../diagram.ts';
import { assertUnlocked, fileIdArg, nextArtboardX, outline, pageIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/** A token's value followed through var() to a literal, for measuring in a page that has no tokens. */
export function literal(doc: BogenDoc, value: string, depth = 0): string {
  if (depth > 8) return value;
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  return value.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string, fallback?: string) => {
    const v = tokens.get(name);
    return v !== undefined ? literal(doc, v, depth + 1) : fallback?.trim() || whole;
  });
}

/** Where new layers go: into a frame, or onto the page as a board of their own at the next free spot. */
export function placeLayers(ctx: ToolContext, doc: BogenDoc, nodes: NewNode[], where: { target_id?: string; index?: number; pageId: string; x?: number; y?: number }): string[] {
  if (where.target_id) {
    if (!doc.getNode(where.target_id)) throw new Error(`No layer with id ${where.target_id}. Call layer_tree to see what exists.`);
    assertUnlocked(doc, [where.target_id]);
    return doc.insertMany(where.target_id, nodes, where.index);
  }
  let left = where.x ?? nextArtboardX(doc, where.pageId);
  for (const n of nodes) {
    n.style = { ...n.style, position: 'absolute', left: `${left}px`, top: `${where.y ?? 0}px` };
    if (n.type === 'frame') n.artboard = true;
    left += (Number.parseFloat(n.style.width ?? '') || 800) + 80;
  }
  return doc.insertMany(where.pageId, nodes);
}

export function registerDiagramTools(define: ToolDefiner): void {
  define('diagram_insert', { description: `Draw a Mermaid diagram as native layers: flowchart (graph), sequence, state (stateDiagram-v2), and also class, ER and the other types Mermaid lays out. Mermaid parses it and lays it out with its own layout; the result is plain frames for nodes with their labels as text, connectors as SVG paths with their arrowheads, groups as dashed frames, and lines and labels as layers, all in this file's tokens (surface, text, border or line, accent, the body font and radius, by name, with neutral values where a token is missing). Everything stays editable afterwards; the diagram does not update from the text again, so call it again to redo one. Without target_id it becomes a board of its own on the page; with target_id it goes into that frame at its size. At most ${MAX_DIAGRAM_SOURCE} characters and 1500 parts. Then canvas_screenshot it.` }, {
    source: z.string().min(1).max(MAX_DIAGRAM_SOURCE).describe('The Mermaid text, such as "flowchart LR\\n  A[Sign up] --> B{Verified?}\\n  B -- yes --> C[Dashboard]".'),
    name: z.string().min(1).max(200).optional().describe('The layer name. Default "Diagram" with its type.'),
    target_id: z.string().optional().describe('A frame to put it in. Leave out for a board of its own.'),
    index: z.number().int().min(0).optional().describe('With target_id: the position among its children.'),
    x: z.number().optional().describe('Without target_id: the position on the page. Default the next free spot.'),
    y: z.number().optional(),
    padding: z.number().min(0).max(400).default(32).describe('Space around the diagram, in px.'),
    font_size: z.number().min(8).max(48).default(14),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ source, name, target_id, index, x, y, padding, font_size, page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const doc = room.doc;
    const pageId = ctx.page(room, page_id);
    if (target_id) assertUnlocked(doc, [target_id]);
    const paint = diagramPaint(doc.getTokens(), await ctx.app.brands.bodyFont(room));
    const font = literal(doc, paint.font);
    const family = font.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
    const model = await layoutDiagram(ctx.app.renderer, source, { font, family: /^(system-ui|sans-serif|serif|monospace)$/.test(family) ? undefined : family, size: font_size });
    if (!model.nodes.length && !model.edges.length && !model.labels.length) throw new Error('Mermaid drew nothing for this text. Check that it starts with a diagram type such as flowchart TD, sequenceDiagram or stateDiagram-v2.');
    const html = diagramHtml(model, paint, { name: name ?? `Diagram: ${model.type}`, padding, background: !target_id });
    const { nodes } = importHtml(html);
    dropInvalidCss(nodes);
    const ids = ctx.write(room, () => placeLayers(ctx, doc, nodes, { target_id, index, pageId, x, y }));
    ctx.touch(ids);
    return {
      id: ids[0], type: model.type, width: Math.round(model.width + padding * 2), height: Math.round(model.height + padding * 2),
      counts: { nodes: model.nodes.length, connectors: model.edges.length, labels: model.labels.length, groups: model.clusters.length, other_shapes: model.shapes.length },
      tokens: paint.used, ...(Object.keys(paint.used).length < 4 ? { note: 'Some colours fell back to neutral values because the file has no token for them. tokens_set surface, text, border and accent, then call again.' } : {}),
      tree: outline(doc, ids, 2, 40), next: 'canvas_screenshot it. Nodes are frames with a text label, connectors are SVG layers: edit them like any layer.',
    };
  });
}
