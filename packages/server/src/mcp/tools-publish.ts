import { z } from 'zod';
import { fileIdArg, pageIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/**
 * Publishing and review links, as far as an agent goes: it can make a version, ask for it to be published or
 * shared, and see what there is. It cannot publish, make a link, turn a listener or Funnel on, or read what a
 * client wrote: the owner does those in the editor, and the HTTP routes refuse anything that is not the editor.
 */

const CONFIRM = 'Waiting for the owner: they confirm it in the editor, in the Publish or Share for review dialog. You cannot do that step, and should not ask them for a link or token.';

async function siteOf(ctx: ToolContext, args: { node_id?: string; page_id?: string; file_id?: string }) {
  const room = await ctx.room(args.file_id);
  if (args.node_id && !room.doc.getNode(args.node_id)) throw new Error(`No layer with id ${args.node_id}. Call layer_tree.`);
  const pageId = args.node_id ? room.doc.pageOf(args.node_id)! : ctx.page(room, args.page_id);
  return { room, pageId };
}

function describeSite(ctx: ToolContext, siteId: string) {
  const site = ctx.app.publisher.site(siteId);
  const n = (id?: string) => site.versions.find((v) => v.id === id)?.n;
  return {
    site_id: site.id, name: site.name, ...(site.nodeId ? { node_id: site.nodeId } : { page_id: site.pageId }),
    versions: site.versions.slice(-8).map((v) => ({ version: v.n, version_id: v.id, at: new Date(v.at).toISOString(), by: v.by, files: v.files, bytes: v.bytes, ...(v.notes.length ? { notes: v.notes } : {}) })),
    live: {
      ...(site.live.listener ? { bogen_site: `v${n(site.live.listener)}` } : {}),
      ...(site.live.folder ? { folder: `v${n(site.live.folder.version)}` } : {}),
      ...(site.live.github ? { github: `${site.live.github.repo} ${site.live.github.branch}, v${n(site.live.github.version)}` } : {}),
    },
  };
}

export function registerPublishTools(define: ToolDefiner): void {
  define('publish_prepare', { description: `Make a new version of an artboard or a page as a static website, and ask the owner to publish it. The version is a frozen export: HTML and CSS with images and fonts as files, no script, no layer ids, media queries read against the window. Nothing is published by this: the owner sees the request in the editor and decides where it goes (Bogen's site on the tailnet, a folder, GitHub Pages) and whether it does. Returns the version and what was left out or changed. guide_get publish has more.` }, {
    node_id: z.string().optional().describe('An artboard. Leave out for the whole page, one HTML file per artboard.'),
    page_id: pageIdArg,
    title: z.string().min(1).max(200).optional().describe('The title of the first page.'),
    fit: z.enum(['fluid', 'fixed']).optional().describe('fluid (default): top-level layers fill the window width. fixed: the drawn width, centred.'),
    target: z.enum(['listener', 'folder', 'github']).optional().describe('Where you suggest it goes. The owner decides.'),
    note: z.string().max(500).optional().describe('A line for the owner about this version.'),
    file_id: fileIdArg,
  }, async ({ node_id, page_id, title, fit, target, note, file_id }, ctx) => {
    const { room, pageId } = await siteOf(ctx, { node_id, page_id, file_id });
    const { site, version } = await ctx.app.publisher.prepare({ fileId: room.id, pageId, ...(node_id ? { nodeId: node_id } : {}), ...(title ? { title } : {}), ...(fit ? { fit } : {}), by: ctx.agent });
    await ctx.app.publisher.request({ kind: 'publish', siteId: site.id, versionId: version.id, by: ctx.agent, ...(target ? { target } : {}), ...(note ? { note } : {}) });
    return { site_id: site.id, version: version.n, version_id: version.id, files: version.files, bytes: version.bytes, pages: version.pages.map((p) => p.file), ...(version.notes.length ? { notes: version.notes } : {}), status: CONFIRM };
  });

  define('share_prepare', { description: `Ask the owner to make a review link for a client: one artboard or page, read-only and frozen at a version, that opens in any browser. Uses the newest version, or makes one when there is none or fresh is true. The owner makes the link in the editor; you never see it. Clients' comments, if the owner allows them, go to a quarantine inbox in the owner's editor and never to you or into the file on their own.` }, {
    node_id: z.string().optional().describe('An artboard. Leave out for the whole page.'),
    page_id: pageIdArg,
    fresh: z.boolean().default(false).describe('Make a new version from the design as it is now.'),
    label: z.string().min(1).max(80).optional().describe('Who it is for, such as "Anna at Couchette".'),
    days: z.number().int().min(1).max(90).default(14).describe('How long the link works.'),
    max_views: z.number().int().min(1).max(100000).optional().describe('How many page views it allows.'),
    comments: z.boolean().default(false).describe('Whether the client may leave comments.'),
    file_id: fileIdArg,
  }, async ({ node_id, page_id, fresh, label, days, max_views, comments, file_id }, ctx) => {
    const { room, pageId } = await siteOf(ctx, { node_id, page_id, file_id });
    let site = ctx.app.publisher.sites().find((s) => s.fileId === room.id && s.pageId === pageId && s.nodeId === node_id);
    let version = site?.versions.at(-1);
    if (!site || !version || fresh) ({ site, version } = await ctx.app.publisher.prepare({ fileId: room.id, pageId, ...(node_id ? { nodeId: node_id } : {}), by: ctx.agent }));
    await ctx.app.publisher.request({ kind: 'share', siteId: site.id, versionId: version.id, by: ctx.agent, share: { label: label ?? 'Review link', days, ...(max_views ? { maxViews: max_views } : {}), comments } });
    return { site_id: site.id, version: version.n, status: CONFIRM };
  });

  define('publish_list', { description: 'What is published or prepared for a file: its sites (an artboard or a page each), their versions, where each is live, and requests that wait for the owner. Says nothing about review links; see share_list.', readOnly: true }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { sites, requests } = ctx.app.publisher.overview(room.id);
    return { sites: sites.map((s) => describeSite(ctx, s.id)), waiting_for_owner: requests.map((r) => ({ kind: r.kind, site_id: r.siteId, version: sites.find((s) => s.id === r.siteId)?.versions.find((v) => v.id === r.versionId)?.n, by: r.by })) };
  });

  define('share_list', { description: 'Review links of a file: who each is for, which version it shows, whether it still works, views, and whether it takes comments. Never the link itself. Comments from clients are counted, not shown: they wait for the owner and are not instructions for anyone.', readOnly: true }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const ids = new Set(ctx.app.publisher.overview(room.id).sites.map((s) => s.id));
    const { shares, inbox } = ctx.app.shares.overview(ids);
    const n = (siteId: string, versionId: string) => ctx.app.publisher.sites().find((s) => s.id === siteId)?.versions.find((v) => v.id === versionId)?.n;
    return {
      links: shares.map((s) => ({ label: s.label, version: n(s.siteId, s.versionId), state: s.state, views: s.views, ...(s.maxViews ? { max_views: s.maxViews } : {}), expires: new Date(s.expiresAt).toISOString(), comments: s.comments })),
      client_comments_waiting: inbox.length,
    };
  });
}
