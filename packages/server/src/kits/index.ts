import {
  createComponent, getModes, handoffImportLines, importHtml, libraryLinks, publishLibrary, readHandoff, setTokenMode, updateComponent, writeKitTokens as writeTokens,
  type BogenDoc, type BrandData, type ComponentProp, type NewNode,
} from '@bogen/core';
import type { BogenServer } from '../http/server.ts';
import { nextArtboardX } from '../mcp/kit.ts';
import type { Room } from '../sync.ts';
import { bootstrapKit } from './bootstrap.ts';
import { carbonKit } from './carbon.ts';
import { daisyuiKit } from './daisyui.ts';
import { ionicKit } from './ionic.ts';
import { combinations } from './markup.ts';
import { mantineKit } from './mantine.ts';
import { materialKit } from './material.ts';
import { picoKit } from './pico.ts';
import { radixKit } from './radix.ts';
import { shadcnBaseUiKit, shadcnKit } from './shadcn.ts';
import type { Kit, KitComponent, KitRole, KitSummary, Variant } from './types.ts';
import { uswdsKit } from './uswds.ts';
import { webAwesomeKit } from './web-awesome.ts';

export type { Kit, KitComponent, KitSummary, KitToken, KitRole, Variant } from './types.ts';

/**
 * The kit registry. Built-in kits are listed here; `registerKit` adds one at run time, such as a kit made from
 * a code project's components (from-code.ts) or an import of a Storybook. A kit is turned into Bogen components
 * once per device, in a file of its own that publishes them as a library, so that files link it like any other.
 */
const BUILTIN: Kit[] = [shadcnKit, shadcnBaseUiKit, radixKit, bootstrapKit, materialKit, ionicKit, mantineKit, carbonKit, uswdsKit, daisyuiKit, webAwesomeKit, picoKit];
const registered = new Map<string, Kit>();

/**
 * Adds a kit made at run time, or replaces one of the same id: from a code project's components (from-code.ts) or
 * from a Storybook. Its components are html or code components, each with a handoff; its tokens use its own names.
 */
export function registerKit(kit: Kit): void {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(kit.id)) throw new Error(`"${kit.id}" is not a kit id. Use lower case letters, digits and dashes.`);
  if (BUILTIN.some((k) => k.id === kit.id)) throw new Error(`${kit.id} is a built-in kit.`);
  if (!kit.components.length) throw new Error(`${kit.name} has no components.`);
  for (const c of kit.components) {
    if (!c.html && !c.code) throw new Error(`${kit.name}: ${c.name} has neither html nor code.`);
    if (!readHandoff(c.handoff)) throw new Error(`${kit.name}: the handoff of ${c.name} is not valid. It needs from (a module) and name (a component in PascalCase).`);
  }
  for (const t of kit.tokens) if (!/^[a-zA-Z][\w-]{0,99}$/.test(t.name)) throw new Error(`${kit.name}: "${t.name}" is not a token name.`);
  registered.set(kit.id, { ...kit, source: kit.source ?? 'code' });
}

export function unregisterKit(id: string): boolean {
  return registered.delete(id);
}

export function allKits(): Kit[] {
  return [...BUILTIN.map((k) => ({ ...k, source: 'builtin' as const })), ...registered.values()];
}

export function findKit(ref: string): Kit {
  const lower = ref.trim().toLowerCase();
  const hit = allKits().find((k) => k.id === lower || k.name.toLowerCase() === lower);
  if (!hit) throw new Error(`There is no kit "${ref}". Kits: ${allKits().map((k) => k.id).join(', ')}.`);
  return hit;
}

/** The members of a component: every combination of its axes, or the ones it lists. */
export function membersOf(c: KitComponent): Variant[] {
  if (c.members) return c.members;
  if (!c.axes || !Object.keys(c.axes).length) return [{}];
  return combinations(c.axes).slice(0, 32);
}

export function kitSummary(kit: Kit): KitSummary {
  return {
    id: kit.id, name: kit.name, description: kit.description, platform: kit.platform, library: kit.library, source: kit.source ?? 'builtin',
    tokens: kit.tokens.map((t) => t.name),
    ...(kit.design ? { design: kit.design } : {}),
    components: kit.components.map((c) => ({ name: c.name, group: c.group, variants: c.axes ?? {}, import: handoffImportLines([c.handoff]).join('\n') })),
  };
}

const KIT_KEY = 'kit';
const KIT_VERSION_KEY = 'kitVersion';

function memberName(c: KitComponent, variant: Variant): string {
  const values = Object.values(variant);
  return values.length ? `${c.name} / ${values.join(', ')}` : c.name;
}

function byName(doc: BogenDoc, root: string, name: string): string | undefined {
  if (!name) return root;
  return doc.descendants(root).find((n) => n.name === name && !n.virtual)?.id;
}

/** Inserts at the end. Inside one transaction the child lists are cached, so each insert must see the last. */
function add(doc: BogenDoc, parent: string, spec: NewNode): string {
  const id = doc.insert(parent, spec);
  doc.invalidate();
  return id;
}

/** A component's handoff, with the first value of each axis as the default that code leaves out. */
function handoffOf(c: KitComponent): KitComponent['handoff'] {
  if (c.handoff.defaults || !c.axes) return c.handoff;
  return { ...c.handoff, defaults: Object.fromEntries(Object.entries(c.axes).map(([k, v]) => [k, v[0]!])) };
}

/** Writes the kit's tokens and its light and dark modes into a file, adding only what is missing. */
export function writeKitTokens(doc: BogenDoc, kit: Kit, replace = false): string[] {
  return writeTokens(doc, kit.tokens, replace);
}

/**
 * Writes a kit's components as mains into a frame: one row per component with its members, each a main of the
 * component's variant set, with props, slots and the handoff to its library. Inside the caller's transaction.
 */
export function writeKitComponents(doc: BogenDoc, parent: string, kit: Kit, insertCode?: (parent: string, c: KitComponent, variant: Variant) => string): string[] {
  const mains: string[] = [];
  const groups = [...new Set(kit.components.map((c) => c.group))];
  for (const group of groups) {
    const section = add(doc, parent, { type: 'frame', tag: 'section', name: group, style: { display: 'flex', flexDirection: 'column', gap: '32px' } });
    add(doc, section, { type: 'text', tag: 'h2', name: `${group} title`, text: group, style: { margin: '0', fontSize: '22px', fontWeight: '600', fontFamily: 'var(--kit-showcase-font, inherit)' } });
    for (const c of kit.components.filter((k) => k.group === group)) {
      const row = add(doc, section, { type: 'frame', tag: 'div', name: c.name, style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
      add(doc, row, { type: 'text', tag: 'h3', name: `${c.name} name`, text: c.name, style: { margin: '0', fontSize: '13px', fontWeight: '600', opacity: '0.6' } });
      const list = add(doc, row, { type: 'frame', tag: 'div', name: `${c.name} members`, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '16px' } });
      for (const variant of membersOf(c)) {
        let id: string;
        if (c.html) {
          const { nodes } = importHtml(c.html(variant));
          if (nodes.length !== 1) throw new Error(`Kit error: ${kit.id} ${c.name} is not one root element.`);
          [id] = doc.insertMany(list, nodes as NewNode[]) as [string];
        } else if (c.code && insertCode) id = insertCode(list, c, variant);
        else throw new Error(`Kit error: ${kit.id} ${c.name} has neither html nor code.`);
        doc.invalidate();
        const axes = Object.keys(variant).length > 0;
        createComponent(doc, id, { name: memberName(c, variant), description: c.description, ...(axes ? { set: c.name, variant } : {}), handoff: handoffOf(c) });
        doc.invalidate();
        const props: ComponentProp[] = [];
        for (const p of c.props ?? []) {
          const target = byName(doc, id, p.target);
          if (!target) continue;
          props.push({ name: p.name, type: p.type, targets: [{ path: target === id ? '' : target, field: p.field ?? (p.type === 'text' ? 'text' : p.type === 'boolean' ? 'visible' : 'src') }] });
        }
        if (props.length) updateComponent(doc, id, { props });
        doc.invalidate();
        mains.push(id);
      }
    }
  }
  return mains;
}

/** Lays a kit out on a page: a light board with the mains, then a dark board with an instance of each component. */
export function writeKitBoards(doc: BogenDoc, pageId: string, kit: Kit, insertCode?: (parent: string, c: KitComponent, variant: Variant) => string): { boards: string[]; mains: string[] } {
  const role = (r: KitRole, fallback: string) => {
    const t = kit.tokens.find((k) => k.role === r);
    return t ? `var(--${t.name})` : fallback;
  };
  const left = nextBoardX(doc, pageId);
  const board = add(doc, pageId, {
    type: 'frame', tag: 'main', name: kit.name, artboard: true,
    style: { position: 'absolute', left: `${left}px`, top: '0px', width: '1440px', height: 'fit-content', display: 'flex', flexDirection: 'column', gap: '56px', padding: '64px', boxSizing: 'border-box', backgroundColor: role('background', '#ffffff'), color: role('foreground', '#111111'), fontFamily: role('font', kit.font) },
  });
  add(doc, board, { type: 'text', tag: 'h1', name: 'Kit title', text: kit.name, style: { margin: '0', fontSize: '40px', fontWeight: '600', letterSpacing: '-0.02em' } });
  add(doc, board, { type: 'text', tag: 'p', name: 'Kit description', text: `${kit.description} Code: ${kit.library.name} (${kit.library.license}). ${kit.components.every((c) => c.handoff.element) ? 'Each component is written as the library\'s own markup when you take code.' : 'Each component imports from the library when you take code.'}`, style: { margin: '0', maxWidth: '760px', fontSize: '16px', lineHeight: '1.5', opacity: '0.7' } });
  doc.invalidate();
  const mains = writeKitComponents(doc, board, kit, insertCode);
  const boards = [board];
  if (kit.tokens.some((t) => t.dark !== undefined)) {
    const dark = add(doc, pageId, {
      type: 'frame', tag: 'main', name: `${kit.name}, dark`, artboard: true, mode: 'dark',
      style: { position: 'absolute', left: `${left + 1560}px`, top: '0px', width: '1440px', height: 'fit-content', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '32px', padding: '64px', boxSizing: 'border-box', backgroundColor: role('background', '#111111'), color: role('foreground', '#ffffff'), fontFamily: role('font', kit.font) },
    });
    const seen = new Set<string>();
    for (const id of mains) {
      const set = doc.rawNode(id)?.component?.set ?? id;
      if (seen.has(set)) continue;
      seen.add(set);
      add(doc, dark, { type: 'frame', tag: 'div', name: doc.rawNode(id)?.component?.set ?? doc.rawNode(id)?.name ?? 'Instance', instanceOf: id, style: {} });
    }
    doc.invalidate();
    boards.push(dark);
  }
  return { boards, mains };
}

function nextBoardX(doc: BogenDoc, pageId: string): number {
  return doc.getChildren(pageId).length ? nextArtboardX(doc, pageId, 120) : 0;
}

/** The file that holds a built-in kit on this device, made and published on first use, made again for a newer kit. */
export async function ensureKitLibrary(app: BogenServer, kit: Kit): Promise<{ fileId: string; created: boolean }> {
  for (const entry of app.storage.list()) {
    const room = app.rooms.peek(entry.id) ?? (entry.name.endsWith(' kit') ? await app.rooms.get(entry.id) : undefined);
    if (room?.doc.meta.get(KIT_KEY) === kit.id && room.doc.meta.get(KIT_VERSION_KEY) === kit.version) return { fileId: entry.id, created: false };
  }
  if (kit.components.some((c) => !c.html)) throw new Error(`${kit.name} is made of code components, which a library cannot hold. Use kit_use with file_id to build it into a file.`);
  const entry = app.createFile(`${kit.name} kit`);
  const room = await app.rooms.get(entry.id);
  const { doc } = room;
  const origin = `kit:${kit.id}`;
  doc.transact(() => {
    const page = doc.getPages()[0]!;
    doc.renamePage(page.id, 'Components');
    writeKitTokens(doc, kit, true);
    writeKitBoards(doc, page.id, kit);
    doc.meta.set(KIT_KEY, kit.id);
    doc.meta.set(KIT_VERSION_KEY, kit.version);
  }, origin);
  doc.transact(() => publishLibrary(doc, { name: kit.name, description: kit.description, by: 'Bogen' }), origin);
  app.hub.broadcast({ t: 'library', id: entry.id });
  return { fileId: entry.id, created: true };
}

const ROLE_PATTERNS: Partial<Record<KitRole, RegExp>> = {
  background: /^(background|bg|canvas|paper|base)\b/i,
  foreground: /^(text|foreground|fg|ink|body)\b/i,
  surface: /^(surface|card|panel)\b/i,
  primary: /^(primary|brand|accent|action)\b/i,
  'on-primary': /^on[\s-]?primary|primary[\s-]?(text|foreground)/i,
  secondary: /^secondary\b/i,
  muted: /^(muted|subtle)\b/i,
  border: /^(border|line|divider|outline)\b/i,
  accent: /^(accent|highlight)\b/i,
  danger: /^(danger|error|destructive|critical)\b/i,
};

/** What a brand says for each of a kit's roles, as values for its tokens: the brand's token where it has one. */
export function brandTheme(kit: Kit, brand: BrandData): Record<string, string> {
  const out: Record<string, string> = {};
  const value = (c: { token?: string; value: string }) => (c.token ? `var(--${c.token})` : c.value);
  for (const t of kit.tokens) {
    if (!t.role) continue;
    if (t.role === 'font') {
      const family = brand.families.find((f) => /body|text|ui/i.test(f.role)) ?? brand.families[0];
      if (family) out[t.name] = family.token ? `var(--${family.token})` : `${family.family}, ${family.fallback || 'sans-serif'}`;
      continue;
    }
    if (t.role === 'radius') {
      const r = brand.radius[0];
      if (r) out[t.name] = r.token ? `var(--${r.token})` : `${r.value}px`;
      continue;
    }
    const pattern = ROLE_PATTERNS[t.role];
    const color = pattern && brand.colors.find((c) => pattern.test(c.role) || pattern.test(c.name));
    if (color) out[t.name] = value(color);
  }
  return out;
}

/** Sets a theme onto the kit's tokens in a file, in the base mode, or in one mode. Unknown tokens are refused. */
export function applyKitTheme(doc: BogenDoc, kit: Kit, theme: Record<string, string>, mode?: string): string[] {
  const known = new Map(kit.tokens.map((t) => [t.name, t]));
  const done: string[] = [];
  for (const [name, val] of Object.entries(theme)) {
    const token = known.get(name.replace(/^--/, ''));
    if (!token) throw new Error(`${kit.name} has no token "${name}". Its tokens: ${kit.tokens.map((t) => t.name).join(', ')}.`);
    if (!doc.tokens.has(token.name)) doc.setToken(token.name, token.kind, token.light);
    if (mode) setTokenMode(doc, token.name, mode, val);
    else {
      doc.setToken(token.name, token.kind, val);
      // A brand's colour is one value: the dark mode follows it unless a mode was named.
      if (token.dark !== undefined && getModes(doc).some((m) => m.name === 'dark' && !m.base)) setTokenMode(doc, token.name, 'dark', null);
    }
    done.push(token.name);
  }
  return done;
}

export interface KitUseResult {
  kit: string;
  library?: { id: string; name: string; created: boolean };
  /** For a kit of code components: the page its mains were built on. */
  page?: { id: string; boards: string[]; mains: number };
  tokens_added: string[];
  themed: string[];
  components: { name: string; variants: Record<string, string[]>; import: string }[];
}

export interface KitUseOptions {
  theme?: Record<string, string>;
  fromBrand?: boolean;
  write: <T>(fn: () => T) => T;
  /** Places a code component, for a kit made of them; see writeKitComponents. */
  insertCode?: (parent: string, c: KitComponent, variant: Variant) => string;
}

/**
 * Links a kit into a file: its library, its tokens and its dark mode. A theme or the file's brand maps onto its
 * tokens. A kit of code components cannot be a library, so its mains are built into a page of this file instead.
 */
export async function useKit(app: BogenServer, room: Room, kit: Kit, options: KitUseOptions): Promise<KitUseResult> {
  const theme = { ...(options.fromBrand ? await brandThemeFor(app, room, kit) : {}), ...(options.theme ?? {}) };
  const tokens = () => {
    const added = writeKitTokens(room.doc, kit);
    const themed = Object.keys(theme).length ? applyKitTheme(room.doc, kit, theme) : [];
    return { added, themed };
  };
  if (kit.components.some((c) => !c.html)) {
    if (!options.insertCode) throw new Error(`${kit.name} is made of code components: link its project to this file first.`);
    const out = options.write(() => {
      const t = tokens();
      const page = room.doc.createPage(`${kit.name} kit`);
      const { boards, mains } = writeKitBoards(room.doc, page, kit, options.insertCode);
      return { ...t, page, boards, mains };
    });
    return { kit: kit.id, page: { id: out.page, boards: out.boards, mains: out.mains.length }, tokens_added: out.added, themed: out.themed, components: kitSummary(kit).components };
  }
  const { fileId, created } = await ensureKitLibrary(app, kit);
  if (fileId === room.id) throw new Error('This is the kit\'s own file. Use the kit from another file.');
  if (!libraryLinks(room.doc).some((l) => l.id === fileId)) await app.libraries.link(room, fileId, options.write);
  const out = options.write(tokens);
  return { kit: kit.id, library: { id: fileId, name: kit.name, created }, tokens_added: out.added, themed: out.themed, components: kitSummary(kit).components };
}

async function brandThemeFor(app: BogenServer, room: Room, kit: Kit): Promise<Record<string, string>> {
  const link = await app.brands.forRoom(room);
  if (!link) throw new Error('This file links no brand, so there is nothing to map. Link one with brand_link, or pass theme.');
  const brand = await app.brands.read(link.link.id);
  return brandTheme(kit, brand.data);
}
