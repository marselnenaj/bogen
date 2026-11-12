import { cachedMains, libraryInfo, libraryLinks, publishLibrary, unlinkLibrary, unpublishLibrary, unpublishedChanges, type BogenDoc } from '@bogen/core';
import { z } from 'zod';
import { fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/** The copy of a library component in this file, by name, set, library main id or copy id. Links the library first when needed. */
export async function libraryMain(ctx: ToolContext, fileId: string | undefined, library: string, component: string, variant?: Record<string, string>): Promise<string> {
  const room = await ctx.room(fileId);
  const { doc } = room;
  const lib = await ctx.app.libraries.find(library);
  if (!libraryLinks(doc).some((l) => l.id === lib.id)) await ctx.app.libraries.link(room, lib.id, (fn) => ctx.write(room, fn));
  const copies = cachedMains(doc, lib.id).filter((c) => !c.meta.removed);
  const lower = component.trim().toLowerCase();
  const nodes = copies.map((c) => ({ ...c, node: doc.rawNode(c.id)! })).filter((c) => c.node);
  const bySet = nodes.filter((c) => c.node.component?.set?.toLowerCase() === lower);
  if (bySet.length) {
    if (!variant) return bySet[0]!.id;
    const scored = bySet.map((c) => ({ c, score: Object.entries(variant).filter(([k, v]) => c.node.component?.variant?.[k] === v).length })).sort((a, b) => b.score - a.score);
    return scored[0]!.c.id;
  }
  const hit = nodes.find((c) => c.id === component || c.meta.main === component) ?? nodes.find((c) => c.meta.name.toLowerCase() === lower);
  if (!hit) throw new Error(`The library ${lib.name} has no component "${component}". It has: ${nodes.map((c) => c.meta.name).join(', ') || 'none'}.`);
  return hit.id;
}

function linkedSummary(doc: BogenDoc) {
  return libraryLinks(doc).map((l) => ({ id: l.id, name: l.name, components: cachedMains(doc, l.id).map((c) => ({ id: c.id, name: c.meta.name, version: c.meta.version, ...(c.meta.removed ? { removed: true } : {}) })) }));
}

export function registerLibraryTools(define: ToolDefiner): void {
  define('library_publish', { description: `Offer this file's components to other files as a shared library, or publish what changed since the last time. Files that link it keep their own copy and see an update to accept, as in other design tools: nothing changes in them until someone accepts. Edits to a main are not offered before you publish again. A brand can publish its components too: pass the brand's id as file_id.` }, {
    name: z.string().min(1).max(200).optional().describe('What the library is called. Default: the name it had, else the file\'s.'),
    description: z.string().max(2000).optional(),
    unpublish: z.boolean().default(false).describe('Stop offering it. Files that use it keep their copies.'),
    file_id: fileIdArg,
  }, async ({ name, description, unpublish, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (unpublish) {
      ctx.write(room, () => unpublishLibrary(room.doc));
      return { unpublished: true };
    }
    const entry = ctx.app.storage.get(room.id);
    const out = ctx.write(room, () => publishLibrary(room.doc, { name: name ?? libraryInfo(room.doc)?.name ?? entry?.name, ...(description !== undefined ? { description } : {}), by: ctx.agent }));
    return { ...out, next: 'Other files link it with library_link, and place its components with instance_create library=...' };
  });

  define('library_list', { description: 'Shared libraries: those this file links, with their components and waiting updates, those it could link (a brand the file uses is marked), and whether this file publishes one itself with changes not yet published.', readOnly: true }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return ctx.app.libraries.status(room.id, room.doc);
  });

  define('library_link', { description: 'Link a shared library into this file, so that its components can be placed as instances that stay linked: when the library publishes a change, the file sees an update to accept, and overrides stay. The file keeps a copy, so instances show also where the library is missing. Then place one with instance_create component=<name> library=<library>.' }, {
    library: z.string().describe('An id or a name, from library_list.'),
    unlink: z.boolean().default(false).describe('Take the link away. Instances keep showing what they showed, from the file\'s copy.'),
    file_id: fileIdArg,
  }, async ({ library, unlink, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (unlink) {
      const link = libraryLinks(room.doc).find((l) => l.id === library || l.name.toLowerCase() === library.trim().toLowerCase());
      if (!link) throw new Error(`This file does not link "${library}". It links: ${libraryLinks(room.doc).map((l) => l.name).join(', ') || 'nothing'}.`);
      const out = ctx.write(room, () => unlinkLibrary(room.doc, link.id));
      return { unlinked: link.name, copies_kept_for_instances: out.kept, copies_removed: out.removed };
    }
    const { library: lib } = await ctx.app.libraries.link(room, library, (fn) => ctx.write(room, fn));
    return { linked: lib.name, id: lib.id, components: linkedSummary(room.doc).find((l) => l.id === lib.id)?.components ?? [], next: `instance_create component=<name> library="${lib.name}"` };
  });

  define('library_updates', { description: 'What the libraries this file links have published since the file took them: components changed, new or removed, with versions and how many instances each touches. Accept with library_accept.', readOnly: true }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { linked } = await ctx.app.libraries.status(room.id, room.doc);
    return { libraries: linked.map((l) => ({ id: l.id, name: l.name, missing: l.missing, updates: l.updates.map(({ lib: _lib, ...u }) => u) })) };
  });

  define('library_accept', { description: 'Accept updates of a linked library, all or the named components, with the library components they show. Instances follow and keep their overrides; an override of a layer the library removed stays stored and shows nothing. One undo step.' }, {
    library: z.string().optional().describe('An id or a name. Default: every linked library.'),
    components: z.array(z.string()).max(500).optional().describe('Names or ids. Default: all of them.'),
    file_id: fileIdArg,
  }, async ({ library, components, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const links = libraryLinks(room.doc).filter((l) => !library || l.id === library || l.name.toLowerCase() === library.trim().toLowerCase());
    if (!links.length) throw new Error(`${library ? `This file does not link "${library}".` : 'This file links no library.'} library_list shows what it links and what it could link; library_link links one.`);
    const out = [];
    for (const link of links) {
      const done = await ctx.app.libraries.accept(room, link.id, components, (fn) => ctx.write(room, fn));
      out.push({ library: link.name, accepted: done.accepted.map((u) => ({ name: u.name, status: u.status, ...(u.from ? { from: u.from } : {}), ...(u.to ? { to: u.to } : {}), instances: u.instances })), overrides: done.overrides });
    }
    return { results: out };
  });
}

/** Whether a file publishes a library with changes still to publish, for hints after edits to mains. */
export function pendingLibraryChanges(doc: BogenDoc): number {
  return libraryInfo(doc) ? unpublishedChanges(doc).length : 0;
}
