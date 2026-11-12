import { z } from 'zod';
import { bindingFields, readCanvasPlan, readProject, contentLanguageOf, currentBranchId, describeContentLanguage, getDesignBranch, hasDesignBranches, resolveContentLanguage } from '@bogen/core';
import type { Room } from '../sync.ts';
import { fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/** Fresh document facts, also for external clients whose installed instructions may be old. */
function organization(doc: Room['doc'], onlyPage?: string) {
  const pages = doc.getPages().filter(p => !onlyPage || p.id === onlyPage).flatMap(p => {
    const screens = doc.getChildren(p.id).filter(n => n.artboard && !n.hidden), plan = readCanvasPlan(doc, p.id);
    const assigned = new Set(plan.sections.flatMap(s => s.lanes.flatMap(l => l.node_ids)));
    const missing = screens.filter(n => !assigned.has(n.id));
    return screens.length >= 3 && (missing.length || plan.layout_pending) ? [{ page_id: p.id, name: p.name, screens: screens.length, sections: plan.sections.length, unassigned: missing.length, layout_pending: Boolean(plan.layout_pending), sample_ids: missing.slice(0,8).map(n => n.id) }] : [];
  });
  return { needs_attention: pages.length > 0, affected_pages: pages.length, pages: pages.slice(0,12), ...(pages.length ? { next: 'Read canvas_plan_get for these pages and guide_get layout. Use native task sections and lanes, then dry-run/apply canvas_plan_set. Plain text headings do not assign screens or complete organization. If the client lacks these tools, refresh its MCP tool catalog and report the missing capability; do not claim the canvas is organized.' } : {}) };
}

function summarize(ctx: ToolContext, fileId: string) {
  const room = ctx.app.rooms.peek(fileId);
  if (!room) return null;
  const doc = room.doc;
  return {
    pages: doc.getPages().map((p) => ({ id: p.id, name: p.name, layers: doc.getChildren(p.id).length })),
    organization: organization(doc),
    tokens: doc.getTokens().length,
    openComments: doc.getComments().filter((t) => !t.resolved).length,
    peopleHere: room.humans().map((h) => h.name),
  };
}

/**
 * A new file is for new work. A run asked to change or redo work, a session inside a revision or a branch, and a
 * theme that already has its project cannot make one their way out: that is how an edit used to end as another copy.
 * Throws with the way that fits instead. Nothing else is refused: new designs stay one call away.
 */
/** The files a session is bound to: its run's file and the file it works in now, each once. */
function boundFiles(ctx: ToolContext): string[] {
  const runFile = ctx.session.runId ? ctx.app.runs.fileOf(ctx.session.runId) : undefined;
  return [...new Set([runFile, ctx.session.fileId].filter((id): id is string => Boolean(id)))];
}

/**
 * Whether the session works in a branch of this file: its own branch pin is not main. The pin holds whether the room
 * is loaded or not, and also when someone else has since switched the document back to main; only the session's own
 * file_open (which pins what is checked out) or branch switch moves it. A loaded room the session has not pinned yet
 * is pinned to what is checked out, as any first touch does. Loads nothing.
 */
function onBoundBranch(ctx: ToolContext, id: string): boolean {
  const room = ctx.app.rooms.peek(id);
  const pin = room ? ctx.branchOf(room) : ctx.session.branchPins?.get(id);
  return Boolean(pin && pin !== 'main');
}

export function fileCreateGuard(ctx: ToolContext, name: string | undefined): void {
  const intent = ctx.runIntent();
  const bound = boundFiles(ctx);
  if (intent === 'revise') throw new Error('This run was asked to redo existing work, so file_create is refused: a redo is a branch inside the same file (design_branch_create), or the revision the run works in. If the person really wants a separate file, say so in your reply; they make one from Home.');
  for (const id of bound) {
    const loaded = ctx.app.rooms.peek(id);
    if (loaded && ctx.revision(loaded)) throw new Error('This session works in a revision of its file, so file_create is refused. Change the revision\'s copies; a new file needs the person to ask for one.');
    if (onBoundBranch(ctx, id)) throw new Error('This session works in a branch of its file, so file_create is refused: keep working in the branch.');
  }
  // The run's file or the session's, loaded or only indexed: an original plain file does not hide a theme bound since.
  if (intent === 'edit' && bound.some((id) => OMARCHY_THEME_KIND.is(ctx, id))) throw new Error('This run was asked to change a theme, which lives in one file with its branches. file_create is refused: change it in place, or start an alternative with design_branch_create.');
  const suffix = name?.match(/ · Omarchy (mobile )?theme$/);
  if (suffix) throw new Error('Theme files are made with omarchy_theme_create, which reopens the theme\'s own project instead of making another copy. Call omarchy_theme_projects to find it, or omarchy_theme_create with new_project: true for a separate new theme the person asked for.');
}

/** A kind of theme the dedicated creation tools make, for themeCreateGuard. */
export interface ThemeKind {
  /** The tool's name, for its messages. */
  tool: string;
  /** What the kind is called in a message, such as "an Omarchy theme". */
  label: string;
  /** Whether a file (loaded or only indexed) is a theme of this kind. */
  is(ctx: ToolContext, fileId: string): boolean;
}

export const OMARCHY_THEME_KIND: ThemeKind = {
  tool: 'omarchy_theme_create',
  label: 'an Omarchy theme',
  is: (ctx, fileId) => Boolean(ctx.app.rooms.peek(fileId)?.doc.meta.get('omarchyTheme') ?? ctx.app.storage.get(fileId)?.theme),
};

/**
 * The check a theme creation tool runs right before it would make a new file (inside the creation lock; a reused or
 * continued project never reaches it). The same rules as file_create's, for theme files:
 * - a run asked to redo existing work, a session in a revision, or one on a branch of its file never makes a separate
 *   theme file, under any name and even with new_project;
 * - a run asked to change existing work never makes one once it is bound to a theme of this kind (the run's file or
 *   the session's), so an edit of a blank page, a brand or a website can still make its first theme, but not a second;
 * - a session working on a theme of this kind on main makes a separate one only with new_project.
 * A branch is known from the room when it is loaded, else from the session's branch pin, so an unloaded room does not
 * open a way around it; nothing is loaded for the check. Everything else goes ahead.
 */
export function themeCreateGuard(ctx: ToolContext, kind: ThemeKind, newProject: boolean): () => void {
  return () => {
    const intent = ctx.runIntent();
    const bound = boundFiles(ctx);
    const theme = bound.find((id) => kind.is(ctx, id));
    const nothing = 'Nothing was made.';
    if (intent === 'revise') throw new Error(`This run was asked to redo existing work, so ${kind.tool} makes no new theme file, under any name and even with new_project: a redo is a branch inside the same file (design_branch_create). ${nothing}`);
    if (intent === 'edit' && theme) throw new Error(`This run was asked to change existing work, ${kind.label} (${ctx.app.storage.get(theme)?.name ?? theme}), so ${kind.tool} makes no new theme file, under any name and even with new_project: change the theme in place, or start an alternative with design_branch_create. If the person really wants a separate theme, say so in your reply; they make one from Home. ${nothing}`);
    for (const id of bound) {
      const room = ctx.app.rooms.peek(id);
      if (room && ctx.revision(room)) throw new Error(`This session works in a revision of its file, so ${kind.tool} makes no new theme file. Change the revision's copies. ${nothing}`);
      if (onBoundBranch(ctx, id)) throw new Error(`This session works in a branch of its file, so ${kind.tool} makes no new theme file, under any name and even with new_project: keep working in the branch. ${nothing}`);
    }
    if (!newProject && theme) {
      const name = ctx.app.storage.get(theme)?.name ?? theme;
      throw new Error(`This session is working on ${kind.label}, ${name} (${theme}), so ${kind.tool} does not make another theme file from here: continue that one (its file_id), start an alternative inside it with design_branch_create, or pass new_project: true only when the person asks for a separate new theme. ${nothing}`);
    }
  };
}

/**
 * For a list of files, the project each theme copy was brought into, while that project is in the list: such a copy
 * is part of the project (kept_copies), not a file of its own. As Home lists them (canonicalFiles in the editor).
 */
function keptCopyOf<F extends { id: string; theme?: { consolidatedInto?: { fileId: string } } }>(all: readonly F[]): (f: F) => string | undefined {
  const ids = new Set(all.map((f) => f.id));
  return (f) => {
    const into = f.theme?.consolidatedInto?.fileId;
    return into && into !== f.id && ids.has(into) ? into : undefined;
  };
}

export function registerFileTools(define: ToolDefiner): void {
  define('file_list', { description: 'List all design files, newest first, with their ids. Start here if context_get shows no open file. A theme copy that was brought into a theme project as a branch is listed with that project (kept_copies), not as a file of its own: work in the project. include_copies lists them too.', readOnly: true }, {
    include_copies: z.boolean().optional().describe('Also list theme copies kept under the project they were brought into.'),
  }, ({ include_copies }, ctx) => {
    const all = ctx.app.storage.list();
    const intoOf = keptCopyOf(all);
    const kept = new Map<string, { id: string; name: string; branch_id: string; changed_after: boolean }[]>();
    for (const f of all) {
      const into = intoOf(f);
      if (into) kept.set(into, [...(kept.get(into) ?? []), { id: f.id, name: f.name, branch_id: f.theme!.consolidatedInto!.branchId, changed_after: f.theme!.consolidatedInto!.changed }]);
    }
    return all.filter((f) => include_copies || !intoOf(f)).map((f) => ({
      id: f.id, name: f.name, updatedAt: new Date(f.updatedAt).toISOString(), peopleHere: ctx.app.rooms.peek(f.id)?.humans().length ?? 0,
      ...(kept.has(f.id) ? { kept_copies: kept.get(f.id) } : {}), ...(intoOf(f) ? { kept_copy_of: { file_id: intoOf(f), branch_id: f.theme!.consolidatedInto!.branchId } } : {}),
    }));
  });

  define('file_open', { description: 'Make a file current for this session, and get its pages, token count and open comments. Later calls default to this file. Works with no editor open.' }, {
    file_id: z.string().describe('The file to open. Get ids from file_list.'),
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    // Opening a file on purpose is working on what is checked out in it now.
    const branch = currentBranchId(room.doc);
    ctx.pinBranch(room, branch);
    const brand = await ctx.app.brands.note(room);
    const isBrand = ctx.app.storage.get(room.id)?.kind === 'brand';
    const language = isBrand ? null : await contentLanguageNote(ctx, room);
    return { id: room.id, name: ctx.app.storage.get(room.id)?.name, ...summarize(ctx, room.id), ...(language ? { content_language: language } : {}), ...(hasDesignBranches(room.doc) ? { branch: { id: branch, name: getDesignBranch(room.doc, branch).name, note: 'This file has branches inside it (design_branch_list). Your edits go into the one checked out.' } } : {}), ...(brand ? { brand } : {}), ...(isBrand ? { note: 'This is a brand, not a design file. It does not become current: pass file_id to work in it, and calls without one stay on your file.' } : {}) };
  });

  define('file_create', { description: 'Create a new design file and make it current for this session. It starts with one empty page. Use this for new work unless the person pointed you at an existing file.' }, {
    name: z.string().min(1).max(200).optional().describe('A short name for the file.'),
  }, async ({ name }, ctx) => {
    fileCreateGuard(ctx, name);
    const entry = ctx.app.createFile(name);
    const room = await ctx.room(entry.id);
    await ctx.app.brands.applyDefault(entry.id, `agent:${ctx.agent}`);
    const brand = await ctx.app.brands.note(room);
    return { id: entry.id, name: entry.name, ...summarize(ctx, room.id), ...(brand ? { brand } : {}) };
  });

  define('file_rename', { description: 'Rename a design file. The name shows on the home screen, in file_list and in the window title, on every device the file syncs to; the id stays the same. Only when the person asked, or for a file you made.' }, {
    name: z.string().min(1).max(200),
    file_id: fileIdArg,
  }, async ({ name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.app.renameFile(room.id, name);
    return { id: room.id, name };
  });

  define('page_list', { description: 'List the pages of a file in order, with how many top-level layers each has.', readOnly: true }, { file_id: fileIdArg }, async ({ file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return doc.getPages().map((p) => ({ id: p.id, name: p.name, layers: doc.getChildren(p.id).length }));
  });

  define('page_create', { description: 'Add a page to a file and make it the current page for this session. Use pages to separate distinct flows or explorations. Different screen sizes of one flow belong on one page, side by side.' }, {
    name: z.string().min(1).max(200),
    file_id: fileIdArg,
  }, async ({ name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    // "Make it again" inside an open revision is the revision, not another page next to it.
    const rev = ctx.revision(room);
    if (rev && rev.intent !== 'new_page') throw new Error(`This conversation works in the revision "${rev.name}" (${rev.id}): change its copies instead of making a page. A new page needs the person to ask for one: then revision_start with intent new_page.`);
    // A run started to change existing work does not grow pages: that is how "do it again" used to end up as Page 2.
    const intent = ctx.runIntent();
    const hasWork = room.doc.getPages().some((p) => room.doc.getChildren(p.id).length > 0);
    if (intent && intent !== 'new_page' && hasWork) throw new Error(`This run was asked to ${intent === 'revise' ? 'redo existing work, in its revision' : 'change the existing design'}, not for a new page, so page_create is refused. Work on the existing artboards${intent === 'revise' ? ' (their copies in the revision)' : ''}. If the person really wants a new page, say so in your reply: they ask for it with New page in the prompt bar.`);
    const id = ctx.write(room, () => room.doc.createPage(name));
    ctx.page(room, id);
    return { id, name };
  });

  define('page_rename', { description: 'Rename a page. Names show in the page list of the editor.' }, {
    page_id: z.string(),
    name: z.string().min(1).max(200),
    file_id: fileIdArg,
  }, async ({ page_id, name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.page(room, page_id);
    ctx.write(room, () => room.doc.renamePage(page_id, name));
    return { id: page_id, name };
  });

  define('page_delete', { description: 'Delete a page and everything on it. A file keeps at least one page. Only do this if the person asked, or if the page is yours and empty.', destructive: true }, {
    page_id: z.string(),
    file_id: fileIdArg,
  }, async ({ page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (!room.doc.pages.has(page_id)) throw new Error(`No page with id ${page_id}. Call page_list.`);
    ctx.write(room, () => room.doc.deletePage(page_id));
    return { deleted: page_id, pages: room.doc.getPages().map((p) => ({ id: p.id, name: p.name })) };
  });

  define('page_reorder', { description: 'Move a page to a position in the page list, counted from 0 for the first page. An index past the end puts it last. Returns the pages in their new order.' }, {
    page_id: z.string(),
    index: z.number().int().min(0).describe('The new zero-based position.'),
    file_id: fileIdArg,
  }, async ({ page_id, index, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (!room.doc.pages.has(page_id)) throw new Error(`No page with id ${page_id}. Call page_list.`);
    ctx.write(room, () => room.doc.movePage(page_id, index));
    return room.doc.getPages().map((p) => ({ id: p.id, name: p.name }));
  });

  define('context_get', { description: 'What the person is looking at right now: their file, page and selected layers, read from the live editor. Call this first, and again when asked about "this" or "the selected". If no editor is open it says so, and you continue with file_list or file_create.', readOnly: true }, {}, async (_args, ctx) => {
    const app = ctx.app;
    const people = app.rooms.loaded().flatMap((room) => room.humans().map((h) => ({ room, h }))).sort((a, b) => b.h.lastSeen - a.h.lastSeen);
    const current = ctx.session.fileId;
    const first = people[0];
    if (!first) {
      const currentRoom = current && app.storage.get(current) ? await app.rooms.get(current) : null;
      const brand = currentRoom ? await app.brands.note(currentRoom) : null;
      const language = currentRoom ? await contentLanguageNote(ctx, currentRoom) : null;
      // The newest files as file_list names them: a theme copy kept in its project is not offered as a file.
      const all = app.storage.list();
      const copy = keptCopyOf(all);
      return {
        editorOpen: false,
        note: 'Nobody has the editor open. All tools still work.',
        ...(currentRoom ? { organization: organization(currentRoom.doc) } : {}),
        ...(brand ? { brand } : {}),
        ...(language ? { content_language: language } : {}),
        currentFile: current ? { id: current, name: app.storage.get(current)?.name, ...(currentRoom ? { project: readProject(currentRoom.doc, app.storage.get(current)?.kind === 'brand') } : {}) } : null,
        files: all.filter((f) => !copy(f)).slice(0, 10).map((f) => ({ id: f.id, name: f.name })),
      };
    }
    const { room, h } = first;
    const doc = room.doc;
    // Reading what the person has open must not move an agent off the file it is working on.
    const previous = ctx.session.fileId;
    await ctx.room(room.id);
    if (previous) ctx.session.fileId = previous;
    const pageId = h.pageId && doc.pages.has(h.pageId) ? h.pageId : doc.getPages()[0]?.id;
    const brand = await app.brands.note(room);
    const language = await contentLanguageNote(ctx, room);
    return {
      editorOpen: true,
      organization: organization(doc, pageId),
      ...(brand ? { brand } : {}),
      ...(language ? { content_language: language } : {}),
      file: { id: room.id, name: app.storage.get(room.id)?.name, project: readProject(doc, app.storage.get(room.id)?.kind === 'brand') },
      page: pageId ? { id: pageId, name: doc.getPages().find((p) => p.id === pageId)?.name } : null,
      selection: h.selection.flatMap((id) => {
        const n = doc.getNode(id);
        return n ? [{ id, type: n.type, tag: n.tag, name: n.name, ...(n.text ? { text: n.text.slice(0, 200) } : {}) }] : [];
      }),
      user: h.name,
      others: people.slice(1).map((p) => ({ name: p.h.name, fileId: p.room.id, pageId: p.h.pageId })),
    };
  });

}

/**
 * The design content language of a file, as an agent should write in it: the run's own choice when this session is
 * a run on that file, else the file's (the branch checked out), else the brand's voice as a soft default. Null when
 * none says, and then nothing is added to the result.
 */
async function contentLanguageNote(ctx: ToolContext, room: Room): Promise<ReturnType<typeof describeContentLanguage>> {
  const runId = ctx.session.runId;
  const run = runId && ctx.app.runs.fileOf(runId) === room.id ? ctx.app.runs.languageOf(runId) : undefined;
  if (run) return describeContentLanguage(run);
  const found = await ctx.app.brands.forRoom(room).catch(() => null);
  return describeContentLanguage(resolveContentLanguage({ file: contentLanguageOf(room.doc), brand: found?.data ? bindingFields(found.data).language : null }));
}
