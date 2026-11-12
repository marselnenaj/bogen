import { z } from 'zod';
import { currentBranchId } from '@bogen/core';
import { DISPLAY_PRESETS } from '../omarchy-displays.ts';
import {
  addThemeDisplays, assertFileInstallable, assignDisplayArtwork, barFonts, createThemeFile, detectDisplays, displayChoices, displayRuntime, DISPLAY_RUNTIME_NOTE, exportTheme, installTheme, isThemeChoice, listThemes, onOmarchy, projectStatus,
  themeDisplays, themeEnv, themeMeta, wallpaperStates, writeThemeTo,
} from '../omarchy-themes.ts';
import { themeProjects } from '../theme-projects.ts';
import { fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';
import { OMARCHY_THEME_KIND, themeCreateGuard } from './tools-files.ts';

/** What counts as a finished portrait composition, said to every agent that lists them. */
const DONE_MEANS = 'artwork (a picture of exactly this ratio) or composed (layers someone made for this shape). The quiet placeholder and the palette arcs of older files are needs-design however they are recoloured; never report a theme\'s portrait as done while list says needs-design, mismatch, unverified or missing.';

/** Omarchy themes: designed in a file, written as a theme folder, installed. Applying one is the person's click. */

const LOOPBACK = new Set([undefined, '127.0.0.1', 'localhost', '::1']);

function onThisMachine(ctx: ToolContext): void {
  // A theme reads and writes the person's own folders, which a team server's agents have no business with.
  if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('Omarchy themes work on a server that listens on this machine alone.');
}

export function registerOmarchyTools(define: ToolDefiner): void {
  define('omarchy_theme_list', { description: 'The Omarchy themes installed on this machine, stock and the person\'s own, with their mode, a few colours, how many backgrounds each has and which is in use. Use a name as from in omarchy_theme_create.', readOnly: true }, {}, (_args, ctx) => {
    onThisMachine(ctx);
    const env = themeEnv(ctx.app);
    if (!onOmarchy(env)) return { themes: [], note: 'This machine has no Omarchy.' };
    return { themes: listThemes(env).map((t) => ({ name: t.name, title: t.title, source: t.source, mode: t.mode, swatches: t.swatches, backgrounds: t.backgrounds, current: t.current })) };
  });

  define('omarchy_theme_projects', { description: 'The Bogen theme projects on this machine: one file per logical theme, with its name, target (desktop or mobile) and profile, the installed theme it started from (from), its project id, folder, whether it is a draft, installed or in use, and its branches (versions inside the same file: the checked-out one and the open ones). groups lists files that look like versions of one theme (same name, target and starting theme, or copies of one project), for the person to consolidate; nothing is merged automatically. Read this before omarchy_theme_create to find the project to continue, and continue it with its file_id. Read only: nothing is loaded or changed.', readOnly: true }, {}, async (_args, ctx) => {
    onThisMachine(ctx);
    const env = themeEnv(ctx.app);
    const { projects, groups, unindexed } = await themeProjects(ctx.app, projectStatus(env));
    return {
      projects, groups, ...(unindexed ? { unindexed, unindexed_note: `${unindexed} older files are not indexed yet; call again to read more.` } : {}),
      next: 'To work on one of these, call omarchy_theme_create with its file_id (or file_open). For an alternative or a redo inside it, design_branch_create. Only for a separate new theme the person asked for, omarchy_theme_create with new_project: true.',
    };
  });

  define('omarchy_theme_create', { description: 'Open or make the file that designs an Omarchy theme. One theme is one project file: asking for a theme that has a project (by file_id, by its name, or by the installed theme it started from, of the same target and profile) opens that file (reused: true) and makes nothing, with or without a name; a name is never permission to copy. Alternatives and redos of a theme are branches inside its file (design_branch_create), never new files: in a run asked to change or redo existing work, in a revision or on a branch it makes no new file under any name, and a session already working on a theme makes another only with new_project: true. When several files could be the one meant, or a new name is asked for beside themes that started from the same installed theme, nothing is made: the answer is needs_choice with candidates, and you ask the person, then call again with the chosen file_id, or with new_project: true only when they want a separate new theme. omarchy_theme_projects lists the projects first. A new file\'s tokens are the keys of colors.toml (--omarchy-accent, --omarchy-background, --omarchy-bright-red and so on, plus --omarchy-hyprland-active-border and --omarchy-hyprland-inactive-border, which take a colour or a linear-gradient), and every preview is drawn from them: the bar, terminals with sample output, an editor, windows with borders and gaps, a notification, the launcher, the lock screen and the boot unlock screen, at 1920 x 1080 and again for a portrait desktop monitor (this machine\'s, or 1080 x 1920), laid out for its size. So change a colour with tokens_set and every preview follows. Backgrounds are artboards named "Background …" at the sizes of this machine\'s landscape screens; a new theme\'s hold a quiet placeholder to design from the theme\'s identity (never a generic pattern), and from an installed theme they hold its images. A portrait display has its own composition on "Portrait background · …", which you design for the tall shape (omarchy_theme_displays). "Unlock logo" is unlock.png. With from, a new file starts from an installed theme (omarchy_theme_list), its colors.toml and backgrounds. Then omarchy_theme_export or omarchy_theme_install.' }, {
    file_id: z.string().optional().describe('Continue this theme file: it is opened, checked to be a theme, and nothing is made.'),
    from: z.string().regex(/^[a-z0-9_][a-z0-9._+-]{0,63}$/).optional().describe('An installed theme to start from, such as tokyo-night. Its existing project is opened when there is one.'),
    name: z.string().trim().min(1).max(64).optional().describe('The theme\'s name, such as Dusk. Its folder is the name in lower case with dashes. A name an existing project has opens that project.'),
    target: z.enum(['desktop', 'mobile']).default('desktop').describe('desktop: Omarchy on a computer. mobile: Omarchy Mobile on a phone, drawn at the phone profile\'s logical size (Komodo, the Pixel 9 Pro XL: 420 x 935) with its lock screen, home, app drawer with keyboard, quick settings, notifications, password dialog, recent apps and the Pixel services app; it exports as a package with its own install.sh for the phone. Say which one the person means: never guess it from a name or a width.'),
    profile: z.enum(['komodo']).optional().describe('The phone profile of a mobile theme. komodo is the only one so far.'),
    new_project: z.boolean().default(false).describe('Make a separate new theme file even when a project for this theme exists. Only when the person asks for a separate new theme, never to edit, revise or try an alternative (that is design_branch_create).'),
    copy: z.boolean().default(false).describe('Deprecated: the same as new_project.'),
  }, async ({ file_id, from, name, target, profile, new_project, copy }, ctx) => {
    onThisMachine(ctx);
    const out = await createThemeFile(ctx.app, themeEnv(ctx.app), {
      ...(file_id ? { fileId: file_id } : {}), ...(from ? { from } : {}), ...(name ? { name } : {}), target, ...(profile ? { profile } : {}),
      newProject: new_project || copy, beforeCreate: themeCreateGuard(ctx, OMARCHY_THEME_KIND, new_project || copy), origin: `agent:${ctx.agent}`,
    });
    if (isThemeChoice(out)) return out;
    // The session works in this file from now on, reused or new: a following call without file_id goes here.
    const room = await ctx.room(out.file_id);
    if (out.reused) {
      // Opening it is like file_open: this session continues on the branch that is checked out now.
      ctx.pinBranch(room, currentBranchId(room.doc));
      ctx.page(room, out.page_id || undefined);
      return out;
    }
    ctx.page(room, out.page_id);
    ctx.wrote = true;
    ctx.touch(out.boards.map((b) => b.id));
    return {
      ...out,
      ...(out.left.length ? { note: `Not carried over from ${from}: ${out.left.join(', ')}. Omarchy writes per-app files from colors.toml; a file that names ${from}'s own colour scheme would not match a new palette.` } : {}),
      next: out.target === 'mobile'
        ? 'Look at the Phone boards with canvas_screenshot. Change the palette with tokens_set on --omarchy-* and the shell surfaces on --omarchy-shell-* (they become shell.toml), keep "Guide · safe areas" clear, then omarchy_theme_export to a .tar.gz: that is the phone package, installed on the phone with its install.sh. This machine does not install it. Alternatives later are design_branch_create branches in this file, not new files.'
        : 'Look at the previews with canvas_screenshot, the portrait ones ("Preview · desktop · portrait …") too. Change colours with tokens_set on the --omarchy-* tokens and the shell surfaces on --omarchy-shell-* (they become shell.toml). Design the landscape background on Background 1 (the Wallpaper component) and, separately, a portrait composition on the "Portrait background · …" board (its own component), which holds a quiet placeholder until then: compose it from the theme\'s own identity (its backgrounds, logo, type and accent) for the tall shape, never the landscape picture cropped and never a generic pattern. Until it has layers of your own it is not done, and it is not exported or shown. Keep the subject and any text clear of the bar at the top and the lock field in the middle. For a picture, make it at the portrait ratio with your own image tool, asset_upload it and give it with omarchy_theme_displays assign_artwork. omarchy_theme_displays list says what each shape still needs. Then omarchy_theme_export, or omarchy_theme_install for this machine. Applying it is for the person, in the editor. Alternatives later are design_branch_create branches in this file, not new files.',
      ...(out.target === 'desktop' ? { displays_note: DISPLAY_RUNTIME_NOTE } : {}),
    };
  });

  define('omarchy_theme_displays', { description: `The desktop displays an Omarchy theme file is designed for, and their wallpaper compositions. A portrait display is a desktop monitor turned on its side, with the same bar, tiled windows, launcher, lock and boot screens laid out for its size; it is never a phone (a phone is a mobile theme). Every desktop theme has the 1920 x 1080 previews, which make preview.png. Each shape that is not landscape has its own composition, a "Portrait background · <ratio> · <size>" board holding the component "Wallpaper · portrait <ratio>", which its previews show: design it from the same palette for the tall shape. list: the displays, each composition's status (artwork, composed, or needs-design, mismatch, unverified, missing, which are not done), presets and this machine's monitors (hyprctl, turned and scaled). add: previews of more displays, by preset (${DISPLAY_PRESETS.map((p) => p.id).join(', ')}), monitor name or width and height in logical px; added below the design, nothing existing is changed, a size already there is skipped, one undoable step. assign_artwork: give a composition a picture of exactly its ratio, a bogen-asset src of a PNG, JPEG, WebP or GIF from asset_upload; a picture of another shape is refused rather than cropped, and nothing changes. Only artwork and composed are done. Bogen's quiet placeholder ("Portrait composition not designed yet") and the palette arcs older files have are never a design, however they are recoloured: compose the shape from the theme's own identity (its backgrounds, logo, type, accent) with layers of your own, or assign artwork. This changes nothing on the desktop: stock Omarchy shows one background on every screen, and only Bogen's portrait background plugin, which the person installs, shows a designed composition on a portrait screen. list says (runtime_status) what each monitor here would show.` }, {
    file_id: fileIdArg,
    action: z.enum(['list', 'add', 'assign_artwork']).default('list'),
    add: z.array(z.union([
      z.object({ preset: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
      z.object({ monitor: z.string().regex(/^[\w.:-]{1,32}$/).describe('A connector from list, such as DP-5.') }).strict(),
      z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) }).strict().describe('Logical px: the mode turned as mounted, divided by the scale.'),
    ])).max(4).optional().describe('For add: the displays, at most 4 at a time.'),
    aspect: z.string().regex(/^[\d.]{1,8}:[\d.]{1,8}$/).optional().describe('For assign_artwork: the composition\'s ratio from list, such as 9:16.'),
    src: z.string().max(200).optional().describe('For assign_artwork: the bogen-asset: src from asset_upload.'),
    name: z.string().max(80).optional().describe('For assign_artwork: the layer name of the picture.'),
  }, async ({ file_id, action, add, aspect, src, name }, ctx) => {
    onThisMachine(ctx);
    const room = await ctx.room(file_id);
    const doc = room.doc;
    if (action === 'add') {
      if (!add?.length) throw new Error('add needs at least one display: { preset }, { monitor } or { width, height }.');
      const out = await addThemeDisplays(doc, { requests: add, detected: await detectDisplays(), glyphs: await barFonts() }, (fn) => ctx.write(room, fn));
      ctx.touch(out.added.flatMap((a) => a.boards.map((b) => b.id)).concat(out.wallpapers.map((w) => w.board.id)));
      return { ...out, next: out.wallpapers.length ? `Design ${out.wallpapers.map((w) => `"${w.board.name}"`).join(' and ')} for its shape from the theme's own identity, with layers of your own, or assign artwork made at that ratio; it holds a quiet placeholder that is listed as needing its own design and is never exported or shown on a screen. Look at the new previews with canvas_screenshot.` : 'Look at the new previews with canvas_screenshot.' };
    }
    if (action === 'assign_artwork') {
      if (!aspect || !src) throw new Error('assign_artwork needs aspect (from list, such as 9:16) and src (from asset_upload).');
      const state = await assignDisplayArtwork(ctx.app, doc, { aspect, src, ...(name ? { name } : {}) }, (fn) => ctx.write(room, fn));
      if (state.board) ctx.touch([state.board.id]);
      return { wallpaper: state };
    }
    const meta = themeMeta(doc);
    const detected = await detectDisplays();
    const wallpapers = await wallpaperStates(ctx.app, doc, meta);
    return { displays: themeDisplays(doc, meta), wallpapers, ...displayChoices(doc, detected), runtime: DISPLAY_RUNTIME_NOTE, runtime_status: displayRuntime(themeEnv(ctx.app), wallpapers, detected), done_means: DONE_MEANS };
  });

  define('omarchy_theme_export', { description: 'Write an Omarchy theme file as a complete theme: colors.toml from the tokens, the backgrounds rendered at full size as PNG (an image loaded from a theme goes out as it was), preview.png for the theme picker, unlock.png and preview-unlock.png for the boot unlock screen, icons.theme, and a README. The per-app files (alacritty.toml, btop.theme, neovim.lua and the rest) are left out: Omarchy writes them from colors.toml when the theme is applied, which is also the only way a theme from a repository gets them. dest is a new or empty folder, or a path ending in .tar.gz. With git, the folder becomes a repository with one commit, ready to push as omarchy-<name>-theme; nothing is pushed.' }, {
    file_id: fileIdArg,
    dest: z.string().min(1).max(4000).describe('An absolute path: a folder that does not exist or is empty, or a file ending in .tar.gz.'),
    git: z.boolean().optional().describe('Make the folder a Git repository with one commit.'),
  }, async ({ file_id, dest, git }, ctx) => {
    onThisMachine(ctx);
    const room = await ctx.room(file_id);
    const theme = await exportTheme(ctx.app, themeEnv(ctx.app), room.id);
    const out = await writeThemeTo(theme, dest, { git });
    return {
      name: theme.name, slug: theme.slug, mode: theme.mode, target: theme.target, revision: theme.manifest.revision, ...out, generated_by_omarchy: theme.generated,
      ...(theme.problems.length ? { problems: theme.problems } : {}),
      ...(theme.notes.length ? { notes: theme.notes } : {}),
      ...(theme.target === 'mobile' ? { install_on_phone: `tar -xzf ${theme.slug}-mobile.tar.gz && cd ${theme.slug}-mobile && ./install.sh --dry-run && ./install.sh`, not_themable: theme.manifest.coverage.filter((c) => c.status === 'not-themable').map((c) => c.surface) } : {}),
    };
  });

  define('omarchy_theme_install', { description: 'Install an Omarchy theme file on this machine, as ~/.config/omarchy/themes/<name>, where omarchy theme set and the theme picker find it. It never replaces a theme that is there already: then it says so, and the person can replace it with Install in the editor, which asks first. It does not apply the theme. Applying it, and undoing that, are for the person, with Apply in the editor.' }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    onThisMachine(ctx);
    const room = await ctx.room(file_id);
    const env = themeEnv(ctx.app);
    await assertFileInstallable(ctx.app, env, room.id);
    const theme = await exportTheme(ctx.app, env, room.id);
    const out = await installTheme(env, theme, { overwrite: false });
    return { ...out, ...(out.overStock ? { note: `There is a stock theme ${out.name}: this one goes over it, and its own files stay where this one has none.` } : {}), next: 'Tell the person it is installed. They apply it with Apply in the editor, and can undo that there.' };
  });
}
