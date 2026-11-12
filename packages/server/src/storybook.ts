import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import * as Y from 'yjs';
import { assertCodeProp, codeComponentName, createComponent, instancesOf, readCodeRef, setCodeProps, updateComponent, type BogenDoc, type CodePropValue, type CodeRef, type ComponentProp } from '@bogen/core';
import type { CodeComponentInfo, CodeProject, CodeProjects } from './code-projects.ts';
import { constLiteral, isRecord, JsName, readLiteral, UNKNOWN, type JsValue } from './js-literal.ts';

/**
 * Storybook stories of a linked project, as code components. Each story file (CSF 2 or 3) is read as text,
 * never run: the meta's component, args and argTypes, and each story's args and name. A component becomes a
 * variant set of mains, one per story, each a code component with the story's args as its props; argTypes and
 * args become the set's props, driving the component's own props (`code.<name>`). Running it again brings the
 * set in step with the stories, and `StorybookWatch` does that by itself while the file is open.
 */

export interface ArgControl { type: 'text' | 'boolean' | 'variant' | 'number' | 'json'; options?: string[] }
export interface StoryEntry { exportName: string; name: string; args: Record<string, CodePropValue>; skipped: string[] }
export interface StoriesModule {
  file: string;
  title?: string;
  component?: { file: string; name: string; import: string };
  argTypes: Record<string, ArgControl>;
  stories: StoryEntry[];
  problems: string[];
}

/** What a story file says, before its component's module is found. */
export interface ParsedStories {
  title?: string;
  component?: { local: string; source: string; imported: string };
  argTypes: Record<string, ArgControl>;
  stories: StoryEntry[];
  problems: string[];
}

export const STORY_FILE = /\.stories\.(tsx|jsx|ts|js|mjs)$/;
const PAGE_NAME = 'Storybook';
const FALLBACK = { width: 240, height: 80 };
const PROP_NAME = /^[a-zA-Z_][\w-]*$/;

/** `PrimaryLarge` and `primary_large` as Storybook names them: "Primary Large". */
export function storyName(exportName: string): string {
  return exportName.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || exportName;
}

function plain(value: JsValue): CodePropValue | undefined {
  if (value === UNKNOWN || value instanceof JsName) return undefined;
  if (Array.isArray(value)) {
    const out = value.map(plain);
    return out.some((v) => v === undefined) ? undefined : out as CodePropValue[];
  }
  if (isRecord(value)) {
    const out: Record<string, CodePropValue> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = plain(v);
      if (p === undefined) return undefined;
      out[k] = p;
    }
    return out;
  }
  return value;
}

function argsOf(value: JsValue | undefined, skipped: string[]): Record<string, CodePropValue> {
  const out: Record<string, CodePropValue> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const p = plain(v);
    try {
      if (p === undefined) throw new Error('not plain');
      assertCodeProp(k, p);
      out[k] = p;
    } catch {
      // A function such as fn(), JSX, or a value from elsewhere: the component's own default stays.
      skipped.push(k);
    }
  }
  return out;
}

export function controlOf(value: JsValue): ArgControl | null {
  if (!isRecord(value)) return null;
  if (value.control === false || (isRecord(value.table) && value.table.disable === true)) return null;
  const options = Array.isArray(value.options) ? value.options.filter((o): o is string | number => typeof o === 'string' || typeof o === 'number').map(String) : undefined;
  const control = typeof value.control === 'string' ? value.control : isRecord(value.control) && typeof value.control.type === 'string' ? value.control.type : undefined;
  if (options?.length && (!control || /select|radio|check/.test(control))) return { type: 'variant', options };
  if (control === 'boolean') return { type: 'boolean' };
  if (control === 'text' || control === 'color' || control === 'date') return { type: 'text' };
  if (control === 'number' || control === 'range') return { type: 'number' };
  if (control === 'object' || control === 'array') return { type: 'json' };
  return null;
}

function argTypesOf(value: JsValue | undefined): Record<string, ArgControl> {
  const out: Record<string, ArgControl> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const control = controlOf(v);
    if (control && PROP_NAME.test(k)) out[k] = control;
  }
  return out;
}

/** Local names of a module's imports, with where they come from. */
export function readImports(src: string): Map<string, { source: string; imported: string }> {
  const out = new Map<string, { source: string; imported: string }>();
  for (const m of src.matchAll(/import\s+(type\s+)?([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const clause = m[2]!.trim();
    const source = m[3]!;
    const def = /^([\w$]+)\s*(,|$)/.exec(clause);
    if (def) out.set(def[1]!, { source, imported: 'default' });
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of named?.[1]?.split(',') ?? []) {
      const spec = part.trim().replace(/^type\s+/, '');
      if (!spec || part.trim().startsWith('type ')) continue;
      const [imported, local] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (imported && /^[\w$]+$/.test(imported)) out.set(local && /^[\w$]+$/.test(local) ? local : imported, { source, imported });
    }
  }
  return out;
}

/** Reads one story file as text. */
export function parseStories(src: string): ParsedStories {
  const problems: string[] = [];
  const imports = readImports(src);
  let meta: JsValue | undefined;
  const def = /export\s+default\s+/.exec(src);
  if (def) {
    const at = def.index + def[0].length;
    if (src[at] === '{') meta = readLiteral(src, at).value;
    else {
      const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(at))?.[0];
      if (name) meta = constLiteral(src, name);
    }
  }
  if (!isRecord(meta)) problems.push('No meta object was found in export default.');
  const m = isRecord(meta) ? meta : {};
  const title = typeof m.title === 'string' ? m.title : undefined;
  let component: ParsedStories['component'];
  if (m.component instanceof JsName) {
    const from = imports.get(m.component.name);
    if (from) component = { local: m.component.name, ...from };
    else problems.push(`${m.component.name} is not imported in this file, so its module is unknown.`);
  } else problems.push('The meta names no component.');
  const metaSkipped: string[] = [];
  const metaArgs = argsOf(m.args, metaSkipped);
  const argTypes = argTypesOf(m.argTypes);
  const excluded = new Set(Array.isArray(m.excludeStories) ? m.excludeStories.filter((x): x is string => typeof x === 'string') : []);

  const stories: StoryEntry[] = [];
  for (const found of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*/g)) {
    const exportName = found[1]!;
    if (exportName.startsWith('__') || excluded.has(exportName)) continue;
    const value = readLiteral(src, found.index + found[0].length).value;
    const skipped = [...metaSkipped];
    let own: JsValue | undefined;
    let name: string | undefined;
    if (isRecord(value)) {
      own = value.args;
      if (typeof value.name === 'string') name = value.name;
      Object.assign(argTypes, argTypesOf(value.argTypes));
    } else {
      // CSF 2: `Primary = Template.bind({})`, then `Primary.args = {...}`.
      const assigned = new RegExp(`(?:^|[\\s;])${exportName.replace(/\$/g, '\\$')}\\.args\\s*=\\s*`).exec(src);
      if (assigned) own = readLiteral(src, assigned.index + assigned[0].length).value;
      const named = new RegExp(`(?:^|[\\s;])${exportName.replace(/\$/g, '\\$')}\\.storyName\\s*=\\s*(['"\`])([^'"\`]*)\\1`).exec(src);
      if (named) name = named[2];
    }
    const args = { ...metaArgs, ...argsOf(own, skipped) };
    stories.push({ exportName, name: name ?? storyName(exportName), args, skipped: [...new Set(skipped)].filter((k) => !(k in args)) });
  }
  if (!stories.length) problems.push('No stories are exported.');
  return { ...(title ? { title } : {}), ...(component ? { component } : {}), argTypes, stories, problems };
}

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

/** The module an import of a story file points at, as a path in the project. */
export function resolveImport(projects: CodeProjects, project: CodeProject, storyFile: string, source: string): string | null {
  let base: string | null = null;
  if (source.startsWith('.')) base = join(project.dir, dirname(storyFile), source);
  else {
    const alias = projects.aliases(project).find((a) => source.startsWith(a.prefix));
    if (alias) base = join(alias.target, source.slice(alias.prefix.length));
  }
  if (!base) return null;
  for (const ext of EXTENSIONS) {
    const abs = base + ext;
    if (!/\.(tsx|jsx|ts|js|mjs)$/.test(abs) || !existsSync(abs)) continue;
    const rel = relative(project.dir, abs).split(sep).join(posix.sep);
    if (rel.startsWith('..')) return null;
    return rel;
  }
  return null;
}

/** Every story file of the project, read and resolved. */
export async function readStories(projects: CodeProjects, project: CodeProject): Promise<StoriesModule[]> {
  const files = (await projects.files(project)).filter((f) => STORY_FILE.test(f.rel) && f.size < 400_000);
  const out: StoriesModule[] = [];
  for (const f of files) {
    const parsed = parseStories(await readFile(f.abs, 'utf8').catch(() => ''));
    const mod: StoriesModule = { file: f.rel, ...(parsed.title ? { title: parsed.title } : {}), argTypes: parsed.argTypes, stories: parsed.stories, problems: [...parsed.problems] };
    if (parsed.component) {
      const file = resolveImport(projects, project, f.rel, parsed.component.source);
      if (file) mod.component = { file, name: parsed.component.imported, import: projects.importPath(project, file) };
      else mod.problems.push(`The module of ${parsed.component.local} ("${parsed.component.source}") is not a file in this project.`);
    }
    out.push(mod);
  }
  return out;
}

/** A key that changes when any story file changes, or one comes or goes. */
export async function storiesKey(projects: CodeProjects, project: CodeProject): Promise<string> {
  return (await projects.files(project)).filter((f) => STORY_FILE.test(f.rel)).map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`).join('|');
}

/** The mark on a main made from a story. */
export interface StoryMark { project: string; file: string; export: string; gone?: boolean }
/** The mark on the frame that holds one component's stories. */
export interface StorySetMark { project: string; component: string }

function markOf<T>(doc: BogenDoc, id: string, field: string): T | undefined {
  const v = doc.nodes.get(id)?.get(field);
  return v && typeof v === 'object' && !(v instanceof Y.AbstractType) ? v as T : undefined;
}

export interface StoryImportReport {
  page: string;
  components: { set: string; frame: string; component: string; stories: { name: string; id: string; status: 'added' | 'updated' | 'same' | 'removed' | 'kept' }[] }[];
  problems: { file: string; problem: string }[];
  changed: boolean;
}

export interface StoryImportDeps {
  measure: (ref: CodeRef) => Promise<{ width: number; height: number } | null>;
  /** Runs the writes as one transaction, with whatever origin gets the credit. */
  transact: (fn: () => void) => void;
  /** Props the component's source declares, for the options argTypes leave out. */
  scanned?: CodeComponentInfo[];
}

function setProps(mod: StoriesModule, story: StoryEntry, scanned: CodeComponentInfo | undefined): ComponentProp[] {
  const out: ComponentProp[] = [];
  const names = new Set([...Object.keys(mod.argTypes), ...mod.stories.flatMap((s) => Object.keys(s.args))]);
  for (const name of names) {
    if (!PROP_NAME.test(name)) continue;
    const declared = scanned?.props.find((p) => p.name === name);
    let control = mod.argTypes[name];
    if (!control && declared?.type === 'enum' && declared.options?.length) control = { type: 'variant', options: declared.options };
    if (!control) {
      const sample = mod.stories.map((s) => s.args[name]).find((v) => v !== undefined);
      control = typeof sample === 'boolean' ? { type: 'boolean' } : typeof sample === 'string' ? { type: 'text' } : { type: 'json' };
    }
    // Bogen's props hold words and switches. Numbers and objects stay in each story's own props.
    if (control.type !== 'text' && control.type !== 'boolean' && control.type !== 'variant') continue;
    const value = story.args[name];
    const fallback = typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
    out.push({ name, type: control.type, ...(control.options ? { options: control.options } : {}), ...(fallback !== undefined ? { default: fallback } : {}), targets: [{ path: '', field: `code.${name}` }] });
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Lays out each component's stories as a variant set of code components, or brings an earlier import up to date. */
export async function importStories(doc: BogenDoc, project: CodeProject, modules: StoriesModule[], deps: StoryImportDeps): Promise<StoryImportReport> {
  const problems = modules.flatMap((m) => m.problems.map((problem) => ({ file: m.file, problem })));
  const groups = new Map<string, StoriesModule[]>();
  for (const mod of modules) {
    if (!mod.component || !mod.stories.length) continue;
    const key = `${mod.component.file}#${mod.component.name}`;
    groups.set(key, [...(groups.get(key) ?? []), mod]);
  }
  const readable = new Set(modules.filter((m) => m.component).map((m) => m.file));

  // What is there from before.
  const frames = new Map<string, string>();
  const mains = new Map<string, string>();
  doc.nodes.forEach((m, id) => {
    const set = markOf<StorySetMark>(doc, id, 'storybookSet');
    if (set?.project === project.id) frames.set(set.component, id);
    const mark = markOf<StoryMark>(doc, id, 'storybook');
    if (mark?.project === project.id) mains.set(`${mark.file}#${mark.export}`, id);
  });
  let pageId = [...frames.values()].map((id) => doc.pageOf(id)).find(Boolean) ?? doc.getPages().find((p) => p.name === PAGE_NAME)?.id;

  interface Planned { mod: StoriesModule; story: StoryEntry; ref: CodeRef; props: ComponentProp[]; existing?: string; size?: { width: number; height: number } | null; status: 'added' | 'updated' | 'same' }
  const plan: { key: string; set: string; title: string; frame?: string; stories: Planned[] }[] = [];
  for (const [key, mods] of groups) {
    const first = mods[0]!;
    const component = first.component!;
    const scanned = deps.scanned?.find((c) => c.file === component.file && c.name === component.name);
    const set = (first.title?.split('/').at(-1)?.trim() || scanned?.display || codeComponentName(component)).slice(0, 120);
    const stories: Planned[] = [];
    for (const mod of mods) {
      for (const story of mod.stories) {
        const ref: CodeRef = { project: project.id, file: component.file, name: component.name, import: component.import, props: story.args };
        const props = setProps({ ...mod, stories: mods.flatMap((m) => m.stories), argTypes: Object.assign({}, ...mods.map((m) => m.argTypes)) }, story, scanned);
        const existing = mains.get(`${mod.file}#${story.exportName}`);
        let status: Planned['status'] = existing ? 'same' : 'added';
        if (existing) {
          const m = doc.nodes.get(existing)!;
          const was = readCodeRef(m);
          const def = doc.getNode(existing)?.component;
          const mark = markOf<StoryMark>(doc, existing, 'storybook');
          const oldProps = (def?.props ?? []).map(({ name, type, options, default: d, targets }) => ({ name, type, ...(options ? { options } : {}), ...(d !== undefined ? { default: d } : {}), ...(targets ? { targets } : {}) }));
          if (!was || !sameJson(was.props, ref.props) || was.file !== ref.file || was.name !== ref.name || was.import !== ref.import
            || !sameJson(oldProps, props) || def?.set !== set || def?.variant?.story !== story.name || m.get('name') !== story.name || mark?.gone) status = 'updated';
        }
        stories.push({ mod, story, ref, props, ...(existing ? { existing } : {}), status });
      }
    }
    plan.push({ key, set, title: first.title ?? set, ...(frames.has(key) ? { frame: frames.get(key)! } : {}), stories });
  }

  // Sizes come from the component as it renders, outside the transaction.
  for (const group of plan) {
    for (const p of group.stories) {
      if (p.status === 'added' || (p.status === 'updated' && !sameJson(readCodeRef(doc.nodes.get(p.existing!)!)?.props, p.ref.props))) p.size = await deps.measure(p.ref).catch(() => null);
    }
  }

  const wanted = new Set(plan.flatMap((g) => g.stories.map((p) => `${p.mod.file}#${p.story.exportName}`)));
  const leaving = [...mains].filter(([key]) => !wanted.has(key) && (readable.has(key.slice(0, key.lastIndexOf('#'))) || !modules.some((m) => m.file === key.slice(0, key.lastIndexOf('#')))));
  const report: StoryImportReport = { page: pageId ?? '', components: [], problems, changed: false };
  const anything = plan.some((g) => !g.frame || g.stories.some((p) => p.status !== 'same')) || leaving.some(([, id]) => !markOf<StoryMark>(doc, id, 'storybook')?.gone || !instancesOf(doc, id).length);

  const write = () => {
    if (!pageId) pageId = doc.createPage(PAGE_NAME);
    report.page = pageId;
    let left = 0;
    for (const n of doc.getChildren(pageId)) {
      const x = Number.parseFloat(n.style.left ?? '');
      const w = Number.parseFloat(n.style.width ?? '');
      if (Number.isFinite(x)) left = Math.max(left, x + (Number.isFinite(w) ? w : 1200) + 80);
    }
    const gone: { id: string; frame?: string; name: string; status: 'removed' | 'kept' }[] = [];
    for (const [, id] of leaving) {
      if (!doc.nodes.has(id)) continue;
      const info = { id, frame: doc.getNode(id)?.parent, name: String(doc.nodes.get(id)!.get('name') ?? '') };
      if (!instancesOf(doc, id).length) {
        doc.delete([id]);
        gone.push({ ...info, status: 'removed' });
      } else {
        const mark = markOf<StoryMark>(doc, id, 'storybook')!;
        if (!mark.gone) doc.nodes.get(id)!.set('storybook', { ...mark, gone: true });
        gone.push({ ...info, status: 'kept' });
      }
    }
    for (const group of plan) {
      let frame = group.frame;
      if (!frame || !doc.nodes.has(frame)) {
        frame = doc.insert(pageId, {
          type: 'frame', name: group.title, artboard: true,
          style: { position: 'absolute', left: `${left}px`, top: '0px', width: '1200px', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '32px', padding: '40px', background: '#ffffff' },
        });
        doc.nodes.get(frame)!.set('storybookSet', { project: project.id, component: group.key } satisfies StorySetMark);
        left += 1280;
      }
      const entry: StoryImportReport['components'][number] = { set: group.set, frame, component: group.key, stories: [] };
      for (const p of group.stories) {
        const size = p.size ?? undefined;
        let id = p.existing && doc.nodes.has(p.existing) ? p.existing : undefined;
        if (!id) {
          const s = size ?? FALLBACK;
          id = doc.insert(frame, { type: 'embed', name: p.story.name, style: { width: `${s.width}px`, height: `${s.height}px`, flexShrink: '0' }, code: p.ref });
          createComponent(doc, id, { name: p.story.name, set: group.set, variant: { story: p.story.name }, props: p.props });
          doc.nodes.get(id)!.set('storybook', { project: project.id, file: p.mod.file, export: p.story.exportName } satisfies StoryMark);
        } else if (p.status === 'updated') {
          const m = doc.nodes.get(id)!;
          const was = readCodeRef(m);
          if (!was || was.file !== p.ref.file || was.name !== p.ref.name || was.import !== p.ref.import) m.set('code', { project: p.ref.project, file: p.ref.file, name: p.ref.name, ...(p.ref.import ? { import: p.ref.import } : {}) });
          const patch: Record<string, CodePropValue | undefined> = { ...p.ref.props };
          for (const k of Object.keys(was?.props ?? {})) if (!(k in p.ref.props)) patch[k] = undefined;
          setCodeProps(doc, id, patch);
          updateComponent(doc, id, { name: p.story.name, set: group.set, variant: { story: p.story.name }, props: p.props });
          const mark = markOf<StoryMark>(doc, id, 'storybook');
          if (mark?.gone) m.set('storybook', { project: project.id, file: p.mod.file, export: p.story.exportName } satisfies StoryMark);
          if (size) doc.updateStyle(id, { width: `${size.width}px`, height: `${size.height}px` });
        }
        entry.stories.push({ name: p.story.name, id, status: p.status });
      }
      for (const g of gone) if (g.frame === frame) entry.stories.push({ name: g.name, id: g.id, status: g.status });
      report.components.push(entry);
    }
    if (!sameJson(doc.meta.get('storybook'), { project: project.id })) doc.meta.set('storybook', { project: project.id });
  };

  if (anything) {
    deps.transact(write);
    report.changed = true;
  } else {
    report.page = pageId ?? '';
    for (const group of plan) report.components.push({ set: group.set, frame: group.frame!, component: group.key, stories: group.stories.map((p) => ({ name: p.story.name, id: p.existing!, status: 'same' as const })) });
  }
  return report;
}

/**
 * Keeps imported stories in step while a file is open: every few seconds it looks at the story files' sizes
 * and times, and runs the import again when they changed. The import writes nothing when nothing differs.
 */
export class StorybookWatch {
  private timer: NodeJS.Timeout | null = null;
  private seen = new Map<string, string>();
  private busy = false;

  constructor(private readonly deps: { loaded: () => { id: string; doc: BogenDoc }[]; projects: CodeProjects; sync: (fileId: string, project: CodeProject) => Promise<unknown>; intervalMs?: number }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 4000);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const room of this.deps.loaded()) {
        const linked = room.doc.meta.get('storybook') as { project?: unknown } | undefined;
        if (!linked || typeof linked.project !== 'string') continue;
        const project = this.deps.projects.get(linked.project);
        if (!project) continue;
        const key = await storiesKey(this.deps.projects, project).catch(() => null);
        if (key === null || this.seen.get(room.id) === key) continue;
        this.seen.set(room.id, key);
        await this.deps.sync(room.id, project).catch((e) => console.error(`bogen: stories of ${project.name} not synced: ${(e as Error).message}`));
      }
    } finally {
      this.busy = false;
    }
  }

  forget(fileId: string): void {
    this.seen.delete(fileId);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
