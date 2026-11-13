import { assertCodeProp, codeUsageJsx, setCodeProps, type BogenDoc, type CodePropValue, type CodeRef } from '@bogen/core';
import { z } from 'zod';
import type { CodeProject } from '../code-projects.ts';
import { measureCode } from '../code-measure.ts';
import { syncStories } from '../http/code-routes.ts';
import { diffTokens, pullTokens, readRepoTokens } from '../repo-tokens.ts';
import { agentOrigin } from '../sync.ts';
import { errorMessage } from '../util.ts';
import { DESIGN_MD_FILE } from '../design-md.ts';
import { fileDesignMd } from './tools-design-md.ts';
import { dirname, join } from 'node:path';
import { assertUnlocked, fileIdArg, nextArtboardX, pageIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/** Code components: a person's own React components, from their repository, as layers. See code-projects.ts and code-build.ts. */

const LOOPBACK = new Set([undefined, '127.0.0.1', 'localhost', '::1']);
const FALLBACK_SIZE = { width: 320, height: 120 };

const propsArg = z.record(z.string(), z.unknown()).describe('Props as JSON, such as {"variant":"ghost","children":"Save"}. children is the text inside. Any prop the component takes can be set, also ones code_components_list does not show.');

function checkProps(props: Record<string, unknown>): Record<string, CodePropValue> {
  for (const [k, v] of Object.entries(props)) assertCodeProp(k, v);
  return props as Record<string, CodePropValue>;
}

function linkedProject(ctx: ToolContext, doc: BogenDoc, projectId?: string): CodeProject {
  const linked = doc.meta.get('codeProject') as { id?: unknown; name?: unknown } | undefined;
  const id = projectId ?? (typeof linked?.id === 'string' ? linked.id : undefined);
  if (!id) throw new Error('This file has no project linked for code components. Call code_project_link with the folder of the repository.');
  const project = ctx.app.codeProjects.get(id);
  if (!project) throw new Error(`The project ${typeof linked?.name === 'string' ? `"${linked.name}" ` : ''}(${id}) is not linked on this device. Call code_project_link with its folder here.`);
  return project;
}

async function fit(ctx: ToolContext, ref: CodeRef): Promise<{ width: number; height: number; measured: boolean; note?: string }> {
  try {
    return { ...(await measureCode(ctx.app.renderer, ctx.app.codeBuilder, ref)), measured: true };
  } catch (e) {
    return { ...FALLBACK_SIZE, measured: false, note: `Not measured (${errorMessage(e)}), so it got a default size. Set width and height with layer_style.` };
  }
}

export function registerCodeTools(define: ToolDefiner): void {
  define('code_project_link', { description: `Link the folder of the person's own web project (React for now, such as Vite + React + Tailwind) to a file, so that its components can be placed on the canvas with code_component_insert and render with the project's real CSS. The folder is read on this device only: the project's code is bundled and runs in a sandboxed frame, never in Bogen itself, and the document keeps only an id. Tailwind 4 CSS is compiled; Tailwind plugins and JS configs are left out.` }, {
    dir: z.string().min(1).max(1000).describe('Absolute path of the project folder, the one with package.json.'),
    file_id: fileIdArg,
  }, async ({ dir, file_id }, ctx) => {
    if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('Projects can only be linked on a server that listens on this machine alone.');
    const room = await ctx.room(file_id);
    const project = await ctx.app.codeProjects.link(dir);
    ctx.write(room, () => room.doc.meta.set('codeProject', { id: project.id, name: project.name }));
    const components = await ctx.app.codeProjects.components(project);
    return { project: { id: project.id, name: project.name, dir: project.dir }, components: components.length, examples: components.slice(0, 12).map((c) => `${c.display} (${c.file})`), next: 'code_components_list shows them with their props.' };
  });

  define('code_components_list', { description: 'React components in the linked project, by module and export, with props read from their TypeScript types where that is clear: enum options, booleans, strings, numbers, node (children and the like, given as text). Pass file and name of one to code_component_insert.', readOnly: true }, {
    query: z.string().max(100).optional().describe('Only components whose name or path contains this.'),
    limit: z.number().int().min(1).max(500).default(100),
    file_id: fileIdArg,
  }, async ({ query, limit, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    const project = linkedProject(ctx, doc);
    const q = query?.toLowerCase();
    const all = (await ctx.app.codeProjects.components(project)).filter((c) => !q || c.display.toLowerCase().includes(q) || c.file.toLowerCase().includes(q));
    return { project: { id: project.id, name: project.name }, total: all.length, components: all.slice(0, limit) };
  });

  define('code_component_insert', { description: 'Place a component from the linked project on the canvas, rendered by the project\'s own code and CSS in a sandboxed frame, next to ordinary layers. Its size is measured from what it renders unless you give width and height. It exports as a usage, such as <Button variant="ghost">Save</Button>, in code_get and JSX exports. Change its props later with code_component_update; move and size it like any layer.' }, {
    module: z.string().min(1).max(500).describe('Path of the module in the project, from code_components_list, such as src/components/ui/button.tsx.'),
    name: z.string().regex(/^(default|[A-Za-z_$][\w$]*)$/).describe('The export, such as Button, or default.'),
    props: propsArg.default({}),
    parent_id: z.string().optional().describe('A frame. Default is the current page.'),
    index: z.number().int().min(0).optional(),
    x: z.number().optional().describe('Sets left in px.'),
    y: z.number().optional().describe('Sets top in px.'),
    width: z.number().min(1).max(10000).optional(),
    height: z.number().min(1).max(10000).optional(),
    layer_name: z.string().max(200).optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ module, name, props, parent_id, index, x, y, width, height, layer_name, page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const project = linkedProject(ctx, doc);
    ctx.app.codeProjects.modulePath(project, module);
    const known = (await ctx.app.codeProjects.components(project)).find((c) => c.file === module && c.name === name);
    const ref: CodeRef = { project: project.id, file: module, name, import: known?.import ?? ctx.app.codeProjects.importPath(project, module), props: checkProps(props) };
    const parent = parent_id ?? ctx.page(room, page_id);
    if (parent_id && !doc.pages.has(parent_id)) assertUnlocked(doc, [parent_id]);
    const size = width !== undefined && height !== undefined ? { width, height, measured: false } : await fit(ctx, ref);
    const style: Record<string, string> = { width: `${width ?? size.width}px`, height: `${height ?? size.height}px` };
    const onPage = doc.pages.has(parent);
    if (onPage || x !== undefined || y !== undefined) Object.assign(style, { position: 'absolute', left: `${x ?? (onPage ? nextArtboardX(doc, parent) : 0)}px`, top: `${y ?? 0}px` });
    const id = ctx.write(room, () => doc.insert(parent, { type: 'embed', name: layer_name ?? known?.display ?? name, style, code: ref }, index));
    ctx.touch([id]);
    const build = await ctx.app.codeBuilder.build(project, module).catch((e) => ({ error: errorMessage(e), warnings: [] as string[] }));
    return {
      id, size: { width: Number.parseFloat(style.width!), height: Number.parseFloat(style.height!) }, measured: size.measured, jsx: codeUsageJsx(ref),
      ...('note' in size && size.note ? { note: size.note } : {}),
      ...(known ? {} : { warning: `No export "${name}" was found in ${module} by reading it. It is placed anyway; check it with canvas_screenshot.` }),
      ...(build.error ? { build_error: build.error } : {}), ...(build.warnings.length ? { build_warnings: build.warnings } : {}),
    };
  });

  define('repo_canvas_open', { description: 'Open a repository\'s page as a canvas: a design branch inside this file named after the project and its Git branch (main stays as it is), a page with a capture of the person\'s running dev server at url and path, and an artboard of the project\'s components rendered by its own code. Design on that branch, then the person makes a pull request from the change. Bogen starts no program of the repository: the dev server must already be running. Needs code_project_link first, or dir.' }, {
    url: z.string().max(2000).optional().describe('The dev server, such as http://localhost:5173. Left out, only the components are placed.'),
    path: z.string().max(500).optional().describe('The route to capture, such as /pricing.'),
    width: z.number().int().min(320).max(2560).default(1440),
    components: z.number().int().min(0).max(40).default(12).describe('How many of the project\'s components to place. 0 places none.'),
    dir: z.string().min(1).max(1000).optional().describe('The project folder, to link it first.'),
    file_id: fileIdArg,
  }, async ({ url, path, width, components, dir, file_id }, ctx) => {
    if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('Repositories open only on a server that listens on this machine alone.');
    const room = await ctx.room(file_id);
    const { openRepoCanvas } = await import('../repo-canvas.ts');
    const conversationId = ctx.session.runId ? ctx.app.runs.conversationOf(ctx.session.runId) : undefined;
    ctx.wrote = true;
    const out = await openRepoCanvas(ctx.app, { fileId: room.id, ...(dir ? { dir } : {}), ...(url ? { url } : {}), ...(path ? { path } : {}), width, components, ...(conversationId ? { conversationId } : {}), by: ctx.agent, kind: 'agent', origin: agentOrigin(ctx.agent) });
    ctx.touch([out.capture?.nodeId, out.components.boardId].filter((id): id is string => Boolean(id)));
    ctx.pinBranch(room, out.branch.id);
    return { ...out, next: 'Design on this branch: change the capture or the components. The person makes a pull request from the change in the editor.' };
  });

  define('code_component_update', { description: 'Change the props of a code component layer. Props you leave out stay as they are; list names in remove to go back to the component\'s own default. fit: true measures the size again after the change.' }, {
    layer_id: z.string(),
    props: propsArg.default({}),
    remove: z.array(z.string().max(100)).max(100).default([]),
    fit: z.boolean().default(false),
    file_id: fileIdArg,
  }, async ({ layer_id, props, remove, fit: refit, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const node = doc.getNode(layer_id);
    if (!node?.code) throw new Error(`Layer ${layer_id} is not a code component. Place one with code_component_insert.`);
    if (node.virtual) throw new Error(`Layer ${layer_id} is inside an instance. Change it in the main.`);
    assertUnlocked(doc, [layer_id]);
    const patch: Record<string, CodePropValue | undefined> = { ...checkProps(props) };
    for (const k of remove) patch[k] = undefined;
    ctx.write(room, () => setCodeProps(doc, layer_id, patch));
    const ref = doc.getNode(layer_id)!.code!;
    let size: Awaited<ReturnType<typeof fit>> | undefined;
    if (refit) {
      size = await fit(ctx, ref);
      if (size.measured) ctx.write(room, () => doc.updateStyle(layer_id, { width: `${size!.width}px`, height: `${size!.height}px` }));
    }
    ctx.touch([layer_id]);
    return { id: layer_id, props: ref.props, jsx: codeUsageJsx(ref), ...(size ? { size: { width: size.width, height: size.height }, measured: size.measured, ...(size.note ? { note: size.note } : {}) } : {}) };
  });

  define('storybook_import', { description: 'Import the Storybook stories of the linked project: each component with stories becomes a variant set on a Storybook page, one main per story, each a code component with the story\'s args as its props, and the set gets props from args and argTypes. Stories are read as text, never run. Call it again to bring the set up to date; while the file is open Bogen also does that by itself when a story file changes. Place a story with instance_create and the set\'s name, and switch with the story variant.' }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const project = linkedProject(ctx, room.doc);
    const report = await syncStories(ctx.app, room.id, project, (fn) => ctx.write(room, fn));
    ctx.touch(report.components.flatMap((c) => [c.frame, ...c.stories.filter((s) => s.status !== 'removed').map((s) => s.id)]).slice(0, 200));
    return { ...report, next: report.components.length ? 'instance_create with component set to a set name places a story; component_get shows its props.' : 'No story file with a component was found. Story files end in .stories.tsx and name their component in the meta.' };
  });

  define('tokens_repo_diff', { description: 'The linked repository\'s design tokens next to this file\'s, by name: same, changed, only in the file, or only in the repository, with the values of each and per theme mode. Read from CSS variables (:root and mode blocks such as .dark), a Tailwind 4 @theme block, a Tailwind 3 config read as text, DTCG tokens.json files, and the YAML of a DESIGN.md. tokens_repo_pull takes the repository\'s values into the file. To push the file\'s tokens into the repository, the person opens a pull request from the Tokens panel.', readOnly: true }, {
    status: z.enum(['all', 'changed', 'file', 'repo', 'same']).default('all').describe('Only rows with this status. changed differs, file is only in the file, repo only in the repository.'),
    file_id: fileIdArg,
  }, async ({ status, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    const project = linkedProject(ctx, doc);
    const repo = await readRepoTokens(ctx.app.codeProjects, project);
    const rows = diffTokens(doc.getTokens(), repo.tokens);
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return { project: project.name, sources: repo.sources, counts: { same: count('same'), changed: count('changed'), file: count('file'), repo: count('repo') }, rows: rows.filter((r) => status === 'all' || r.status === status).slice(0, 500), unclassified: repo.unclassified.slice(0, 50) };
  });

  define('tokens_repo_pull', { description: 'Take tokens from the linked repository into this file, with their theme mode values, as one undo step: all of them, or the names you give. A token the file has gets the repository\'s value. A DESIGN.md in the repository counts as a token source too. Call tokens_repo_diff first to see what changes. With design_md true the result also holds the file\'s tokens afterwards as a DESIGN.md and where it goes, next to the main token file, for you to write with your own file tools.' }, {
    names: z.array(z.string().max(120)).max(2000).optional().describe('Only these tokens, without the leading dashes.'),
    design_md: z.boolean().default(false).describe('Also return the tokens as a DESIGN.md, with the path next to the token file it belongs beside.'),
    file_id: fileIdArg,
  }, async ({ names, design_md, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const project = linkedProject(ctx, room.doc);
    const repo = await readRepoTokens(ctx.app.codeProjects, project);
    const pulled = ctx.write(room, () => pullTokens(room.doc, repo.tokens, names, undefined));
    const out: Record<string, unknown> = { pulled, missing: (names ?? []).filter((n) => !repo.tokens.some((t) => t.name === n)) };
    if (design_md) {
      const own = repo.sources.find((s) => s.format === 'design-md')?.file;
      const main = repo.sources.find((s) => s.writable && s.format !== 'design-md')?.file;
      const rel = own ?? [main && dirname(main) !== '.' ? dirname(main) : '', DESIGN_MD_FILE].filter(Boolean).join('/');
      out.design_md = { path: join(project.dir, rel), relative: rel, exists: Boolean(own), text: await fileDesignMd(ctx, room.doc, ctx.app.storage.get(room.id)?.name ?? 'Design'), next: own ? 'The repository has this DESIGN.md already: change only its YAML, or keep its prose when you replace it.' : 'Write it with your own file tools. No tool writes into a repository.' };
    }
    return out;
  });
}
