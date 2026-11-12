import { rectFromStyle } from '@bogen/core';
import type { RunImage, RunnerId } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import { errorMessage, HttpError } from './util.ts';

/** What every CLI takes as an image. Anything else, or anything larger, goes as a rendered PNG. */
const AS_IS = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Under the size the Claude API takes per image, once in base64. */
const MAX_BYTES = 3_700_000;
/** The long side the models see at best; larger is scaled down on their side anyway. */
const MAX_SIDE = 1568;

export interface RebuildInput { fileId: string; nodeId: string; runner: RunnerId; model?: string; effort?: string; prompt?: string }

/** The image of a layer as the CLI gets it: the stored file when it is a plain raster, else what the canvas shows. */
export async function layerImage(app: BogenServer, fileId: string, nodeId: string): Promise<RunImage> {
  const room = await app.rooms.get(fileId);
  const node = room.doc.getNode(nodeId);
  if (!node) throw new HttpError(400, `No layer with id ${nodeId}.`);
  if (node.type !== 'image') throw new HttpError(400, 'Rebuild as layers works on an image layer.');
  if (!node.src) throw new HttpError(400, 'This image is a placeholder: it has nothing to rebuild yet.');
  const asset = /^bogen-asset:(.+)$/.exec(node.src)?.[1];
  const stored = asset ? await app.storage.readAsset(asset) : null;
  if (stored && AS_IS.has(stored.mime) && stored.bytes.byteLength <= MAX_BYTES) return { data: Buffer.from(stored.bytes), mime: stored.mime, name: asset! };
  const shot = await app.renderer.screenshot(room.doc, { nodeIds: [nodeId] }, { format: 'png', scale: 1, maxDimension: MAX_SIDE });
  return { data: Buffer.from(shot.bytes), mime: 'image/png', name: `${nodeId}.png` };
}

/** The request: rebuild it next to itself, in the brand, and compare until it is close. */
export function rebuildPrompt(input: { nodeId: string; name: string; pageId: string; width?: number; height?: number; x: number; y: number; brand: boolean; extra?: string }): string {
  const size = input.width && input.height ? `${Math.round(input.width)} by ${Math.round(input.height)} px` : 'its size';
  return [
    `Rebuild the attached image as editable layers. It is image layer ${input.nodeId} ("${input.name}") on page ${input.pageId}, ${size}. It may be a screenshot, a sketch or a photo of a whiteboard.`,
    `1. Make a new artboard of the same size next to it, at x ${Math.round(input.x)} and y ${Math.round(input.y)}, named after what the image shows. Leave the image itself alone.`,
    '2. Rebuild what it shows with html_write, one section at a time, as real HTML and CSS: text as text, boxes and rows as frames with flex or grid, icons and drawings as inline SVG. Never place the image itself, or a crop of it, as an <img>.',
    input.brand
      ? '3. The file has a brand. Read it with brand_get, and use its tokens, fonts and colours for what the image shows: where the image differs from the brand, follow the brand. Call brand_check before you finish.'
      : '3. The file has no brand: take colours and type from the image, and set them up as tokens with tokens_set.',
    `4. Compare: visual_diff with node_id your artboard and other_node_id ${input.nodeId}, with fit true, and canvas_screenshot. Fix the biggest differences, and compare again. Stop when the difference no longer shrinks, after at most three rounds.`,
    '5. Finish with one or two sentences: what you built and the last visual_diff percentage.',
    ...(input.extra?.trim() ? ['', `The person adds: ${input.extra.trim()}`] : []),
  ].join('\n');
}

/** Starts a run with the image of a layer attached, to rebuild it as layers next to it. */
export async function rebuildRun(app: BogenServer, input: RebuildInput): Promise<{ runId: string }> {
  const entry = app.requireFile(input.fileId);
  const room = await app.rooms.get(input.fileId);
  const { doc } = room;
  const image = await layerImage(app, input.fileId, input.nodeId);
  const node = doc.getNode(input.nodeId)!;
  const pageId = doc.pageOf(input.nodeId)!;
  // Beside the top-level layer the image sits in, which is where a person looks for it.
  const top = [input.nodeId, ...doc.ancestors(input.nodeId)].at(-1)!;
  const box = rectFromStyle(doc.getNode(top)!);
  let measured: { width: number; height: number } | undefined;
  try {
    measured = (await app.renderer.layout(doc, { pageId })).find((e) => e.id === input.nodeId);
  } catch {
    // No browser: the stored size will do.
  }
  const px = (v: string | undefined) => (v && /^\d+(\.\d+)?px$/.test(v) ? Number.parseFloat(v) : undefined);
  const width = measured?.width ?? px(node.style.width);
  const height = measured?.height ?? px(node.style.height);
  const right = top === input.nodeId && width ? box.x + width : box.x + box.w;
  const prompt = rebuildPrompt({
    nodeId: input.nodeId, name: node.name, pageId, ...(width ? { width } : {}), ...(height ? { height } : {}),
    x: right + 80, y: box.y, brand: Boolean(await app.brands.forRoom(room)), ...(input.prompt ? { extra: input.prompt } : {}),
  });
  try {
    const choice = await app.runSettings.resolve(input.runner, 'prompt', { ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) });
    const runId = await app.runs.start({
      fileId: input.fileId, fileName: entry.name, pageId, nodeIds: [input.nodeId], prompt, title: `Rebuild as layers: ${node.name}`,
      runner: input.runner, images: [image], rebuildOf: input.nodeId, ...choice,
    });
    return { runId };
  } catch (e) {
    throw new HttpError(409, errorMessage(e));
  }
}
