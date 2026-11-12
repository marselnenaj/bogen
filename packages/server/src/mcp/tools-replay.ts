import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { exportReplay } from '../replay.ts';
import { exportLocation, freePath } from './tools-design.ts';
import { fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';

function slug(text: string): string {
  return text.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'replay';
}

export function registerReplayTools(define: ToolDefiner): void {
  define('replay_export', { description: 'Film how a page was built, from its history: every step by every person and agent in order, with their cursors and names and a caption with the tool, as MP4, WebM or GIF. It goes to the Bogen export folder, or to path when given, and returns the path. Use it when the person wants to show or share how a design came about. from and to take change ids from change_list, commit ids or times; run takes one agent run. Idle gaps are capped, so a slow afternoon still plays in a minute.' }, {
    format: z.enum(['mp4', 'webm', 'gif']).default('mp4'),
    page_id: pageIdArg,
    from: z.string().max(64).optional().describe('Start at this change id, commit id or time (ISO 8601 or milliseconds). Default: the first change.'),
    to: z.string().max(64).optional().describe('End at this change id, commit id or time. Default: now.'),
    run: z.string().max(64).optional().describe('Only the span of this agent run.'),
    speed: z.number().min(0.1).max(64).default(1).describe('2 plays twice as fast.'),
    max_idle: z.number().min(0.04).max(60).default(1.5).describe('Seconds: the longest a pause between two steps may last, before the speed.'),
    width: z.number().int().min(160).max(3840).optional().describe('Pixels. Default 1920 by 1080 (960 by 540 for GIF), upright for a tall page.'),
    height: z.number().int().min(160).max(3840).optional(),
    fps: z.number().int().min(1).max(60).optional().describe('Default 30, 15 for GIF.'),
    captions: z.boolean().default(true).describe('Show the tool and what it did next to each cursor.'),
    cursors: z.boolean().default(true).describe('Show cursors, names and the outline of what each step touched.'),
    camera: z.enum(['auto', 'grow', 'fit', 'follow']).default('auto').describe('grow shows the page as far as it is built and widens as it grows; fit shows the whole page throughout; follow stays close to the work and pulls back at the end; auto is grow, or follow when the whole page would be too small.'),
    path: z.string().min(1).max(4096).optional().describe('Where to write, as an absolute path under the home folder (~/ works): a file ending in the format, or a folder ending in /. Leave out for the Bogen export folder.'),
    overwrite: z.boolean().default(false).describe('With path: replace a file that is already there.'),
    file_id: fileIdArg,
  }, async ({ format, page_id, from, to, run, speed, max_idle, width, height, fps, captions, cursors, camera, path: given, overwrite, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const pageId = ctx.page(room, page_id);
    const exportRoot = ctx.app.exportDir ?? process.env.BOGEN_EXPORT_DIR ?? join(homedir(), 'Downloads', 'Bogen');
    let dir = exportRoot;
    let file: string | undefined;
    if (given) {
      const location = await exportLocation(given, { exportRoot, dataDir: ctx.app.storage.home, hidden: false });
      const isDir = /[/\\]$/.test(given) || (await stat(location).then((s) => s.isDirectory(), () => false));
      if (isDir) dir = location;
      else {
        if (extname(location).slice(1).toLowerCase() !== format) throw new Error(`Nothing was exported. A ${format} replay needs a path ending in .${format}, or a folder ending in /.`);
        if (!overwrite && (await stat(location).then(() => true, () => false))) throw new Error(`Nothing was exported. ${location} already exists. Pass overwrite true to replace it, or choose another name.`);
        file = location;
        dir = dirname(location);
      }
    }
    await mkdir(dir, { recursive: true });
    const film = await exportReplay(ctx.app, room.id, { pageId, from, to, run, format, speed, maxIdleMs: max_idle * 1000, width, height, fps, captions, cursors, camera });
    const name = ctx.app.storage.get(room.id)?.name ?? 'bogen';
    const out = file ?? await freePath(dir, slug(`${name} replay`), film.ext);
    await writeFile(out, film.bytes, { flag: file && overwrite ? 'w' : 'wx' });
    return { path: out, format, ...film.report };
  });
}
