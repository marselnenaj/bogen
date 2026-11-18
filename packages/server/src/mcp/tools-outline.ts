import { sanitizeSvgMarkup, type NewNode } from '@bogen/core';
import { z } from 'zod';
import { firstFamilyOf, fontFor, outlineText, parseFont, publicFetch, px, type OutlineStyle } from '../text-outline.ts';
import { assertUnlocked, fileIdArg, type ToolDefiner } from './kit.ts';

const PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-align', 'text-transform', 'font-kerning', 'color', 'white-space'];

/** Text to vector outlines: wordmarks, and display lines that must look the same without the font. */
export function registerOutlineTools(define: ToolDefiner): void {
  define('text_outline', { description: 'Turn a text layer into vector outlines: an svg layer drawn from the very font file the canvas uses (stored in the file, made with font_build, brought by its brand, or else from Google Fonts), with its kerning, letter-spacing, line height, alignment and text-transform. The path fills with currentColor and the layer keeps the text\'s color, so a colour token still applies. Use it for a wordmark: set the name in the brand\'s display face, tune tracking and kerning on the text layer first (layer_style letter-spacing, font-kerning), then outline it and add the svg to the brand with brand_asset_add kind logo. bounds ink crops to the drawn letters, as a logo wants for its clear space; text keeps the line boxes. Line breaks are those in the text; a text that wraps by width is outlined as its lines, so put the breaks in first. The outline keeps the text as its aria-label.' }, {
    node_id: z.string().describe('The text layer.'),
    bounds: z.enum(['ink', 'text']).default('ink'),
    replace: z.boolean().default(false).describe('Put the outline in place of the text, which is deleted (agent_undo brings it back). Otherwise it goes beside it.'),
    name: z.string().min(1).max(200).optional(),
    file_id: fileIdArg,
  }, async ({ node_id, bounds, replace, name, file_id }, ctx) => {
    if (ctx.dryRun) throw new Error('text_outline reads the font file, so it does not run in a dry run.');
    const room = await ctx.room(file_id);
    const { doc } = room;
    const node = doc.getNode(node_id);
    if (!node) throw new Error(`No layer with id ${node_id}. Call layer_tree to see what exists.`);
    if (node.type !== 'text' || !(node.text ?? '').trim()) throw new Error(`${node.name} is not a text layer with text. Pass a text layer: layer_find with type "text" lists them.`);
    assertUnlocked(doc, [node_id]);
    if (node.spans?.some((s) => s.style && Object.keys(s.style).some((k) => /^font|letterSpacing/.test(k)))) {
      throw new Error(`${node.name} has parts in other fonts or sizes. Outline a text in one style, or split it into one layer per style first.`);
    }
    const computed = (await ctx.app.renderer.computed(doc, [node_id], PROPS))[node_id];
    if (!computed) throw new Error(`${node.name} could not be measured. Is it on a page and visible?`);
    const s = computed.style;
    const fontSize = px(s['font-size']) ?? 16;
    const weightRaw = (s['font-weight'] ?? '400').trim();
    const weight = /^\d+$/.test(weightRaw) ? Number(weightRaw) : weightRaw === 'bold' ? 700 : 400;
    const style: OutlineStyle = {
      family: firstFamilyOf(s['font-family'] ?? ''),
      fontSize,
      weight,
      italic: /italic|oblique/.test(s['font-style'] ?? ''),
      letterSpacing: px(s['letter-spacing']) ?? 0,
      lineHeight: px(s['line-height']),
      align: (s['text-align'] ?? '').includes('center') ? 'center' : /right|end/.test(s['text-align'] ?? '') ? 'right' : 'left',
      transform: (['uppercase', 'lowercase', 'capitalize'] as const).find((t) => s['text-transform'] === t) ?? 'none',
      kerning: s['font-kerning'] !== 'none',
    };
    if (!style.family) throw new Error(`${node.name} has no font family to outline.`);
    const text = node.text!;
    const font = await fontFor(doc, { storage: ctx.app.storage, fetch: publicFetch }, style.family, style.weight, style.italic, text);
    const outline = outlineText(await parseFont(font.bytes), text, style, bounds);
    const notes: string[] = [];
    if (outline.missing.length) notes.push(`The font has no glyph for ${outline.missing.map((c) => `"${c}"`).join(', ')}; those show as the font's empty glyph.`);
    if (outline.lines === 1 && computed.box.width && outline.width > computed.box.width * 1.02 && !/nowrap|pre/.test(s['white-space'] ?? '')) {
      notes.push(`On the canvas the text wraps (its box is ${Math.round(computed.box.width)}px wide, the line ${Math.round(outline.width)}px); the outline is one line. Put the line breaks into the text first if it should wrap.`);
    }
    const layerStyle: Record<string, string> = { width: `${outline.width}px`, height: `${outline.height}px`, flexShrink: '0', color: node.style.color ?? s.color ?? 'currentColor' };
    if (node.style.position === 'absolute') {
      layerStyle.position = 'absolute';
      if (node.style.top) layerStyle.top = node.style.top;
      const left = /^(-?[\d.]+)px$/.exec(node.style.left ?? '')?.[1];
      layerStyle.left = left !== undefined && !replace ? `${Number(left) + Math.max(computed.box.width, outline.width) + 24}px` : node.style.left ?? '0px';
    }
    const spec: NewNode = { type: 'svg', tag: 'svg', name: name ?? `${node.name} (outlines)`, svg: sanitizeSvgMarkup(outline.svg), style: layerStyle, attrs: { role: 'img', 'aria-label': text.replace(/\s+/g, ' ').trim() } };
    const id = ctx.write(room, () => {
      const siblings = doc.getChildren(node.parent);
      const at = siblings.findIndex((x) => x.id === node_id);
      const made = doc.insert(node.parent, spec, replace ? at : at + 1);
      if (replace) doc.delete([node_id]);
      return made;
    });
    ctx.touch([id]);
    return {
      id, name: spec.name, width: outline.width, height: outline.height, lines: outline.lines, font: font.source,
      ...(notes.length ? { notes } : {}),
      next: 'Look at it with canvas_screenshot beside the text. For a logo, add the svg layer\'s markup to the brand with brand_asset_add (kind logo) and give it its minimum width and clear space.',
    };
  });
}
