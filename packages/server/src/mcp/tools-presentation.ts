import {
  MOCKUP_ATTR, PATTERN_ATTR, brandVersions, keyframesName, meshAspect, normalizeColor, brandVersionHead, createComponent, listMains, mockupChildren, sceneById,
  type BogenDoc, type MockupConfig, type Point,
} from '@bogen/core';
import { z } from 'zod';
import { checkRendered } from '../brand-check.ts';
import { decodePng, downscale } from '../image-raster.ts';
import { presentationCheck } from '../presentation-check.ts';
import { buildBrandSite } from '../templates/brand-site.ts';
import { BOARD_LAYOUTS, SLIDE_ATTR, buildBook, buildReveal, type BrandStory, type PresentationPlan } from '../templates/brand-presentation.ts';
import { writeBoards } from '../templates/index.ts';
import type { TemplateEnv } from '../templates/kit.ts';
import { fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';
import { autoFit } from './tools-mockup.ts';
import { treatPhotoWithPreset } from './tools-treatment.ts';

const line = z.string().min(1).max(400);
const storyArg = z.object({
  date: z.string().max(60).optional(),
  started_from: line.optional().describe('One line on where the brand stood before.'),
  old_logo: z.string().optional().describe('The mark before, a bogen-asset src.'),
  insight: line.optional().describe('The one truth about the audience the brand answers.'),
  idea: z.string().min(1).max(80).optional().describe('The idea in two to six words.'),
  idea_line: line.optional(),
  rationale: z.object(Object.fromEntries(['logo', 'logo_story', 'colour', 'type', 'device', 'photography', 'voice', 'motion', 'applications'].map((k) => [k, line.optional()]))).partial().optional().describe('One line each on why the brand is so. Every identity slide shows one; voice_check runs over them.'),
  display_lines: z.array(line).max(6).optional().describe('Display lines in the brand\'s voice for the specimen and posters.'),
  hero_colour: z.string().max(80).optional().describe('The colour that carries the brand: token, name or role.'),
  photos: z.array(z.string()).max(8).optional().describe('Photos of the brand\'s world, bogen-asset srcs (asset_upload): one treatment and crop for all.'),
  photo_treatment: z.enum(['duotone', 'mono', 'none']).optional(),
  photo_preset: z.string().max(200).optional().describe('An image treatment saved in the brand (image_treatment with save_preset): every photo is given it first, as the brand\'s own look. photo_treatment is then not applied on top.'),
  photo_crop: z.enum(['1:1', '4:5', '3:2', '16:9']).optional(),
  photo_rule: line.optional().describe('What the pictures show and why, tied to the subject, and what they never show.'),
  voice: z.object({ principles: z.array(z.object({ name: z.string().max(60), line })).max(3).optional(), in_voice: line.optional(), out_of_voice: line.optional() }).optional(),
  motion_rule: line.optional(),
  social: z.object({ posts: z.array(z.object({ headline: line, caption: line, layout: z.enum(BOARD_LAYOUTS).optional().describe('The form of this post. Left out, one is picked so neighbours differ.') })).max(9).optional(), stories: z.array(line).max(3).optional() }).optional(),
  numbers: z.array(z.object({ value: z.string().min(1).max(8).regex(/^[0-9.,%+\-kh ]+$/i), line })).max(4).optional().describe('The one number that matters, drawn in the device\'s cells, with its line: real figures only.'),
  quotes: z.array(z.object({ text: line, by: z.string().min(1).max(80) })).max(4).optional().describe('People in their own words, with who said it. Real quotes only.'),
  facts: z.array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(60) })).max(4).optional().describe('Facts of the product for a board of details, such as a packet\'s variety and sowing depth.'),
  app: z.object({ name: z.string().max(80).optional(), screens: z.array(z.string()).max(3).optional().describe('Ids of app screen artboards, shown on phones.') }).optional(),
  campaign_lines: z.array(line).max(4).optional(),
  contact: z.object({ name: z.string().max(80).optional(), role: z.string().max(80).optional(), email: z.string().max(120).optional(), phone: z.string().max(60).optional(), address: z.string().max(200).optional(), web: z.string().max(120).optional() }).optional().describe('Real details only, from the person.'),
  email: z.object({ subject: line, headline: line, body: z.string().max(800), action: z.string().max(60) }).optional(),
  sign_line: line.optional(),
  hero_scene: z.enum(['billboard', 'poster-wall', 'hanging-sign']).optional(),
  proof_points: z.array(line).max(3).optional(),
  next_steps: z.array(z.object({ when: z.string().max(60), what: line })).max(6).optional(),
  close: line.optional(),
});

const scaleMesh = (m: { top: Point[]; bottom: Point[] }, s: number) => ({ top: m.top.map(([x, y]) => [x * s, y * s] as Point), bottom: m.bottom.map(([x, y]) => [x * s, y * s] as Point) });

/** Makes the application boards components, then fills each placeholder with a scaled instance or a mockup. */
function realize(doc: BogenDoc, pageId: string, plan: PresentationPlan, ids: string[]): void {
  const byName = new Map(ids.map((id, i) => [plan.boards[i]!.name, id]));
  for (const app of plan.apps) {
    const id = byName.get(app);
    if (id && !doc.source.raw(id)?.component) createComponent(doc, id, { description: 'An application of the brand. The presentation shows it; change it here.' });
  }
  doc.invalidate();
  const under = new Map<string, string>();
  for (const id of ids) for (const n of doc.descendants(id)) if (!n.virtual) under.set(n.name, n.id);
  for (const pl of plan.placements) {
    const holder = under.get(pl.layer);
    const sourceId = byName.get(pl.board) ?? (doc.getNode(pl.board) ? pl.board : undefined);
    const source = sourceId ? doc.getNode(sourceId) : null;
    if (!holder || !source) continue;
    if (!source.component && !source.instanceOf) createComponent(doc, source.id, { description: 'Shown in the brand presentation.' });
    const box = doc.getNode(holder)!;
    const w = Number(/^([\d.]+)px$/.exec(box.style.width ?? '')?.[1] ?? 400);
    const sw = Number(/^([\d.]+)px$/.exec(source.style.width ?? '')?.[1] ?? w);
    const sh = Number(/^([\d.]+)px$/.exec(source.style.height ?? '')?.[1] ?? w);
    const main = source.instanceOf ?? source.id;
    const scene = pl.scene ? sceneById(pl.scene) : null;
    if (scene) {
      const k = w / scene.width;
      const config: MockupConfig = { source: main, sourceWidth: sw, sourceHeight: sh, scene: scene.id, width: w, height: Math.round(scene.height * k), mesh: scaleMesh(scene.mesh, k), blend: scene.blend, shading: scene.shading, fit: autoFit(sw / sh, meshAspect(scene.mesh)), ...(source.style.backgroundColor ? { ground: source.style.backgroundColor } : {}) };
      doc.updateStyle(holder, { height: `${config.height}px`, isolation: 'isolate' });
      doc.updateFields(holder, { tag: 'figure', attrs: { [MOCKUP_ATTR]: JSON.stringify(config), role: 'img', 'aria-label': `${source.name} on ${scene.name.toLowerCase()}` } });
      doc.insertMany(holder, mockupChildren(config, scene));
    } else {
      const k = w / sw;
      doc.updateStyle(holder, { height: `${Math.round(sh * k)}px` });
      doc.insert(holder, { type: 'frame', instanceOf: main, name: source.name, style: { position: 'absolute', left: '0px', top: '0px', width: `${sw}px`, height: `${sh}px`, margin: '0px', transform: `scale(${Math.round(k * 10000) / 10000})`, transformOrigin: '0 0' } });
    }
  }
  for (const d of plan.devices) {
    const id = under.get(d.layer);
    const node = id ? doc.getNode(id) : null;
    if (node) doc.updateFields(node.id, { attrs: { ...(node.attrs ?? {}), [PATTERN_ATTR]: JSON.stringify(d.spec), role: 'img' } });
  }
  // The applications in a row of their own under the slides.
  const appIds = new Set(plan.apps.map((a) => byName.get(a)).filter(Boolean));
  let x = 0;
  const slidesBottom = Math.max(0, ...ids.filter((id) => !appIds.has(id)).map((id) => Number(/^([\d.]+)px$/.exec(doc.getNode(id)?.style.height ?? '')?.[1] ?? 0)));
  for (const id of ids) {
    if (!appIds.has(id)) continue;
    doc.updateStyle(id, { left: `${x}px`, top: `${slidesBottom + 400}px` });
    x += Number(/^([\d.]+)px$/.exec(doc.getNode(id)?.style.width ?? '')?.[1] ?? 1000) + 120;
  }
  void pageId;
}

async function env(ctx: ToolContext, doc: BogenDoc, brandId: string): Promise<TemplateEnv> {
  const brand = await ctx.app.brands.read(brandId);
  return {
    data: brand.data,
    tokens: new Set(doc.getTokens().map((t) => t.name)),
    components: new Set(listMains(doc.source).flatMap((m) => [m.name, m.component?.set ?? ''].filter(Boolean))),
    version: brandVersionHead(brand.room.doc)?.n ?? null,
    date: new Date(),
    provisional: new Set(((doc.meta.get('brandProvisionalTokens') as unknown[] | undefined) ?? []).filter((n): n is string => typeof n === 'string')),
    tokenValues: new Map(doc.getTokens().map((t) => [t.name, t.value])),
  };
}


/** How much of each brand colour the application boards really show, from their pixels; the rest is photos and mixes. */
async function measureShare(ctx: ToolContext, doc: BogenDoc, colors: { token: string; name: string; value: string }[], ids: string[]): Promise<{ token: string; name: string; hex: string; share: number }[]> {
  const inks = colors.map((c) => ({ ...c, hex: normalizeColor(c.value) })).filter((c): c is typeof c & { hex: string } => Boolean(c.hex) && c.hex!.length === 7);
  if (!inks.length || !ids.length) return [];
  const rgb = inks.map((c) => [1, 3, 5].map((i) => Number.parseInt(c.hex.slice(i, i + 2), 16)) as [number, number, number]);
  const counts = new Array<number>(inks.length).fill(0);
  let total = 0;
  for (const id of ids.slice(0, 24)) {
    const shot = await ctx.app.renderer.screenshot(doc, { nodeIds: [id] }, { format: 'png', maxDimension: 360 }).catch(() => null);
    if (!shot) continue;
    const img = downscale(decodePng(shot.bytes), 360 * 360);
    for (let p = 0; p < img.data.length; p += 4) {
      if (img.data[p + 3]! < 128) continue;
      total++;
      let best = -1;
      let dist = 42 * 42;
      for (let i = 0; i < rgb.length; i++) {
        const [r, g, b] = rgb[i]!;
        const d = (img.data[p]! - r) ** 2 + (img.data[p + 1]! - g) ** 2 + (img.data[p + 2]! - b) ** 2;
        if (d < dist) { dist = d; best = i; }
      }
      if (best >= 0) counts[best]!++;
    }
  }
  if (!total) return [];
  return inks.map((c, i) => ({ token: c.token, name: c.name, hex: c.hex, share: counts[i]! / total }));
}

const MOTION = { name: 'brand-cells-fill', duration: 420, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', stagger: 60 };

export function registerPresentationTools(define: ToolDefiner): void {
  define('brand_presentation', { description: 'Present a brand the way an agency reveals one, from the linked brand and a story you write: a 16:9 reveal deck with an arc (cover, where it started, insight, idea, identity: logo, logo story, logo system, colour, type, graphic device, photography, voice, motion; in the world: hero application, social feed and stories, product, out of home, print and email, things people carry, places, the system at scale; why it works, next steps, close), and a guidelines book (clear space and size, misuse made from the real logo, colour values with CMYK and every contrast pair, type scale, grid, the device rule). What follows from the brand is drawn from its data and looks finished on its own. What needs judgement comes from story: insight, idea, a reason per identity slide, display and campaign lines, photos with one treatment and crop, voice principles, social posts with captions, real contact details. A slide whose story is missing is left out and listed in skipped, never filled with a placeholder. Applications are boards of their own (components) that the slides show as tiles and mockups, so changing a poster changes every slide it is on. Ends with presentation_check. Then look at each slide with canvas_screenshot and refine.' }, {
    story: storyArg,
    output: z.enum(['both', 'deck', 'book']).default('both'),
    check_tiles: z.boolean().default(true).describe('Run brand_check on every application board and the system wall, and list each tile\'s score.'),
    page_name: z.string().min(1).max(120).optional().describe('The page for the deck. The book goes on a page of its own.'),
    file_id: fileIdArg,
  }, async ({ story, output, page_name, check_tiles, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const found = await ctx.app.brands.forRoom(room);
    if (!found?.data) throw new Error('This file is not linked to a brand. brand_link it first: the presentation is drawn from the brand.');
    const e = await env(ctx, doc, found.link.id);
    // A brand with an image treatment of its own gives every photo that look, unless the story picks another.
    const preset = story.photo_preset ?? (story.photo_treatment ? undefined : (found.data.treatments ?? []).find((x) => !x.suggested)?.name ?? (found.data.treatments ?? [])[0]?.name);
    if (preset && story.photos?.length) story = { ...story, photo_preset: preset };
    if (story.photo_preset && story.photos?.length) {
      const treated: string[] = [];
      for (const src of story.photos) treated.push(await treatPhotoWithPreset(ctx, doc, found.data, src, story.photo_preset));
      story = { ...story, photos: treated, photo_treatment: 'none' };
    }
    const plans = [...(output !== 'book' ? [buildReveal(e, story as BrandStory)] : []), ...(output !== 'deck' ? [buildBook(e, story as BrandStory)] : [])];
    room.undoManagerFor(ctx.agent);
    const results = ctx.write(room, () => plans.map((plan, i) => {
      const pageName = i === 0 && output !== 'book' ? page_name ?? plan.page : plan.page;
      const pageId = doc.createPage(pageName);
      const { ids } = writeBoards(doc, pageId, plan.boards);
      realize(doc, pageId, plan, ids);
      return { page_id: pageId, page: pageName, ids, plan };
    }));
    ctx.wrote = true;
    const out = results.map((r) => ({
      page_id: r.page_id, page: r.page,
      boards: r.ids.map((id, i) => ({ id, name: r.plan.boards[i]!.name })).filter((b) => !b.name.startsWith('App · ')).map((b) => `${b.id} ${b.name}`),
      applications: r.plan.apps.length,
      skipped: r.plan.skipped,
      gaps: [...new Set(r.plan.gaps)],
      check: presentationCheck(doc, r.page_id, found.data, r.plan.page === 'Brand guidelines' ? 'book' : 'deck'),
    }));
    ctx.touch(results.flatMap((r) => r.ids));
    // Every tile of the wall is a sample of the brand: check each one as it renders.
    const tiles: { board: string; id: string; score: number; hard: number; soft: number }[] = [];
    if (check_tiles) {
      for (const r of results) {
        for (const [i, id] of r.ids.entries()) {
          const board = r.plan.boards[i]!;
          if (!r.plan.apps.includes(board.name)) continue;
          try {
            const rep = await checkRendered(doc, found.data, ctx.app.renderer, { nodeId: id });
            tiles.push({ board: board.name, id, score: rep.score.value, hard: rep.counts.hard, soft: rep.counts.soft });
          } catch { /* a render that fails is reported by the next brand_check */ }
        }
      }
    }
    return { file_id: room.id, outputs: out, ...(tiles.length ? { tiles, lowest: tiles.slice().sort((a, b) => a.score - b.score).slice(0, 3).map((x) => `${x.board} ${x.score}`) } : {}), next: 'Look at every slide with canvas_screenshot. Fill what skipped lists, fix hard findings, weigh the advisory ones, and run brand_check on the application boards.' };
  });


  define('brand_site', { description: 'The brand\'s guidelines as a website, drawn from the linked brand: chapters with a nav, the version and its changelog; colour with roles, HEX, RGB and OKLCH to copy, CMYK and the Pantone the brand states, the share each colour really has across the brand\'s applications (measured from their pixels), and every contrast pair including the ones that fail; tokens to copy as CSS, JSON, Tailwind, Swift and Kotlin; type with a tester and its scale; the logo with clear space and construction to switch on and off, sizes and lockups; the graphic device as a rule in three registers; photography; voice; the brand\'s real application boards, live; motion that plays; downloads; and a "so not" in the chapters. No two neighbouring chapters open the same way. What needs judgement comes from story: one headline per chapter in the brand\'s voice (story.chapters), the idea, the photo rule, voice. Run brand_presentation first so there are applications to measure and show. Publish the page with publish_prepare: the published site gets one small script of its own for the copy buttons and the tester, and reads without it.' }, {
    story: storyArg.extend({ chapters: z.object(Object.fromEntries(['idea', 'logo', 'colour', 'type', 'device', 'photography', 'voice', 'applications', 'motion', 'downloads'].map((k) => [k, line.optional()]))).partial().optional().describe('One headline per chapter, in the brand\'s voice.') }),
    page_name: z.string().min(1).max(120).optional(),
    file_id: fileIdArg,
  }, async ({ story, page_name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const found = await ctx.app.brands.forRoom(room);
    if (!found?.data) throw new Error('This file is not linked to a brand. brand_link it first: the site is drawn from the brand.');
    const e = await env(ctx, doc, found.link.id);
    const brand = await ctx.app.brands.read(found.link.id);
    const apps: string[] = [];
    doc.nodes.forEach((_m, id) => {
      const n = doc.getNode(id);
      if (!n?.artboard || !n.attrs?.[SLIDE_ATTR]) return;
      try { if ((JSON.parse(n.attrs[SLIDE_ATTR]!) as { kind?: string }).kind === 'application' && !/System wall/.test(n.name)) apps.push(id); } catch { /* not ours */ }
    });
    apps.sort((a, b) => (doc.getNode(a)?.name ?? '').localeCompare(doc.getNode(b)?.name ?? '', undefined, { numeric: true }));
    const preset = story.photo_preset ?? (found.data.treatments ?? []).find((x) => !x.suggested)?.name ?? (found.data.treatments ?? [])[0]?.name;
    if (preset && story.photos?.length && !story.photo_treatment) {
      const treated: string[] = [];
      for (const src of story.photos) treated.push(await treatPhotoWithPreset(ctx, doc, found.data, src, preset));
      story = { ...story, photos: treated };
    }
    const share = await measureShare(ctx, doc, found.data.colors, apps);
    const versions = brandVersions(brand.room.doc).map((v) => ({ n: v.n, at: v.at, note: v.note }));
    const px = (v?: string) => Number(/^([\d.]+)px$/.exec(v ?? '')?.[1] ?? 0);
    const sized = apps.map((id) => { const n = doc.getNode(id)!; return { id, width: px(n.style.width) || 1000, height: px(n.style.height) || px(n.style.width) || 1000 }; });
    const plan = buildBrandSite(e, { story: story as never, share, shareSource: `${Math.min(apps.length, 24)} applications`, versions, applications: sized, motion: MOTION });
    room.undoManagerFor(ctx.agent);
    const result = ctx.write(room, () => {
      const blocks = ((doc.meta.get('keyframes') as unknown[] | undefined) ?? []).filter((b): b is string => typeof b === 'string' && keyframesName(b) !== MOTION.name);
      doc.meta.set('keyframes', [...blocks, `@keyframes ${MOTION.name}{from{transform:scaleY(0.12);opacity:0.35}to{transform:scaleY(1);opacity:1}}`]);
      const pageId = doc.createPage(page_name ?? 'Brand site');
      const { ids } = writeBoards(doc, pageId, [plan.board]);
      realize(doc, pageId, { page: 'Brand site', boards: [plan.board], apps: [], placements: plan.placements, devices: plan.devices, skipped: [], gaps: [] }, ids);
      return { pageId, id: ids[0]! };
    });
    ctx.wrote = true;
    ctx.touch([result.id]);
    const other = Math.max(0, 1 - share.reduce((a, x) => a + x.share, 0));
    return {
      file_id: room.id, page_id: result.pageId, board: result.id, chapters: plan.openers.length, openers: plan.openers,
      share: share.filter((x) => x.share > 0.004).sort((a, b) => b.share - a.share).map((x) => `${x.name} ${(x.share * 100).toFixed(1)} %`).concat(share.length ? [`photos and mixes ${(other * 100).toFixed(1)} %`] : []),
      gaps: [...new Set(plan.gaps)],
      next: 'Look at it with canvas_screenshot. Then publish_prepare with this page to make it a website.',
    };
  });

  define('presentation_check', { description: 'Check a brand presentation page (made by brand_presentation): placeholder text and text without contrast are hard; the rest is advisory and may be kept for a reason: identity slides without a reason why, colour not through tokens, the hero colour missing early, the same layout four slides in a row, no full bleed, no dense slide, no close-up or distance shot, missing idea, motion, system wall or next steps, more than two families, display under 2.5 times the body, words every brand uses and words the brand avoids, applications without a line or all with the same line, photos in mixed treatments, shadows the brand does not allow. Also returns questions no machine answers, such as whether a tile reads as the brand with the logo covered.', readOnly: true }, {
    page_id: z.string(),
    file_id: fileIdArg,
  }, async ({ page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (!room.doc.pages.has(page_id)) throw new Error(`No page with id ${page_id}.`);
    const found = await ctx.app.brands.forRoom(room);
    return presentationCheck(room.doc, page_id, found?.data ?? null);
  });
}
