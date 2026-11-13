import { camelCss, cssValueContains, listOverrides, matchingLayers, type NodeType } from '@bogen/core';
import { z } from 'zod';
import { handoffCode } from '../code-handoff.ts';
import { fileIdArg, outline, pageIdArg, type ToolDefiner } from './kit.ts';

const NODE_TYPES = ['frame', 'text', 'image', 'svg', 'shader', 'video', 'embed'] as const satisfies readonly NodeType[];
/** About 3.7 MB once in base64, under what MCP clients accept for one image. */
const MCP_IMAGE_BYTES = 2_800_000;
const MCP_IMAGE_DIMENSION = 2000;

export function registerReadTools(define: ToolDefiner): void {
  define('layer_tree', { description: 'An indented outline of a page or layer: id, type, tag, name, main layout styles, a text snippet, and which pseudo-element and condition blocks a layer has (rules {…}). Use a small depth first and drill into what matters with node_id. This is how you find layer ids.', readOnly: true }, {
    node_id: z.string().optional().describe('Show the tree under this layer. Leave out for the whole page.'),
    page_id: pageIdArg,
    depth: z.number().int().min(1).max(20).default(3).describe('Levels to show. Deeper levels are counted, not listed.'),
    file_id: fileIdArg,
  }, async ({ node_id, page_id, depth, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const doc = room.doc;
    if (node_id) {
      if (!doc.getNode(node_id)) throw new Error(`No layer with id ${node_id}. Leave node_id out for the whole page, or call layer_find for the ids that exist.`);
      return outline(doc, [node_id], depth);
    }
    const pageId = ctx.page(room, page_id);
    const roots = doc.getChildren(pageId).map((n) => n.id);
    const name = doc.getPages().find((p) => p.id === pageId)?.name;
    return `Page "${name}" (${pageId})\n${roots.length ? outline(doc, roots, depth) : '(empty)'}`;
  });

  define('layer_get', { description: 'The full data of one layer: its style (camelCase CSS), text, source, attributes, parent and child ids, and rules: its pseudo-elements and conditional blocks, such as "::before" or "@container (max-width: 560px)", each with its declarations. Read this before editing a layer you did not write. It shows what is stored; for the values the browser ends up with (sizes, inherited fonts, tokens resolved) use layer_styles_computed, and for many layers at once layer_tree.', readOnly: true }, {
    node_id: z.string(),
    file_id: fileIdArg,
  }, async ({ node_id, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    const node = doc.getNode(node_id);
    if (!node) throw new Error(`No layer with id ${node_id}. Call layer_tree or layer_find for the ids that exist now.`);
    const { order: _order, ...rest } = node;
    return { ...rest, ...(node.instanceOf || node.virtual ? { overridden: listOverrides(doc.source, node_id) } : {}), children: doc.getChildren(node_id).map((c) => ({ id: c.id, type: c.type, name: c.name })), page: doc.pageOf(node_id) };
  });

  define('layer_find', { description: 'Search layers by text, name, type, tag or style. Filters combine. Text and name match anywhere in the value, ignoring case. For example style {"backgroundColor":"#000"} finds layers with that fill. Style values are compared as CSS: .5 matches 0.5, 0 matches 0px, #FFF matches #ffffff and rgb(255, 255, 255), and 0.5 does not match 0.55. like finds the layers that match these layers, as the editor\'s Select matching layers does: the same type, element, component, text style, the rest of their style and the shape of what is inside them, whatever their position, size or words, on the same page.', readOnly: true }, {
    text: z.string().optional(),
    name: z.string().optional(),
    type: z.enum(NODE_TYPES).optional(),
    tag: z.string().optional().describe('Exact HTML tag, such as button.'),
    style: z.record(z.string(), z.string()).optional().describe('CSS property to a value it must contain. Either camelCase or kebab-case names.'),
    within: z.string().optional().describe('Only search under this page or layer. Default is the whole file.'),
    like: z.array(z.string()).min(1).max(50).optional().describe('Layer ids: find the layers that match them.'),
    limit: z.number().int().min(1).max(500).default(50),
    file_id: fileIdArg,
  }, async ({ text, name, type, tag, style, within, like, limit, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    const wanted = Object.entries(style ?? {}).map(([k, v]) => [camelCss(k), v] as const);
    for (const id of like ?? []) if (!doc.getNode(id)) throw new Error(`No layer with id ${id}.`);
    const matching = like ? new Set(matchingLayers(doc, like, within ? { within } : {})) : null;
    const pool = matching ? [...matching].flatMap((id) => doc.getNode(id) ?? []) : within ? doc.descendants(within) : doc.getPages().flatMap((p) => doc.descendants(p.id));
    const hits = pool.filter((n) => {
      if (type && n.type !== type) return false;
      if (tag && n.tag !== tag) return false;
      if (name && !n.name.toLowerCase().includes(name.toLowerCase())) return false;
      if (text && !(n.text ?? '').toLowerCase().includes(text.toLowerCase())) return false;
      return wanted.every(([k, v]) => n.style[k] !== undefined && cssValueContains(n.style[k], v));
    });
    return {
      total: hits.length,
      layers: hits.slice(0, limit).map((n) => ({ id: n.id, type: n.type, tag: n.tag, name: n.name, parent: n.parent, ...(n.text ? { text: n.text.slice(0, 120) } : {}) })),
    };
  });

  define('layer_styles_computed', { description: 'What the browser actually computed for layers: the measured box and final CSS values, after inheritance, tokens, layout and the conditions that hold. Use it to check real sizes and to debug layout. width lays the artboard out at that width first, so that media and container conditions answer as they would there; pseudo reads a ::before or ::after (the box stays the layer\'s). Slower than layer_get, as it renders.', readOnly: true }, {
    node_ids: z.array(z.string()).min(1).max(50),
    properties: z.array(z.string()).max(100).optional().describe('kebab-case CSS properties. Leave out for a useful default set.'),
    width: z.number().int().min(100).max(6000).optional().describe('Lay out the artboard these layers are in at this width first.'),
    pseudo: z.enum(['::before', '::after', '::marker', '::placeholder', '::first-letter', '::first-line']).optional(),
    file_id: fileIdArg,
  }, async ({ node_ids, properties, width, pseudo, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return ctx.app.renderer.computed(doc, node_ids, properties, { ...(width ? { width } : {}), ...(pseudo ? { pseudo } : {}) });
  });

  define('canvas_screenshot', { description: 'Render a layer or a whole page to an image and look at it. Use it after every section you write, and check spacing, hierarchy, contrast and whether anything overflowed. Works with no editor open. Images are limited to 2000px on the long side. To measure a difference against another layer or a reference picture use visual_diff, and to save a file for the person use export_file.', readOnly: true }, {
    node_id: z.string().optional().describe('The layer to capture. Leave out for the whole page.'),
    page_id: pageIdArg,
    scale: z.number().min(0.1).max(4).default(1).describe('Pixel density. 1 is enough to review a page; use 2 to inspect details on a small layer.'),
    format: z.enum(['png', 'jpg', 'webp']).default('png'),
    file_id: fileIdArg,
  }, async ({ node_id, page_id, scale, format, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const target = node_id ? { nodeIds: [node_id] } : { pageId: ctx.page(room, page_id) };
    if (node_id) ctx.touch([node_id]);
    const captureIds = node_id ? [node_id] : [ctx.page(room, page_id)];
    const captured = ctx.app.designQuality.capture(room.doc, captureIds);
    const shot = await ctx.app.renderer.screenshot(room.doc, target, { scale, format, maxDimension: MCP_IMAGE_DIMENSION, maxBytes: MCP_IMAGE_BYTES });
    ctx.app.designQuality.seen(room.id, room.doc, captureIds, ctx.session.runId, captured);
    return {
      content: [
        { type: 'image', data: Buffer.from(shot.bytes).toString('base64'), mimeType: shot.mime },
        { type: 'text', text: `${shot.width}x${shot.height}px at scale ${Math.round(shot.scale * 100) / 100}, ${shot.format}.` },
      ],
    };
  });

  define('code_get', { description: 'Turn a layer into code to hand off: html with inline styles, react-inline, or react-tailwind; or, experimental, exact: a minimal Exact app (github.com/expo/exact) whose view is written in its Contract language, as app.contract, app.ts, app.json, app.test.contract and app.tamber for the tokens, with a list of what Contract could not say. vue (single-file components, script setup in TypeScript), svelte (Svelte 5 with runes) and swiftui (iOS 17 and macOS 14) come out as files under a line that names each: a component per file with its props and variant axes, the page or screen that uses them, bogen.css or Tokens.swift with the tokens in light and dark, and a list of what the format could not say. In React, Vue, Svelte and SwiftUI a component comes out as a real component with typed props, and instances as usages of it; a kit that is markup (daisyUI, USWDS, Pico CSS, Web Awesome) stays its markup in Vue and Svelte, and a kit of a React library is written from its drawing there and in SwiftUI. Returns the CSS for any tokens and text styles the code uses. Motion (keyframes, animation, transition) comes out as clean CSS by default: @keyframes, and animation and transition on a class per moving layer, only under prefers-reduced-motion: no-preference. motion framer writes Framer Motion props for React instead, inline keeps it in the style. Treat it as an exact specification, and adapt it to the target codebase.', readOnly: true }, {
    node_id: z.string(),
    format: z.enum(['html', 'react-inline', 'react-tailwind', 'vue', 'svelte', 'swiftui', 'exact']).default('html').describe('exact is experimental, written against one Exact commit: save its files in a folder, or use export_file with format exact. vue, svelte and swiftui are several files: export_file with the same format writes them into a folder.'),
    motion: z.enum(['css', 'framer', 'inline']).default('css').describe('css: classes and a style sheet. framer: motion.div with initial, animate, transition and whileHover, in a MotionConfig that honours reduced motion (React only). inline: as stored. Not used by exact, which leaves motion out. SwiftUI plays keyframes as a withAnimation that reduce motion turns off.'),
    file_id: fileIdArg,
  }, async ({ node_id, format, motion: motionMode, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return handoffCode(doc, node_id, format, ctx.app.localUrl(), motionMode);
  });
}
