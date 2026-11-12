import {
  autoGrid, blockKey, WEB_PAGE_ATTR, designReview, fluidScale, focusOrder, fontAudit, importHtml, keyframesName, mediaToContainerPlan, resolveInstanceRefs, setTextStyle, stressCopy,
  type BogenDoc, type NewNode,
} from '@bogen/core';
import { z } from 'zod';
import { GOOGLE_FONTS } from '../google-fonts.ts';
import { findSection, SECTIONS } from '../templates/web-sections.ts';
import { checkWidths } from '../width-check.ts';
import { assertUnlocked, fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';

/** Web craft: fluid type and space, grids and containers that adapt, and the checks a designer runs before shipping. */

const pair = z.tuple([z.number().min(1).max(400), z.number().min(1).max(400)]);
const REDUCED = '@media (prefers-reduced-motion: reduce)';

/** Motion presets with the timing that reads as deliberate: short, ease-out, with a still alternative. */
const PRESETS = {
  rise: { frames: 'from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}', duration: 420, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
  fade: { frames: 'from{opacity:0}to{opacity:1}', duration: 260, easing: 'ease-out' },
  'scale-in': { frames: 'from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:none}', duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
  'slide-in': { frames: 'from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:none}', duration: 360, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
} as const;

function keyframes(doc: BogenDoc): string[] {
  const kf = doc.meta.get('keyframes');
  return Array.isArray(kf) ? kf.filter((k): k is string => typeof k === 'string') : [];
}

function pageRoots(doc: BogenDoc, pageId: string): string[] {
  return doc.getChildren(pageId).filter((n) => !n.hidden).map((n) => n.id);
}

export function registerWebTools(define: ToolDefiner): void {
  define('section_list', { description: 'Website sections that behave like a website in the canvas, the preview and an export: header with a navigation that folds into a popover menu by its own width, editorial hero, proof with sources, an accordion that keeps one answer open, a popover dialog, and a footer. All native HTML (popover, <details name>, anchors with ids), keyboard-ready, fluid with the type_scale_set tokens. Insert with section_insert.', readOnly: true }, {}, () => ({
    sections: SECTIONS.map((s) => ({ kind: s.kind, name: s.name, description: s.description, facts: s.facts })),
  }));

  define('web_page_set', { description: 'Say whether an artboard is a web page. A web page\'s export (HTML file, React, Tailwind) is as wide as the window, up to the artboard\'s width, with min-height instead of a fixed height, so its grids and queries meet real widths. Every other artboard, such as an app screen, a poster or a slide, exports at the size it was designed. section_insert marks its artboard by itself.' }, {
    node_id: z.string().describe('The artboard.'),
    web: z.boolean().default(true),
    file_id: fileIdArg,
  }, async ({ node_id, web, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const node = room.doc.getNode(node_id);
    if (!node?.artboard) throw new Error(`${node_id} is not an artboard.`);
    assertUnlocked(room.doc, [node_id]);
    const attrs = { ...(node.attrs ?? {}) };
    if (web) attrs[WEB_PAGE_ATTR] = 'page';
    else delete attrs[WEB_PAGE_ATTR];
    ctx.write(room, () => room.doc.updateFields(node_id, { attrs }));
    return { node_id, web };
  });

  define('section_insert', { description: 'Insert one website section from section_list into an artboard or frame, as editable layers. Its colours, type and space use tokens with fallbacks (--ink, --paper, --muted, --line, --accent, --type-*, --space-*), so it takes on the file\'s tokens; run type_scale_set first for the fluid scale. Its copy is a worked example: replace every layer listed in facts with the person\'s real words before calling the page done. Ids it carries (#top, #work, #studio, #questions, site-menu) are what its links and buttons point at: keep them unique on the page.' }, {
    kind: z.enum(['header', 'hero', 'proof', 'accordion', 'dialog', 'footer']),
    into: z.string().describe('The artboard or frame to add it to.'),
    index: z.number().int().min(0).optional().describe('Position among its children. Default: at the end.'),
    file_id: fileIdArg,
  }, async ({ kind, into, index, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    if (!doc.getNode(into)) throw new Error(`No layer with id ${into}.`);
    assertUnlocked(doc, [into]);
    const section = findSection(kind);
    const imported = importHtml(section.html);
    if (imported.droppedRules.length) throw new Error(`Internal: the ${kind} section has rules a layer cannot hold: ${imported.droppedRules.join('; ')}`);
    // Ids are anchors and popover targets: two of the same on a page would make links and buttons reach the wrong one.
    const taken = new Set([...doc.descendants(doc.ancestors(into).at(-1) ?? into)].map((n) => n.attrs?.id).filter(Boolean));
    const clash = [...section.html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]!).filter((id) => taken.has(id));
    if (clash.length) throw new Error(`This artboard already has ${clash.map((c) => `#${c}`).join(', ')}. Insert this section into another artboard, or rename the existing ids with layer_attrs first.`);
    const top = doc.getNode(doc.ancestors(into).at(-1) ?? into);
    const ids = ctx.write(room, () => {
      resolveInstanceRefs(doc, imported.nodes as NewNode[]);
      // Sections make a web page: its export grows with the window. An app screen or a poster is never marked.
      if (top?.artboard && top.attrs?.[WEB_PAGE_ATTR] !== 'page') doc.updateFields(top.id, { attrs: { ...(top.attrs ?? {}), [WEB_PAGE_ATTR]: 'page' } });
      return doc.insertMany(into, imported.nodes as NewNode[], index);
    });
    ctx.touch(ids);
    return { kind, ids, facts: section.facts, hint: 'Replace the facts layers with the person\'s real words, then run focus_order and responsive_check on the artboard.' };
  });

  define('type_scale_set', { description: 'Give a website one fluid type and spacing scale instead of per-breakpoint sizes: font-size tokens --type-display, --type-h1 … --type-small and --space-3xs … --space-3xl as clamp() in rem, growing from the small to the large viewport, plus line-height and tracking tokens and text styles (Display, H1, H2, H3, Lead, Body, Small) that use them. Every breakpoint and every component follows a token change, and the export writes the same clamp(). Apply the styles with text_style_apply, and use var(--space-…) for padding and gaps. Returns the px each role has at the small and large viewport.' }, {
    body: pair.optional().describe('Body size at the small and large viewport, px. Default [16, 18].'),
    ratio: z.tuple([z.number().min(1.05).max(1.8), z.number().min(1.05).max(1.8)]).optional().describe('Step ratio at the small and large viewport. Default [1.2, 1.25]; editorial pages often want [1.2, 1.333].'),
    viewport: z.tuple([z.number().int().min(240).max(1200), z.number().int().min(600).max(2560)]).optional().describe('Viewport range in px. Default [360, 1280].'),
    space: pair.optional().describe('Spacing base at the small and large viewport, px. Default [16, 20].'),
    text_styles: z.boolean().default(true).describe('Also create or update the text styles.'),
    file_id: fileIdArg,
  }, async ({ body, ratio, viewport, space, text_styles, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const scale = fluidScale({ ...(body ? { body } : {}), ...(ratio ? { ratio } : {}), ...(viewport ? { viewport } : {}), ...(space ? { space } : {}) });
    const styles: string[] = [];
    ctx.write(room, () => {
      for (const t of scale.tokens) room.doc.setToken(t.name, t.kind, t.value);
      if (text_styles) for (const s of scale.styles) styles.push(setTextStyle(room.doc, s.name, s.style));
    });
    return { tokens: scale.tokens.map((t) => `--${t.name}: ${t.value}`), text_styles: styles, px: scale.at, hint: 'Apply with text_style_apply; replace @media font sizes with these tokens.' };
  });

  define('grid_set', { description: 'Make a layer a grid that fits as many columns as there is room for, each at least min wide, without a breakpoint and without overflowing a phone: repeat(auto-fit, minmax(min(min, 100%), 1fr)). Canvas, preview and export lay it out the same, because it is plain CSS. mode fill keeps empty tracks so items keep their size; fit stretches the items across.' }, {
    node_id: z.string(),
    min: z.string().regex(/^\d+(\.\d+)?(px|rem|em|ch)$/).describe('Smallest column, such as 16rem or 280px.'),
    gap: z.string().max(80).default('var(--space-m, 1.5rem)').describe('Gap between cells: a length or a token.'),
    mode: z.enum(['fit', 'fill']).default('fit'),
    file_id: fileIdArg,
  }, async ({ node_id, min, gap, mode, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    assertUnlocked(room.doc, [node_id]);
    const style = autoGrid(min, gap, mode);
    ctx.write(room, () => room.doc.updateStyle(node_id, { ...style, gridTemplateRows: null, flexDirection: null, flexWrap: null }));
    ctx.touch([node_id]);
    return { node_id, style };
  });

  define('container_queries', { description: 'Make a component respond to the width it is given rather than the page\'s. A container query reaches only the container\'s descendants, so the component\'s parent (the slot it sits in) becomes the named inline-size container, and each plain @media width block on the component and inside it becomes an @container block on that name, with the breakpoint scaled by how wide the slot is in the page it was designed in. So the same card stacks in a narrow sidebar and stays a row in a wide column. Blocks that are not plain width queries are left and listed. Check the result with responsive_check.' }, {
    node_id: z.string().describe('The component: a frame, a main component or a card.'),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).describe('The container name, such as card.'),
    page_width: z.number().int().min(200).max(4000).optional().describe('The width the media queries were written for. Default: the artboard\'s width.'),
    component_width: z.number().int().min(100).max(4000).optional().describe('The width of the slot the component sits in, in that design. Default: the parent\'s fixed width, else the component\'s, else the page width.'),
    file_id: fileIdArg,
  }, async ({ node_id, name, page_width, component_width, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const node = doc.getNode(node_id);
    if (!node) throw new Error(`No layer with id ${node_id}.`);
    assertUnlocked(doc, [node_id]);
    const top = doc.getNode(doc.ancestors(node_id).at(-1) ?? node_id)!;
    const pagePx = page_width ?? (Number.parseFloat(top.style.width ?? '') || 1440);
    const parent = doc.getNode(node.parent);
    const compPx = component_width ?? (Number.parseFloat(parent?.style.width ?? '') || Number.parseFloat(node.style.width ?? '') || pagePx);
    const plan = mediaToContainerPlan(doc, node_id, name, compPx, pagePx);
    assertUnlocked(doc, [plan.containerId]);
    ctx.write(room, () => {
      doc.updateStyle(plan.containerId, plan.containerStyle);
      for (const c of plan.changes) {
        const props = doc.getNode(c.id)?.rules?.[c.from];
        if (!props) continue;
        doc.updateRules(c.id, c.to, props);
        doc.deleteRules(c.id, c.from);
      }
    });
    ctx.touch([node_id, plan.containerId]);
    return { container: name, container_layer: plan.containerId, ratio: Math.round((compPx / pagePx) * 1000) / 1000, changed: plan.changes, ...(plan.skipped.length ? { skipped: plan.skipped } : {}) };
  });

  define('font_audit', { description: 'Check the fonts a page or layer really uses against what can be shown: uploaded and captured faces exactly, Google families as Bogen loads them (weights 100–900, italics only at 400 and 700). Reports synthesized bold and italic, families nothing provides, stacks without a generic fallback, and more families or weights than read well, each with its layers.', readOnly: true }, {
    node_id: z.string().optional().describe('A layer. Default: the whole page.'),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ node_id, page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const roots = node_id ? [node_id] : pageRoots(room.doc, ctx.page(room, page_id));
    return fontAudit(room.doc, roots, { google: new Set(GOOGLE_FONTS) });
  });

  define('focus_order', { description: 'The order a keyboard moves through an artboard or layer: each link, button, field, disclosure and popover trigger with its accessible name, and what breaks the order or the names: positive tabindex, reversed rows, order, links without href, unnamed buttons, tabindex without a role, popovertarget or label for pointing at nothing. Static, from the layers; complements a11y_audit and responsive_check.', readOnly: true }, {
    node_id: z.string(),
    file_id: fileIdArg,
  }, async ({ node_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const out = focusOrder(room.doc, node_id);
    return { count: out.stops.length, order: out.stops.map((s, i) => ({ n: i + 1, ...s })), issues: out.issues, ...(Object.keys(out.popovers).length ? { inside_popovers: out.popovers } : {}), note: 'Layers hidden at this width (display: none) are left out; check other widths after responsive_check.' };
  });

  define('design_review', { description: `Measurements to judge a page by before calling it done, as observations with numbers and layer ids: heading sizes and whether the levels step down, how many sizes there are, line length and leading of running text, spacing off the scale, colours typed in instead of tokens, and the patterns that make pages look generated (identical icon cards in a row, a small label over every heading, everything centred, gradients everywhere, emoji, placeholder copy, exclamation marks), plus the craft checks of design_lint with their rule id. It reads the layers and needs no render, so it also works where no browser can start. These are not rules to obey: weigh each against what the page is for and its brand, fix what makes it worse, and say what you kept on purpose. Run design_lint and a11y_audit too.`, readOnly: true }, {
    node_id: z.string(),
    viewport_width: z.number().int().min(240).max(4000).default(1440).describe('The width clamp() sizes are read at.'),
    file_id: fileIdArg,
  }, async ({ node_id, viewport_width, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return designReview(room.doc, node_id, viewport_width);
  });

  define('content_stress', { description: 'Preview an artboard with harder content, without changing it: every text longer (1.6 is about English to German), an unbreakable long word, images that fail to load, lists with one item or twice as many. Renders the stressed copy at each width and reports what then sticks out or gets cut off, with layer ids that are the same in the original. The original file is never written.', readOnly: true }, {
    node_id: z.string(),
    text_factor: z.number().min(1).max(4).default(1.6),
    long_words: z.boolean().default(true),
    missing_images: z.boolean().default(true),
    items: z.enum(['as-is', 'empty', 'full']).default('as-is').describe('Repeated rows: one item, twice as many, or as they are.'),
    widths: z.array(z.number().int().min(240).max(4000)).min(1).max(4).default([1440, 390]),
    file_id: fileIdArg,
  }, async ({ node_id, text_factor, long_words, missing_images, items, widths, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (!room.doc.getNode(node_id)) throw new Error(`No layer with id ${node_id}.`);
    const stressed = stressCopy(room.doc, node_id, { textFactor: text_factor, longWords: long_words, missingImages: missing_images, ...(items !== 'as-is' ? { emptyAndFull: items } : {}) });
    try {
      const check = await checkWidths(stressed.doc, ctx.app.renderer, node_id, widths);
      return { stressed_layers: stressed.changed, widths: check };
    } finally {
      stressed.doc.y.destroy();
    }
  });

  define('motion_preset', { description: 'Give layers an entrance or press motion with timing that feels deliberate rather than floaty: rise, fade, scale-in or slide-in (220–420 ms, strong ease-out, optional stagger), or press (a 120 ms scale on :active for buttons). Each also gets a prefers-reduced-motion block that removes the movement, so the preview and the export respect the setting.' }, {
    node_ids: z.array(z.string()).min(1).max(24),
    preset: z.enum(['rise', 'fade', 'scale-in', 'slide-in', 'press']),
    stagger_ms: z.number().int().min(0).max(200).default(0).describe('Delay added per layer, in the order given.'),
    file_id: fileIdArg,
  }, async ({ node_ids, preset, stagger_ms, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    assertUnlocked(doc, node_ids);
    const reduced = blockKey(REDUCED, undefined);
    const active = blockKey(':active', undefined);
    if ('error' in reduced || 'error' in active) throw new Error('Internal: motion blocks could not be keyed.');
    ctx.write(room, () => {
      if (preset === 'press') {
        for (const id of node_ids) {
          doc.updateStyle(id, { transition: 'transform 120ms cubic-bezier(0.23, 1, 0.32, 1)' });
          doc.updateRules(id, active.key, { transform: 'scale(0.97)' });
          doc.updateRules(id, reduced.key, { transition: 'none', transform: 'none' });
        }
        return;
      }
      const p = PRESETS[preset];
      const name = `bogen-${preset}`;
      const others = keyframes(doc).filter((k) => keyframesName(k) !== name);
      doc.meta.set('keyframes', [...others, `@keyframes ${name}{${p.frames}}`]);
      node_ids.forEach((id, i) => {
        doc.updateStyle(id, { animation: `${name} ${p.duration}ms ${p.easing} ${i * stagger_ms}ms both` });
        doc.updateRules(id, reduced.key, { animation: 'none' });
      });
    });
    ctx.touch(node_ids);
    return { preset, layers: node_ids.length, reduced_motion: REDUCED };
  });
}
