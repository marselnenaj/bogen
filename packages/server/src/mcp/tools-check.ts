import { getModes, getTextStyles, textStylesCss, themeCss, type ThemeMode } from '@bogen/core';
import type { BogenDoc, Token } from '@bogen/core';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImageBytes, Renderer, WidthResult } from '../render.ts';
import { checkWidths } from '../width-check.ts';
import { applyA11yFixes, auditA11y } from '../a11y.ts';
import { TAILWIND, tailwindKey } from '../repo-tokens.ts';
import { assertUnlocked, fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';
import { fileDesignMd } from './tools-design-md.ts';

const DIFF_RENDER_DIMENSION = 4000;
const DIFF_IMAGE_DIMENSION = 1000;
const DIFF_IMAGE_BYTES = 1_500_000;
const WIDTH_SHOT_DIMENSION = 800;
/** Most changed layers listed per viewport height. */
const MAX_REPORTED = 30;

const cssBlock = (selector: string, lines: string[]) => `${selector} {\n${lines.map((l) => `  ${l}`).join('\n')}\n}`;

function exportCss(tokens: Token[], selector: string, modes: ThemeMode[] = [], modeSelector?: (mode: string) => string): string {
  return themeCss(tokens, modes, { selector, ...(modeSelector ? { modeSelector } : {}) }, true) || cssBlock(selector, []);
}

/**
 * Keeps the variables that `code_get` output uses, and maps Tailwind's utilities onto them, so a
 * class such as `bg-accent` and a style such as `var(--accent)` stay the same value.
 */
function exportTailwind(tokens: Token[], modes: ThemeMode[] = [], modeSelector?: (mode: string) => string): string {
  const theme = tokens.flatMap((t) => {
    const name = `--${TAILWIND[t.kind].namespace}-${tailwindKey(t)}`;
    // Breakpoints and containers end up in media and container queries, which cannot read a variable.
    const value = (t.kind === 'breakpoint' || t.kind === 'container') && !t.value.includes('var(') ? t.value : `var(--${t.name})`;
    // A size token is only a size: without this, text-sm would also take Tailwind's own line height for sm.
    return t.kind === 'font-size' ? [`${name}: ${value};`, `${name}--line-height: initial;`] : [`${name}: ${value};`];
  });
  return `${exportCss(tokens, ':root', modes, modeSelector)}\n\n${cssBlock('@theme inline', theme)}`;
}

function exportTailwind3(tokens: Token[], modes: ThemeMode[] = [], modeSelector?: (mode: string) => string): string {
  const extend: Record<string, Record<string, string>> = {};
  for (const t of tokens) (extend[TAILWIND[t.kind].v3] ??= {})[tailwindKey(t)] = `var(--${t.name})`;
  return `${exportCss(tokens, ':root', modes, modeSelector)}\n\n/* tailwind.config: */\n${JSON.stringify({ theme: { extend } }, null, 2)}`;
}

/** Runs in the page. Measure geometry, including svh: in-app WebViews may resize
 * the initial containing block as their browser controls expand and collapse. */
function viewportProbe(arg: { root: string }) {
  const root = document.querySelector<HTMLElement>(`[data-bogen-id="${arg.root}"]`)!;
  const box = root.getBoundingClientRect();
  return {
    height: box.height,
    layers: [root, ...root.querySelectorAll<HTMLElement>('[data-bogen-id]')].map((el) => {
      const rect = el.getBoundingClientRect();
      return { id: el.dataset.bogenId!, top: rect.top - box.top, height: rect.height, visible: !!rect.width && !!rect.height && getComputedStyle(el).visibility !== 'hidden', position: getComputedStyle(el).position };
    }),
  };
}

function renderLayer(doc: BogenDoc, renderer: Renderer, nodeId: string): Promise<ImageBytes> {
  return renderer.screenshot(doc, { nodeIds: [nodeId] }, { format: 'png', scale: 1, maxDimension: DIFF_RENDER_DIMENSION });
}

/** Shared by MCP and saved, user-defined checks. */
export async function responsiveReport(doc: BogenDoc, renderer: Renderer, { node_id, widths, viewport_heights, screenshots = false, viewport_tolerance }: { node_id: string; widths: number[]; viewport_heights?: number[]; screenshots?: boolean; viewport_tolerance?: number }): Promise<CallToolResult> {
  if (!doc.getNode(node_id)) throw new Error(`No layer with id ${node_id}. Call layer_tree to see what exists.`);
  const check = await checkWidths(doc, renderer, node_id, widths, { shots: screenshots, maxDimension: WIDTH_SHOT_DIMENSION });
  let viewportStability;
  if (viewport_heights) {
    const tolerance = viewport_tolerance ?? 1;
    const samples: WidthResult<ReturnType<typeof viewportProbe>>[][] = [];
    for (const height of viewport_heights) samples.push(await renderer.atWidths(doc, node_id, widths, viewportProbe, { root: node_id }, { viewportHeight: height }));
    const comparisons = widths.map((width, index) => {
      const baseline = samples[0]![index]!.result;
      const byId = new Map(baseline.layers.map((layer) => [layer.id, layer]));
      return { width, baseline_height: baseline.height, samples: samples.map((sample, i) => {
        const actual = sample[index]!.result;
        const changes = actual.layers.flatMap((layer) => {
          const before = byId.get(layer.id)!;
          const top = layer.top - before.top;
          const height = layer.height - before.height;
          if (Math.abs(top) <= tolerance && Math.abs(height) <= tolerance && layer.visible === before.visible && layer.position === before.position) return [];
          return [{ id: layer.id, name: doc.getNode(layer.id)?.name ?? '', top_changed_by: Math.round(top * 10) / 10, height_changed_by: Math.round(height * 10) / 10, position_before: before.position, position_after: layer.position, visible_before: before.visible, visible_after: layer.visible }];
        });
        return { viewport_height: viewport_heights[i], content_height: actual.height, stable: Math.abs(actual.height - baseline.height) <= tolerance && !changes.length, changed_layers: changes.slice(0, MAX_REPORTED), changed_layer_count: changes.length };
      }) };
    });
    viewportStability = { stable: comparisons.every((r) => r.samples.every((s) => s.stable)), widths: comparisons, note: 'Height-only WebView resize simulation. Changes may be intentional; inspect them without removing the scroll effect. This does not test real Safari browser controls, momentum or scroll anchoring.' };
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ...check.report, ...(viewportStability ? { viewport_stability: viewportStability } : {}) }, null, 1) },
      ...check.shots.map((shot) => ({ type: 'image' as const, data: Buffer.from(shot).toString('base64'), mimeType: 'image/png' })),
    ],
  };
}

export function registerCheckTools(define: ToolDefiner): void {
  define('visual_diff', { description: 'Compare two layers, or a layer against a reference image, and see exactly what differs: the percentage of differing pixels, where they are, and a picture with differences in red. Use it to confirm that a refactor changed nothing, or to measure how close you are to a reference: upload the reference with asset_upload and compare again after each fix. Both sides render at scale 1 and line up at their top left corners. Sizes that differ count as differences unless fit is true.', readOnly: true }, {
    node_id: z.string().describe('The layer to check.'),
    other_node_id: z.string().optional().describe('Compare with this layer.'),
    asset: z.string().optional().describe('Or with this image, as a src from asset_upload, such as bogen-asset:abc.png.'),
    threshold: z.number().min(0).max(1).default(0.1).describe('How far a colour channel may differ before a pixel counts, from 0 to 1. Above 0 it ignores antialiasing noise.'),
    fit: z.boolean().default(false).describe('Scale the other side to the size of node_id first, as for a reference exported at 2x.'),
    file_id: fileIdArg,
  }, async ({ node_id, other_node_id, asset, threshold, fit, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (Boolean(other_node_id) === Boolean(asset)) throw new Error('Give either other_node_id or asset.');
    const { renderer, storage } = ctx.app;
    const a = await renderLayer(room.doc, renderer, node_id);
    let b: ImageBytes;
    if (asset) {
      const stored = await storage.readAsset(asset.replace(/^bogen-asset:/, ''));
      if (!stored) throw new Error(`No asset named ${asset}. Upload the reference picture with asset_upload and pass the src it returns.`);
      if (!stored.mime.startsWith('image/')) throw new Error(`${asset} is ${stored.mime}, not an image. visual_diff compares with a PNG, JPEG or WebP: upload one with asset_upload, or compare two layers with other_node_id.`);
      b = stored;
    } else b = await renderLayer(room.doc, renderer, other_node_id!);
    const diff = await renderer.compareImages(a, b, { threshold, fit, maxDimension: DIFF_IMAGE_DIMENSION, maxBytes: DIFF_IMAGE_BYTES });
    const percent = diff.total ? Math.round((diff.different / diff.total) * 10000) / 100 : 0;
    ctx.touch([node_id]);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ different_percent: percent, different_pixels: diff.different, total_pixels: diff.total, size_a: diff.sizeA, size_b: diff.sizeB, same_size: diff.sizeA.width === diff.sizeB.width && diff.sizeA.height === diff.sizeB.height, bounds: diff.bounds, picture: `${diff.pngWidth}x${diff.pngHeight}px, differences in red` }, null, 1) },
        { type: 'image', data: Buffer.from(diff.png).toString('base64'), mimeType: 'image/png' },
      ],
    };
  });

  define('responsive_check', { description: 'Render an artboard at several widths and report what breaks: layers sticking out past its edges, and text cut off by its own box or by a parent. It really lays out at each width, so results reflect your flex and grid. Use it before you call a page finished, and fix fixed pixel widths with width:100%, max-width and flex-wrap. Only the artboard\'s width changes, and that is what conditions read: a media width query on a layer reads the artboard\'s width, and a container query its container\'s, so they take effect here as they will in the browser. Make layouts adapt with flex, grid and min/max first, and add conditions with layer_style when for what they cannot do. For viewport-height sections or sticky cards on mobile, pass viewport_heights such as [664,760,600] to measure geometry changes at a fixed width as WebView toolbars resize the browser. These are findings to review while preserving the intended scroll effect; they do not change the usual ok result.', readOnly: true }, {
    node_id: z.string().describe('The artboard or frame.'),
    widths: z.array(z.number().int().min(100).max(4000)).min(1).max(8).default([1440, 768, 390]),
    viewport_heights: z.array(z.number().int().min(100).max(1600)).min(2).max(4).optional().describe('Also compare geometry at these browser heights while keeping each artboard width fixed, e.g. [664, 760, 600]. Reveals mobile WebView toolbar risks, including svh sections resizing and sticky positioning switching. Reports measured changes, not a ban on sticky effects or a real-device scroll test.'),
    screenshots: z.boolean().default(false).describe(`Also return a picture per width, at most ${WIDTH_SHOT_DIMENSION}px on the long side.`),
    file_id: fileIdArg,
  }, async ({ node_id, widths, viewport_heights, screenshots, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const result = await responsiveReport(doc, ctx.app.renderer, { node_id, widths, viewport_heights, screenshots });
    ctx.touch([node_id]);
    return result;
  });

  define('a11y_audit', { description: 'Audit a page or a layer for accessibility, per layer with fixes: heading order (one h1, no level skipped), landmarks (one main, navs named when there are several), focusable elements without a name (links, buttons, fields, and fields named only by a placeholder), alt text (missing, a file name, or "image of"), link text that says nothing out of context ("click here", "learn more", "mehr"), targets under 24x24px, focus that is removed with nothing in its place or a :focus-visible ring under 3:1 against what is around it, and layers that move with no @media (prefers-reduced-motion: reduce) block. Each issue names its WCAG 2.2 success criterion. Safe fixes change nothing for anyone who did not ask: a ring in :focus-visible, a reduced-motion block that stops motion, an alt without "image of", a field named by its placeholder, a board made a main element. fix true applies those as one undo step and audits again. Run it before you call a page finished, with design_lint for text contrast. The saved check builtin:a11y runs the same.' }, {
    node_id: z.string().optional().describe('Audit this layer and everything inside. Leave out for the whole page.'),
    page_id: pageIdArg,
    fix: z.boolean().default(false).describe('Apply the safe fixes as one undo step, then audit again.'),
    file_id: fileIdArg,
  }, async ({ node_id, page_id, fix, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    if (node_id && !doc.getNode(node_id)) throw new Error(`No layer with id ${node_id}. Call layer_tree to see what exists.`);
    const scope = node_id ? { nodeId: node_id } : { pageId: ctx.page(room, page_id) };
    if (node_id) ctx.touch([node_id]);
    let report = await auditA11y(doc, ctx.app.renderer, scope);
    if (!fix) return report;
    const safe = report.layers.flatMap((l) => l.issues).filter((i) => i.fix?.safe);
    let fixed: ReturnType<typeof applyA11yFixes> = [];
    if (safe.length) {
      assertUnlocked(doc, []);
      fixed = ctx.write(room, () => applyA11yFixes(doc, safe, `agent:${ctx.agent}`));
      ctx.touch([...new Set(fixed.map((f) => f.node_id))]);
      report = await auditA11y(doc, ctx.app.renderer, scope);
    }
    return { ...report, fixed };
  });

  define('tokens_export', { description: 'The file\'s tokens as code, for you to write into the repository with your own file tools. No tool writes into a repository. css gives a :root block, then one block per theme mode, then the text styles as classes. tailwind gives that plus a Tailwind 4 @theme inline block that maps the utilities onto the same variables, so class names and var(--name) agree. tailwind3 gives the :root block plus a theme.extend object. design-md gives a DESIGN.md (YAML tokens up front, prose below, the open format other agents read): colours, radii and spacing by name, text styles as typography, theme modes and other kinds under x-bogen, and the prose of the brand the file links to; write it next to the code as DESIGN.md, and design_md_import reads one back. Use it to keep a repo in step with a design; tokens_from_css goes the other way. With a linked project, tokens_repo_diff shows what differs from the repository first.', readOnly: true }, {
    format: z.enum(['css', 'tailwind', 'tailwind3', 'design-md']).default('css'),
    selector: z.string().regex(/^[\w\s.:#\-[\]="']{1,80}$/).default(':root').describe('For css: the selector, such as .dark.'),
    mode_selector: z.string().regex(/^[\w\s.:#\-[\]="'{}]{1,80}$/).optional().describe('Where a theme mode\'s values go, with {mode} for its name, such as .{mode}. Default [data-mode="{mode}"].'),
    file_id: fileIdArg,
  }, async ({ format, selector, mode_selector, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const tokens = doc.getTokens();
    if (format === 'design-md') return fileDesignMd(ctx, doc, ctx.app.storage.get(room.id)?.name ?? 'Design');
    if (!tokens.length) return '/* This file has no tokens yet. Add them with tokens_set or tokens_from_css. */';
    const modes = getModes(doc);
    const modeSelector = mode_selector ? (m: string) => mode_selector.replaceAll('{mode}', m) : undefined;
    const classes = textStylesCss(getTextStyles(doc), '', true);
    const withClasses = (css: string) => (classes ? `${css}\n\n${classes}` : css);
    if (format === 'tailwind') return withClasses(exportTailwind(tokens, modes, modeSelector));
    if (format === 'tailwind3') return withClasses(exportTailwind3(tokens, modes, modeSelector));
    return withClasses(exportCss(tokens, selector, modes, modeSelector));
  });
}
