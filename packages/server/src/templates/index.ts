import {
  brandVersionHead, createComponent, importHtml, listMains, resolveInstanceRefs, updateComponent, type BogenDoc, type ComponentProp, type NewNode,
} from '@bogen/core';
import type { BogenServer } from '../http/server.ts';
import { nextArtboardX } from '../mcp/kit.ts';
import type { Room } from '../sync.ts';
import { writeBrandSpec, type BrandSpec } from './brand-spec.ts';
import { brandSystem } from './brand-system.ts';
import { EXAMPLES, exampleTemplate } from './examples/index.ts';
import type { TemplateEnv } from './kit.ts';
import { landingPage } from './landing.ts';
import { socialImages } from './social.ts';
import { pitchDeck } from './deck.ts';
import { storeScreenshots } from './store-screenshots.ts';
import { email } from './email.ts';
import { docsPage } from './docs-page.ts';
import { pricingPage } from './pricing.ts';
import { DISCIPLINE_TEMPLATES } from './discipline-templates.ts';
import { inferDiscipline } from '../design-knowledge/index.ts';
import type { BoardPlan, ComponentDef, TemplateDef, TemplateOptions } from './types.ts';

export type { TemplateDef, TemplateOptions } from './types.ts';
export { EXAMPLES } from './examples/index.ts';

/** Templates build from a brand you have; examples, at the end, bring a brand of their own. */
export const TEMPLATES: readonly TemplateDef[] = [brandSystem, landingPage, socialImages, pitchDeck, storeScreenshots, email, docsPage, pricingPage, ...DISCIPLINE_TEMPLATES, ...EXAMPLES.map(exampleTemplate)];
export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id) as [string, ...string[]];

const BOARD_GAP = 120;
/** Marks a brand made for an example, in its document's meta, so that using the example again reuses it. */
const EXAMPLE_KEY = 'example';

export function templateList() {
  return TEMPLATES.map((t) => ({
    id: t.id, name: t.name, description: t.description, parts: t.parts, discipline: templateDiscipline(t),
    ...(t.brand ? { example: true, kind: t.kind, brand: t.brand.name } : {}),
  }));
}

function templateDiscipline(template: TemplateDef): string {
  if (template.discipline) return template.discipline;
  if (template.id === 'app-store-screenshots' || template.id === 'example-app') return 'mobile-apps';
  if (template.id === 'example-deck') return 'pitch-decks';
  return inferDiscipline(template.id.replaceAll('-', ' '));
}

/** The examples as the home screen shows them: what each is, and the colours and faces of its brand. */
export function exampleList() {
  return EXAMPLES.map((ex) => ({
    id: ex.id, kind: ex.kind, name: ex.name, description: ex.description, parts: ex.parts, brand: ex.brand.name,
    colors: ex.brand.colors.filter((c) => !/cursor/.test(c.role)).slice(0, 5).map((c) => c.value), fonts: ex.brand.families.map((f) => f.family),
  }));
}

/**
 * The brand an example brings, made with the same functions brand_create and brand_update use. The one made before is
 * used again, with whatever the person changed in it; a deleted one is made anew.
 */
async function exampleBrand(app: BogenServer, id: string, spec: BrandSpec, origin: string): Promise<string> {
  for (const entry of app.storage.listBrands()) {
    if (entry.name !== spec.name) continue;
    const { room } = await app.brands.read(entry.id);
    if (room.doc.meta.get(EXAMPLE_KEY) === id) return entry.id;
  }
  const entry = await app.brands.create(spec.name, 'Bogen');
  const { room } = await app.brands.read(entry.id);
  room.doc.transact(() => {
    writeBrandSpec(room.doc, spec, origin);
    room.doc.meta.set(EXAMPLE_KEY, id);
  }, origin);
  app.hub.broadcast({ t: 'brand', id: entry.id });
  return entry.id;
}

export function findTemplate(id: string): TemplateDef {
  const found = TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`There is no template "${id}". Templates: ${TEMPLATE_IDS.join(', ')}.`);
  return found;
}

export interface TemplateRun {
  template: string;
  /** The brand to build from. Default is the brand the file links to. */
  brandId?: string;
  /** Leave out, or set newFile, for a new file named after the brand and the template. */
  fileId?: string;
  newFile?: boolean;
  pageId?: string;
  options?: TemplateOptions;
  /** Who does it: an agent's name, or a person's. Writes are one undoable step of theirs. */
  actor: string;
  origin: string;
}

export interface TemplateResult {
  file_id: string;
  file_name: string;
  page_id: string;
  brand_id: string;
  linked: boolean;
  boards: { id: string; name: string; width: number; height: number | 'hug' }[];
  components: string[];
  gaps: string[];
  /** Layers that hold words to write, with the board they are on and what goes there. */
  slots: { id: string; board: string; name: string; hint: string }[];
  design: { discipline: string; knowledge: string; review: string };
}

/** Finds a layer under a board by its name, the way a template refers to what it wrote. */
function byName(doc: BogenDoc, root: string, name: string, frame = false): string | undefined {
  if (doc.getNode(root)?.name === name) return root;
  const all = doc.descendants(root).filter((n) => n.name === name && !n.virtual);
  return (frame ? all.find((n) => n.type === 'frame') : undefined)?.id ?? all[0]?.id;
}

function propsOf(doc: BogenDoc, mainId: string, def: ComponentDef): ComponentProp[] {
  return (def.props ?? []).map((p) => {
    const target = p.target ? byName(doc, mainId, p.target) : mainId;
    if (!target) throw new Error(`Template error: no layer "${p.target}" in ${def.name}.`);
    const field = p.field ?? (p.type === 'text' ? 'text' : p.type === 'boolean' ? 'visible' : 'src');
    return { name: p.name, type: p.type, targets: [{ path: target === mainId ? '' : target, field }] };
  });
}

/** Writes the boards of a plan into a page. Run it inside one transaction, so that the whole template is one undo step. */
export function writeBoards(doc: BogenDoc, pageId: string, boards: BoardPlan[], discipline?: string): { ids: string[]; components: string[] } {
  let x = nextArtboardX(doc, pageId, BOARD_GAP);
  const ids: string[] = [];
  const components: string[] = [];
  for (const board of boards) {
    const id = doc.insert(pageId, {
      type: 'frame', tag: board.tag ?? 'main', name: board.name, artboard: true,
      ...(discipline ? { attrs: { 'data-bogen-discipline': discipline } } : {}),
      style: {
        position: 'absolute', left: `${x}px`, top: '0px', width: `${board.width}px`, height: board.height ? `${board.height}px` : 'fit-content',
        display: 'flex', flexDirection: 'column', backgroundColor: board.background, color: board.color, fontFamily: board.font, overflow: 'hidden',
      },
    });
    doc.invalidate();
    ids.push(id);
    x += board.width + BOARD_GAP;
    for (const step of board.steps) {
      if ('component' in step) {
        const def = step.component;
        const main = byName(doc, id, def.layer, true);
        if (!main) throw new Error(`Template error: no layer "${def.layer}" for the component ${def.name}.`);
        createComponent(doc, main, { name: def.name, ...(def.description ? { description: def.description } : {}), ...(def.set ? { set: def.set } : {}), ...(def.variant ? { variant: def.variant } : {}) });
        doc.invalidate();
        if (def.props?.length) updateComponent(doc, main, { props: propsOf(doc, main, def) });
        components.push(def.name);
        continue;
      }
      const into = step.into ? byName(doc, id, step.into, true) : id;
      if (!into) throw new Error(`Template error: no layer "${step.into}" in ${board.name}.`);
      const { nodes } = importHtml(step.html, { counterExamples: true });
      resolveInstanceRefs(doc, nodes as NewNode[]);
      doc.insertMany(into, nodes);
      doc.invalidate();
    }
  }
  return { ids, components };
}

/**
 * Lays out a template in a file from a brand: the MCP tool and the editor both come through here. The file is linked
 * to the brand when it is not linked to any, so that its tokens and fonts are there; a file linked to another brand
 * is left alone.
 */
export async function runTemplate(app: BogenServer, run: TemplateRun): Promise<TemplateResult> {
  const template = findTemplate(run.template);
  let fileId = run.fileId;
  let room: Room | undefined;
  if (fileId) room = await app.rooms.get(app.requireFile(fileId).id);
  if (room && app.storage.get(room.id)?.kind === 'brand') throw new Error('That is a brand. Templates go into design files: leave file_id out for a new one.');
  const linkedId = room ? (await app.brands.forRoom(room))?.link.id : undefined;
  // An example brings its own brand. A file of another brand would mix two, so it gets a new file instead.
  if (template.brand && room && linkedId) {
    const own = await exampleBrand(app, template.id, template.brand, run.origin);
    if (linkedId !== own) throw new Error(`This file links to another brand (${linkedId}), and ${template.id} brings its own. Leave file_id out for a new file.`);
  }
  const brandId = template.brand ? await exampleBrand(app, template.id, template.brand, run.origin) : run.brandId ?? linkedId ?? (await app.brands.defaultBrandId()) ?? undefined;
  if (!brandId) throw new Error('Which brand? Pass brand_id. brand_list shows the brands here.');
  if (room && linkedId && linkedId !== brandId) throw new Error(`This file links to another brand (${linkedId}). Use that brand, or leave file_id out for a new file.`);
  const brand = await app.brands.read(brandId);
  const brandName = brand.data.fields.name || brand.entry.name;

  if (!room || run.newFile) {
    const entry = app.createFile(template.fileName(brandName));
    fileId = entry.id;
    room = await app.rooms.get(entry.id);
  }
  let linked = false;
  if (!(await app.brands.forRoom(room))) {
    await app.brands.link(room.id, brandId, run.origin);
    linked = true;
  }

  const { doc } = room;
  let pageId = run.pageId;
  if (pageId && !doc.pages.has(pageId)) throw new Error(`No page with id ${pageId}. Call page_list.`);
  const head = brandVersionHead(brand.room.doc);
  const env: TemplateEnv = {
    data: brand.data,
    tokens: new Set(doc.getTokens().map((t) => t.name)),
    components: new Set(listMains(doc.source).flatMap((m) => [m.name, m.component?.set ?? ''].filter(Boolean))),
    version: head?.n ?? null,
    date: new Date(),
  };
  const plan = template.build(env, run.options ?? {});
  if (!plan.boards.length) throw new Error(`Nothing to make: none of ${(run.options?.only ?? []).join(', ')} is a part of ${template.id}. Parts: ${template.parts.map((p) => p.key).join(', ')}.`);

  if (run.origin.startsWith('agent:')) room.undoManagerFor(run.actor);
  const out = doc.transact(() => {
    if (!pageId) {
      const pages = doc.getPages();
      const empty = pages.length === 1 && !doc.getChildren(pages[0]!.id).length ? pages[0] : undefined;
      if (empty) {
        doc.renamePage(empty.id, plan.page);
        pageId = empty.id;
      } else pageId = pages.find((p) => p.name === plan.page && !doc.getChildren(p.id).length)?.id ?? doc.createPage(plan.page);
    }
    return writeBoards(doc, pageId, plan.boards, templateDiscipline(template));
  }, run.origin);

  return {
    file_id: room.id, file_name: app.storage.get(room.id)?.name ?? '', page_id: pageId!, brand_id: brandId, linked,
    boards: out.ids.map((id, i) => ({ id, name: plan.boards[i]!.name, width: plan.boards[i]!.width, height: plan.boards[i]!.height ?? 'hug' })),
    components: out.components, gaps: [...new Set(plan.gaps)],
    design: { discipline: templateDiscipline(template), knowledge: `design_knowledge action rules discipline ${templateDiscipline(template)}`, review: 'Inspect a fresh canvas_screenshot, then design_verify on each affected artboard. Fill factual content slots first; visual observations remain agent self-assessment.' },
    slots: (plan.slots ?? []).flatMap((slot) => out.ids.flatMap((boardId, i) => {
      const board = doc.getNode(boardId);
      const all = [...(board?.name === slot.layer ? [board] : []), ...doc.descendants(boardId).filter((n) => n.name === slot.layer && !n.virtual)];
      return all.map((n) => ({ id: n.id, board: plan.boards[i]!.name, name: slot.layer, hint: slot.hint }));
    })),
  };
}
