import { z } from 'zod';
import { allKits } from '../kits/index.ts';
import { runTemplate, TEMPLATE_IDS, templateList } from '../templates/index.ts';
import { type ToolDefiner } from './kit.ts';

export function registerTemplateTools(define: ToolDefiner): void {
  define('template_list', { description: 'Editable whole-file templates built from a linked brand, with parts, content slots and a discipline-specific review profile. Includes brand guidelines, pages, email, decks, app task states, desktop workspaces, analytics, checkout/recovery, social carousels, portrait stories, case studies and one-page pitches; examples bring their own brand. Read design_knowledge for Bogen-authored decision playbooks and composition recipes. This is a starting structure to refine, not a finished design or a functioning app. Component kits use kit_use.', readOnly: true }, {}, () => ({
    templates: templateList(),
    kits: allKits().map((k) => ({ id: k.id, name: k.name, platform: k.platform, library: k.library.name, components: k.components.length })),
    next: 'template_use with a template id and the brand. Then look at the boards with canvas_screenshot and refine them with the usual tools. For a component kit, kit_use with its id.',
  }));

  define('template_use', { description: `Lay out a template from a brand's data as ordinary editable layers: artboards side by side on a page of their own, real flex and grid, the brand's tokens as var(--name), its fonts, logos and type scale, and components (such as a Button set with variants) where something repeats. Use it first when asked for a brand system, guideline, brand book, landing page, social images, pitch deck, store screenshots, an email, a docs page or a pricing page for a brand, then refine what it made: it is a start, not a finish. Texts are the brand's own lines where they fit, else short slots that say what to write; slots lists them with layer ids and hints, so fill those with layer_text, using only what the person or the brand says (never invent prices, figures or names). It never invents brand values: where the brand has a gap, the board shows one quiet line saying how to fill it, and gaps lists them. One undo step. An example (an id that starts with example-) is a finished design to start from or to learn from: it makes its own brand with the brand tools (or reuses the one it made before) and a new file linked to it, so brand_id does not apply. Templates: ${TEMPLATE_IDS.join(', ')} (template_list describes them).` }, {
    template: z.enum(TEMPLATE_IDS),
    brand_id: z.string().optional().describe('The brand. Defaults to the brand the file links to, then the default brand.'),
    file_id: z.string().optional().describe('A design file to add the boards to, on a new page. Leave out for a new file named after the brand, which is usual for a brand system.'),
    page_id: z.string().optional().describe('Put the boards on this page of file_id, to the right of what is there.'),
    options: z.object({
      only: z.array(z.string()).max(20).optional().describe('Make only these parts, by key from template_list, such as ["colour","type"] or ["390"].'),
    }).optional(),
  }, async ({ template, brand_id, file_id, page_id, options }, ctx) => {
    if (page_id && !file_id) throw new Error('page_id needs file_id: pass the file the page belongs to, or leave page_id out and the template gets a page of its own.');
    const out = await runTemplate(ctx.app, { template, ...(brand_id ? { brandId: brand_id } : {}), ...(file_id ? { fileId: file_id } : {}), ...(page_id ? { pageId: page_id } : {}), ...(options ? { options } : {}), actor: ctx.agent, origin: `agent:${ctx.agent}` });
    // The new or chosen file becomes this session's, so the next calls refine what was just made.
    const room = await ctx.room(out.file_id);
    ctx.page(room, out.page_id);
    ctx.wrote = true;
    ctx.touch(out.boards.map((b) => b.id));
    return {
      ...out,
      ...(out.linked ? { note: 'The file was not linked to a brand, so it is now linked to this one: its tokens and fonts are in the file.' } : {}),
      next: 'Read the design discipline’s rules with design_knowledge. Look at each board with canvas_screenshot. Refine with html_write mode replace, layer_style and layer_text, fill the gaps in the brand rather than on the canvas, and run brand_check plus design_verify after the last edit before you call it done. Layers inside data-brand-example="dont" frames are deliberate wrong examples, left out of brand_check and the design checks; "specimen" frames document parts and are spared only the rules about composing one screen.',
    };
  });
}
