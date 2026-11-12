import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { currentBranchId, MAIN_BRANCH } from '@bogen/core';
import {
  addThemeDisplays, assignDisplayArtwork, barFonts, detectDisplays, displayChoices, displayRuntime, themeDisplays, wallpaperStates,
  adoptTheme, applyState, assertFileInstallable, collectionAvailable, currentThemeName, isThemeCandidate, applyTheme, createThemeFile, hostTarget, isThemeChoice, mobilePackage, projectStatus, exportTheme, installTheme, listThemes, onOmarchy, screenSizes, setThemeMeta, tarGz, themeEnv, themeInfo, themeMeta, undoApply, writeThemeTo,
} from '../omarchy-themes.ts';
import { collectionEntries, collectionThumb } from '../omarchy-collection.ts';
import { auditFiles, auditFolders, currentRuntime } from '../omarchy-theme-audit.ts';
import { consolidate, consolidationPlan } from '../theme-consolidate.ts';
import { pluginStatus, portraitEnv, screensFor } from '../omarchy-portrait-runtime.ts';
import { themeProjects } from '../theme-projects.ts';
import { HttpError } from '../util.ts';
import type { RouteTools } from './agent-routes.ts';
import type { BogenServer } from './server.ts';

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const ThemeName = z.string().trim().min(1).max(64);
const Slug = z.string().regex(/^[a-z0-9_][a-z0-9._+-]{0,63}$/);
const Mode = z.enum(['dark', 'light']);
const Target = z.enum(['desktop', 'mobile']);
const PresetId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const Create = z.object({
  from: Slug.optional(), name: ThemeName.optional(), target: Target.optional(), profile: z.enum(['komodo']).optional(),
  /** Continue this theme file. */
  file_id: Id.optional(),
  /** Start from a preset of the Bogen collection, or open the project started from it. */
  preset: PresetId.optional(),
  /** A separate new theme, on purpose. */
  new_project: z.boolean().optional(),
  /** Deprecated: the same as new_project. */
  copy: z.boolean().optional(),
});
const Adopt = z.object({ name: ThemeName, target: Target });
const Patch = z.object({ name: ThemeName.optional(), mode: Mode.optional(), icons: z.string().regex(/^[\w.+-]{1,64}$/).nullable().optional() });
const Export = z.discriminatedUnion('to', [
  z.object({ to: z.literal('tar') }),
  z.object({ to: z.literal('files') }),
  z.object({ to: z.literal('folder'), dir: z.string().min(1).max(4000), git: z.boolean().optional() }),
]);
const Install = z.object({ overwrite: z.boolean().optional() });
const DisplayRequest = z.union([
  z.object({ preset: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
  z.object({ monitor: z.string().regex(/^[\w.:-]{1,32}$/) }).strict(),
  z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) }).strict(),
]);
const AddDisplays = z.object({ add: z.array(DisplayRequest).min(1).max(8) });
const Artwork = z.object({ aspect: z.string().regex(/^[\d.]{1,8}:[\d.]{1,8}$/), src: z.string().min(1).max(200), name: z.string().max(80).optional() });
const Apply = z.object({ name: Slug });
const ConsolidatePlan = z.object({ target: Id, sources: z.array(Id).min(1).max(11) });
const Consolidate = ConsolidatePlan.extend({ plan_hash: z.string().regex(/^[0-9a-f]{24}$/), by: z.string().trim().min(1).max(80).default('person') });

/**
 * `/api/omarchy/themes` and `/api/omarchy/theme/:fileId/*`: theme files, their export, install and apply. Everything
 * that reads the person's themes or writes to the disk is for a direct request from this machine only; the whole
 * `/api/omarchy` prefix is closed to the tailnet and the phone besides (`isLocalOnlyPath`).
 */
export async function omarchyThemeRoutes(app: BogenServer, req: IncomingMessage, res: ServerResponse, parts: string[], tools: RouteTools): Promise<boolean> {
  const [, b, c, d] = parts;
  const method = req.method ?? 'GET';
  const { json, send, local } = tools;
  const env = themeEnv(app);
  const here = () => {
    if (!local(req)) throw new HttpError(403, 'Omarchy themes are only for a person at this machine.');
  };

  if (b === 'themes' && !c) {
    here();
    if (method === 'GET') {
      const on = onOmarchy(env);
      send(res, 200, { onOmarchy: on, host: hostTarget(env), themes: on ? listThemes(env) : [], apply: applyState(env), screens: on ? await screenSizes() : [] });
      return true;
    }
    if (method === 'POST') {
      const body = await json(req, Create);
      // Not a person's origin: a file made a moment ago is not one "changed while nobody had it open".
      // A theme that has a project goes back to it, with or without its name; new_project (or copy) makes a new one on purpose.
      const out = await createThemeFile(app, env, {
        ...(body.from ? { from: body.from } : {}), ...(body.name ? { name: body.name } : {}), ...(body.target ? { target: body.target } : {}), ...(body.profile ? { profile: body.profile } : {}),
        ...(body.file_id ? { fileId: body.file_id } : {}), ...(body.preset && !body.file_id ? { preset: body.preset } : {}),
        newProject: body.new_project === true || body.copy === true, origin: 'bogen:omarchy-theme',
      });
      // Several files could be the one meant: nothing was made, and the person picks.
      if (isThemeChoice(out)) send(res, 409, { needs_choice: true, choose: out.candidates, message: out.message, next: out.next });
      else send(res, out.reused ? 200 : 201, out);
      return true;
    }
  }

  if (b === 'library' && !c && method === 'GET') {
    // The theme library: Bogen's theme projects from the index (no theme is loaded for it), groups of files that look
    // like versions of one theme, and the installed themes with the projects of each.
    here();
    const on = onOmarchy(env);
    const host = hostTarget(env);
    const { projects, groups } = await themeProjects(app, projectStatus(env));
    const installed = on ? listThemes(env).map((t) => ({
      ...t,
      // The projects that install as this theme first, then those started from it.
      project_file_ids: [
        ...projects.filter((p) => p.target === host && p.slug === t.name),
        ...projects.filter((p) => p.target === host && p.slug !== t.name && p.from === t.name),
      ].map((p) => p.file_id),
    })) : [];
    send(res, 200, { onOmarchy: on, host, apply: applyState(env), current: currentThemeName(env), screens: on ? await screenSizes() : [], projects, groups, installed });
    return true;
  }

  if (b === 'collection' && method === 'GET' && !parts[4]) {
    // The Bogen collection: a few words and colours per preset, and on request one small picture. Nothing is made or
    // rendered here, and it is offered on an Omarchy desktop only.
    here();
    const available = collectionAvailable(env);
    if (!c) {
      send(res, 200, { available, presets: available ? collectionEntries() : [] });
      return true;
    }
    const orientation = d === 'landscape' || d === 'portrait' ? d : null;
    const thumb = available && orientation && /^[a-z0-9-]{1,40}$/.test(c) ? collectionThumb(c, orientation) : null;
    if (!thumb) throw new HttpError(404, 'There is no such picture in the Bogen collection here.');
    res.writeHead(200, {
      'Content-Type': thumb.mime, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff',
      // An SVG opened on its own runs nothing and loads nothing.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(await readFile(thumb.path));
    return true;
  }

  if (b === 'theme' && c) {
    here();
    const fileId = Id.parse(c);
    app.requireFile(fileId);
    if (!d && method === 'GET') {
      const room = await app.rooms.get(fileId);
      send(res, 200, { theme: await themeInfo(app, env, fileId), candidate: isThemeCandidate(room.doc) });
      return true;
    }
    if (!d && method === 'PATCH') {
      const body = await json(req, Patch);
      const room = await app.rooms.get(fileId);
      const before = themeMeta(room.doc)?.name;
      // On a branch the name is that version's: the file, and the project's identity in the index, stay main's.
      const onMain = currentBranchId(room.doc) === MAIN_BRANCH;
      const next = setThemeMeta(room.doc, body, 'person:editor');
      // The file keeps following the theme's name while it has the name Bogen gave it.
      const file = app.storage.get(fileId);
      if (onMain && before && next.name !== before && file?.name === `${before} · Omarchy theme`) app.renameFile(fileId, `${next.name} · Omarchy theme`);
      send(res, 200, { theme: await themeInfo(app, env, fileId) });
      return true;
    }
    if (d === 'displays' && !parts[4] && method === 'GET') {
      // The theme's displays, what each shape's composition is, and what can be added: presets and this machine's monitors.
      const room = await app.rooms.get(fileId);
      const meta = themeMeta(room.doc);
      const detected = await detectDisplays();
      const wallpapers = await wallpaperStates(app, room.doc, meta);
      send(res, 200, { displays: themeDisplays(room.doc, meta), wallpapers, ...displayChoices(room.doc, detected), runtime: displayRuntime(env, wallpapers, detected) });
      return true;
    }
    if (d === 'displays' && !parts[4] && method === 'POST') {
      // A person's click: previews of more displays added beside the design, as one step in the file's History.
      const body = await json(req, AddDisplays);
      const room = await app.rooms.get(fileId);
      const out = await addThemeDisplays(room.doc, { requests: body.add, detected: await detectDisplays(), glyphs: await barFonts() }, (fn) => room.doc.transact(fn, 'person:editor'));
      send(res, 200, { ...out, theme: await themeInfo(app, env, fileId) });
      return true;
    }
    if (d === 'displays' && parts[4] === 'artwork' && method === 'POST') {
      const body = await json(req, Artwork);
      const room = await app.rooms.get(fileId);
      const state = await assignDisplayArtwork(app, room.doc, body, (fn) => room.doc.transact(fn, 'person:editor'));
      send(res, 200, { wallpaper: state, theme: await themeInfo(app, env, fileId) });
      return true;
    }
    if (d === 'adopt' && method === 'POST') {
      // A file with the palette becomes a theme only on the person's choice of target.
      const body = await json(req, Adopt);
      const room = await app.rooms.get(fileId);
      adoptTheme(room.doc, body, 'person:editor');
      send(res, 200, { theme: await themeInfo(app, env, fileId) });
      return true;
    }
    if (d === 'export' && method === 'POST') {
      const body = await json(req, Export);
      const theme = await exportTheme(app, env, fileId);
      if (body.to === 'tar') {
        // A mobile theme downloads as its phone package, install.sh included.
        const pkg = theme.target === 'mobile' ? mobilePackage(theme) : null;
        const bytes = pkg ? tarGz(pkg.files, pkg.root) : tarGz(theme.files, theme.slug);
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${pkg?.root ?? theme.slug}.tar.gz"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
        return true;
      }
      if (body.to === 'files') {
        send(res, 200, { name: theme.name, slug: theme.slug, generated: theme.generated, problems: theme.problems, files: theme.files.map((f) => ({ path: f.path, data: Buffer.from(f.bytes).toString('base64') })) });
        return true;
      }
      // A path typed in the editor may start at the home folder, as a shell would read it.
      const out = await writeThemeTo(theme, body.dir.trim().replace(/^~(?=\/|$)/, env.home), { git: body.git });
      send(res, 201, { ...out, generated: theme.generated, problems: theme.problems });
      return true;
    }
    if (d === 'install' && method === 'POST') {
      const body = await json(req, Install);
      await assertFileInstallable(app, env, fileId);
      const theme = await exportTheme(app, env, fileId);
      const out = await installTheme(env, theme, { overwrite: body.overwrite });
      send(res, 201, { ...out, generated: theme.generated, problems: theme.problems });
      return true;
    }
  }

  if (b === 'portrait' && method === 'GET' && (!c || c === 'audit')) {
    // Read-only: the portrait background plugin, the current theme's runtime map and each monitor's outcome, or the
    // audit of every theme. Installing, enabling and upgrading are for a person at a terminal (bogen omarchy portrait).
    here();
    if (c === 'audit') {
      send(res, 200, { folders: auditFolders(env), files: await auditFiles(app, env) });
      return true;
    }
    const penv = portraitEnv({ ...process.env, HOME: env.home, OMARCHY_PATH: env.omarchyPath });
    const current = currentRuntime(env);
    send(res, 200, { plugin: pluginStatus(penv), current: { theme: currentThemeName(env), ...current }, screens: screensFor(current, await detectDisplays()) });
    return true;
  }

  if (b === 'consolidate' && method === 'POST') {
    // Legacy copies of one theme brought into the project the person chose, as branches. `plan` only reads; carrying
    // it out needs the plan's hash, so what was reviewed is what happens (theme-consolidate.ts).
    here();
    if (c === 'plan') {
      const body = await json(req, ConsolidatePlan);
      send(res, 200, await consolidationPlan(app, body.target, body.sources));
      return true;
    }
    if (!c) {
      const body = await json(req, Consolidate);
      send(res, 200, await consolidate(app, body.target, body.sources, { planHash: body.plan_hash, by: body.by }));
      return true;
    }
  }

  if (b === 'apply' && !c && method === 'POST') {
    here();
    const { name } = await json(req, Apply);
    send(res, 200, await applyTheme(env, name));
    return true;
  }
  if (b === 'undo-apply' && !c && method === 'POST') {
    here();
    send(res, 200, await undoApply(env));
    return true;
  }
  return false;
}
