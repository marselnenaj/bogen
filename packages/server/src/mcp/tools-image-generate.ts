import { z } from 'zod';
import { GenerationError, IMAGE_ASPECTS, MAX_IMAGES, MAX_PROMPT, unavailableText } from '../image-generate.ts';
import { assertUnlocked, fileIdArg, type ToolDefiner } from './kit.ts';

/** Pictures made by the Codex CLI on this computer, when the person has it signed in. */
export function registerImageGenerateTools(define: ToolDefiner): void {
  define('image_generate', {
    description: `Make a picture from a description, with the Codex CLI's image generation on the person's computer, and store it like asset_upload. Optional: it works only when the person has the Codex CLI installed and signed in, and says so otherwise; then make the image another way (inline SVG or CSS, your own image tool, image_search for a free photo). Each picture takes about a minute, ${MAX_IMAGES} at most per call, made two at a time. Describe the subject, setting, light, framing and style in plain words; it cannot read your canvas. With node_id the first picture goes into that layer: an image layer gets it as src and the description as alt, any other layer gets it as a cover background image. The rest come back as srcs to use with layer_attrs or html_write. Fictional people only: never ask for a real, named person.`,
  }, {
    prompt: z.string().min(3).max(MAX_PROMPT).describe('What the picture shows, in words: "a stoneware teapot on an oak table by a window, soft morning light, product photo".'),
    aspect: z.enum(IMAGE_ASPECTS).default('landscape').describe('square 1:1, landscape 3:2, portrait 2:3, wide 16:9, tall 9:16.'),
    count: z.number().int().min(1).max(MAX_IMAGES).default(1).describe('How many different takes to make, to choose from.'),
    node_id: z.string().optional().describe('A layer to put the first picture in.'),
    alt: z.string().max(300).optional().describe('Alt text for node_id when it is an image; defaults to the prompt, cut short.'),
    file_id: fileIdArg,
  }, async ({ prompt, aspect, count, node_id, alt, file_id }, ctx) => {
    if (ctx.dryRun) throw new Error('image_generate runs a program and takes a minute, so it does not run in a dry run.');
    const app = ctx.app;
    const status = await app.imageGenerator.status();
    if (status.state !== 'ready') throw new Error(`${unavailableText(status)} Make the image another way: inline SVG or CSS, your own image tool and asset_upload, or image_search for a free photo.`);
    let room = node_id ? await ctx.room(file_id) : null;
    if (room && node_id) {
      if (!room.doc.getNode(node_id)) throw new Error(`No layer ${node_id} in this file.`);
      assertUnlocked(room.doc, [node_id]);
    }
    const job = app.imageJobs.start({ prompt, aspect, count, ...(room ? { fileId: room.id } : {}) }, (p) => app.storeGenerated(p));
    const done = await app.imageJobs.wait(job.id)!;
    const made = done.pictures.filter((p) => p.state === 'done' && p.src);
    const failed = done.pictures.filter((p) => p.state !== 'done').map((p) => p.error ?? 'failed');
    if (!made.length) throw new GenerationError('failed', `No picture came back. ${[...new Set(failed)].join(' ')}`);
    let placed: { id: string; as: 'src' | 'background' } | undefined;
    if (node_id) {
      room = await ctx.room(file_id);
      const node = room.doc.getNode(node_id);
      if (node) {
        const first = made[0]!;
        if (node.type === 'image') {
          const text = (alt ?? prompt).trim().slice(0, 300);
          ctx.write(room, () => room!.doc.updateFields(node_id, { src: first.src, attrs: { ...(node.attrs ?? {}), alt: text } }));
          placed = { id: node_id, as: 'src' };
        } else {
          ctx.write(room, () => room!.doc.updateStyle(node_id, { backgroundImage: `url("${first.src}")`, backgroundSize: 'cover', backgroundPosition: 'center' }));
          placed = { id: node_id, as: 'background' };
        }
        ctx.touch([node_id]);
      }
    }
    return {
      images: made.map((p) => ({ src: p.src, width: p.width, height: p.height })),
      ...(failed.length ? { failed } : {}),
      ...(placed ? { placed: `${placed.as === 'src' ? 'Set as src of' : 'Set as cover background of'} ${placed.id}.` } : {}),
      seconds: Math.round(((done.endedAt ?? Date.now()) - done.startedAt) / 1000),
      usage: `<img src="${made[0]!.src}" alt="..." style="width:100%;object-fit:cover">`,
    };
  });
}
