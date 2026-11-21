import {
  DEVICE_ATTR, DEVICE_PROFILES, deviceForSize, deviceGeometry, deviceLayer, deviceProfile, readDeviceConfig, setCanvasDeviceFrame, type DeviceLayerConfig,
  MOCKUP_ATTR, MOCKUP_BLENDS, MOCKUP_SCENES, createComponent, meshAspect, mockupChildren, quadMesh, readMesh, readMockupConfig, sceneById,
  type BogenDoc, type BogenNode, type Mesh, type MockupConfig, type Point, type Quad,
} from '@bogen/core';
import { z } from 'zod';
import { naturalSize } from './tools-images.ts';
import { assertUnlocked, fileIdArg, pageIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/** Mockups: a design on a photo or a drawn object, by corners or a mesh, as a live instance of its artboard. */

// Two numbers as an array of length 2, not a tuple: a tuple is draft-07 `items: [...]`, which draft 2020-12 rejects.
const pointArg = z.array(z.number()).length(2);
const cornersArg = z.object({ tl: pointArg, tr: pointArg, br: pointArg, bl: pointArg }).describe('Where the print\'s corners go, in px of the photo (or of the scene at its own size): top left, top right, bottom right, bottom left.');
const meshArg = z.object({ top: z.array(pointArg).min(2).max(33), bottom: z.array(pointArg).min(2).max(33) }).describe('For a bent surface: points along the top and the bottom edge of the print, left to right, as many on each (one strip between neighbours), in the same px.');

async function sourceSize(ctx: ToolContext, doc: BogenDoc, node: BogenNode): Promise<{ width: number; height: number }> {
  const w = /^([\d.]+)px$/.exec(node.style.width ?? '')?.[1];
  const h = /^([\d.]+)px$/.exec(node.style.height ?? '')?.[1];
  if (w && h) return { width: Number(w), height: Number(h) };
  const [entry] = await ctx.app.renderer.layout(doc, { nodeIds: [node.id] }, [node.id]);
  if (!entry?.width || !entry.height) throw new Error(`${node.name} has no size to place. Give it a width and height.`);
  return { width: Math.round(entry.width), height: Math.round(entry.height) };
}

/** The main to show: the layer itself when it is one, else the layer made one, in place, so the mockup follows it. */
function ensureMain(doc: BogenDoc, node: BogenNode): { main: string; made: boolean } {
  if (node.instanceOf) return { main: node.instanceOf, made: false };
  if (node.component) return { main: node.id, made: false };
  createComponent(doc, node.id, { description: 'Artwork that mockups show. Change it here and every mockup follows.' });
  doc.invalidate();
  return { main: node.id, made: true };
}

const scaleMesh = (m: Mesh, s: number): Mesh => ({ top: m.top.map(([x, y]) => [x * s, y * s] as Point), bottom: m.bottom.map(([x, y]) => [x * s, y * s] as Point) });

/** Cover when the design and surface are nearly the same shape, contain when cropping would cut into it. */
export function autoFit(design: number, surface: number): 'cover' | 'contain' {
  return Math.abs(design / surface - 1) <= 0.04 ? 'cover' : 'contain';
}

export function registerMockupTools(define: ToolDefiner): void {
  define('mockup_list', { description: 'The built-in mockup scenes for mockup_place: each with what it is for, its size and the shape of design its surface takes (aspect, width / height). They are drawn in Bogen, so they need no photo and carry no licence. With a photo of the brand\'s own, place onto it instead with photo and corners.', readOnly: true }, {}, async () => ({
    scenes: MOCKUP_SCENES.map((s) => ({ id: s.id, name: s.name, use: s.use, width: s.width, height: s.height, aspect: Math.round(s.aspect * 100) / 100, bent: s.mesh.top.length > 2 })),
  }));

  define('mockup_place', { description: 'Place a design onto an object as a mockup: an artboard (or any frame) shown on a built-in scene (mockup_list: poster on a wall, billboard, tote bag, badge, hanging sign, packet, cap, phone, laptop) or on a photo, by its four corners, or by a mesh of top and bottom points for cloth and curved things. The design stays live: the artboard becomes a component (in place, nothing moves) and the mockup shows an instance of it, so changing the poster changes every mockup. Each strip is one projective transform (matrix3d), drawn the same in every export, and the surface\'s light and shadow lie over the print with multiply (from the scene, or from the photo itself), so it looks printed rather than pasted. The part of the design that shows is cropped to the surface\'s shape (fit cover); stretch squeezes it. Give node_id of a mockup to change its design, scene, corners, blend or shading. Mockups belong where the brand lives physically; do not put a logo on a laptop for its own sake.' }, {
    node_id: z.string().optional().describe('A mockup to change.'),
    source: z.string().optional().describe('The artboard or frame to show. Required for a new mockup.'),
    scene: z.string().optional().describe('A scene id from mockup_list.'),
    photo: z.string().optional().describe('Instead of a scene: an image layer id or a bogen-asset src of a photo. Needs corners or mesh in its px.'),
    corners: cornersArg.optional(),
    mesh: meshArg.optional(),
    width: z.number().min(100).max(8000).optional().describe('Width of the mockup in px; its height follows the scene or photo. Default 800.'),
    blend: z.enum(MOCKUP_BLENDS).optional().describe('How the print meets the surface: multiply for ink on paper or cloth (default for prints), normal for screens.'),
    shading: z.number().min(0).max(1).optional().describe('How much of the surface\'s light and shadow shows on the print.'),
    fit: z.enum(['cover', 'contain', 'stretch']).optional().describe('cover crops the design to the surface; contain shows all of it, so no line is cut, with bands in its own background colour (the default when the shapes differ by more than a few percent); stretch distorts.'),
    x: z.number().optional(),
    y: z.number().optional(),
    parent_id: z.string().optional().describe('A frame to put it in, such as a slide. Default is the page.'),
    name: z.string().min(1).max(200).optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async (args, ctx) => {
    const room = await ctx.room(args.file_id);
    const { doc } = room;
    const existing = args.node_id ? doc.getNode(args.node_id) : null;
    if (args.node_id && !existing) throw new Error(`No layer with id ${args.node_id}.`);
    const before = existing ? readMockupConfig(existing.attrs?.[MOCKUP_ATTR]) : null;
    if (existing && !before) throw new Error(`${existing.name} is not a mockup. Leave node_id out to make one.`);
    if (existing) assertUnlocked(doc, [existing.id]);
    if (!existing && !args.source) throw new Error('Give source: the artboard or frame to show.');
    if (!existing && !args.scene && !args.photo) throw new Error(`Give scene (one of ${MOCKUP_SCENES.map((s) => s.id).join(', ')}) or photo with corners.`);
    if (args.scene && args.photo) throw new Error('Give scene or photo, not both.');

    // The surface: a scene's, or the photo's with the corners given.
    let sceneId = args.scene ?? (args.photo ? 'photo' : before!.scene);
    let photo = before?.photo;
    let natural: { width: number; height: number };
    let mesh: Mesh;
    const given = args.mesh ? readMesh(args.mesh) : args.corners ? quadMesh([args.corners.tl, args.corners.tr, args.corners.br, args.corners.bl] as Quad) : null;
    if (args.mesh && !given) throw new Error('mesh needs as many points on top as on bottom, at least two each.');
    const scene = sceneId === 'photo' ? null : sceneById(sceneId);
    if (sceneId !== 'photo' && !scene) throw new Error(`No scene "${sceneId}". mockup_list has them: ${MOCKUP_SCENES.map((s) => s.id).join(', ')}.`);
    if (scene) {
      natural = { width: scene.width, height: scene.height };
      mesh = given ?? (args.scene || !before ? scene.mesh : scaleMesh(before.mesh, scene.width / before.width));
    } else {
      if (args.photo) {
        const src = args.photo.startsWith('bogen-asset:') || /^https?:/.test(args.photo) ? args.photo : doc.getNode(args.photo)?.src;
        if (!src) throw new Error(`${args.photo} is not an image layer with an image, nor an image src.`);
        photo = src;
      }
      const size = photo ? await naturalSize(ctx.app.storage, photo) : null;
      if (!size) throw new Error('The photo must be stored in Bogen (asset_upload) so that its size is known.');
      natural = size;
      if (!given && (args.photo || !before)) throw new Error('A photo needs corners (or a mesh) in its own px: where the print goes on it.');
      mesh = given ?? scaleMesh(before!.mesh, natural.width / before!.width);
    }
    sceneId = scene ? scene.id : 'photo';
    const width = args.width ?? (existing ? before!.width : 800);
    const s = width / natural.width;
    const height = Math.round(natural.height * s);
    const scaled = scaleMesh(mesh, s);

    // The design.
    let main = before?.source ?? '';
    let made = false;
    let size = before ? { width: before.sourceWidth, height: before.sourceHeight } : { width: 0, height: 0 };
    if (args.source) {
      const node = doc.getNode(args.source);
      if (!node) throw new Error(`No layer with id ${args.source}.`);
      if (node.type !== 'frame') throw new Error(`${node.name} is a ${node.type} layer. Place an artboard or a frame.`);
      size = await sourceSize(ctx, doc, node);
      ({ main, made } = ctx.write(room, () => ensureMain(doc, node)));
    }
    const config: MockupConfig = {
      source: main, sourceWidth: size.width, sourceHeight: size.height, scene: sceneId, ...(photo && !scene ? { photo } : {}),
      width, height, mesh: scaled,
      blend: args.blend ?? (args.scene || !before ? scene?.blend ?? 'multiply' : before.blend),
      shading: args.shading ?? (args.scene || !before ? scene?.shading ?? 0.6 : before.shading),
      fit: args.fit ?? before?.fit ?? autoFit(size.width / size.height, meshAspect(scaled)),
      ...(doc.getNode(main)?.style.backgroundColor ? { ground: doc.getNode(main)!.style.backgroundColor } : {}),
    };
    const children = mockupChildren(config, scene);
    const attrs = { [MOCKUP_ATTR]: JSON.stringify(config), role: 'img', 'aria-label': `${doc.getNode(main)?.name ?? 'Design'} on ${scene?.name.toLowerCase() ?? 'a photo'}` };
    const style: Record<string, string> = { width: `${width}px`, height: `${height}px`, overflow: 'hidden', isolation: 'isolate', flexShrink: '0' };
    const parent = existing ? existing.parent : args.parent_id ?? ctx.page(room, args.page_id);
    if (!existing && args.parent_id) assertUnlocked(doc, [args.parent_id]);
    if (args.x !== undefined || args.y !== undefined || (!existing && doc.pages.has(parent))) Object.assign(style, { position: 'absolute', left: `${args.x ?? 0}px`, top: `${args.y ?? 0}px` });
    else style.position = 'relative';
    const id = ctx.write(room, () => {
      if (existing) {
        // In place, so the mockup keeps its id, its spot and what the person did to it, such as a rotation.
        const patch: Record<string, string> = { width: style.width!, height: style.height! };
        if (args.x !== undefined || args.y !== undefined) Object.assign(patch, { position: 'absolute', left: style.left!, top: style.top! });
        doc.updateStyle(existing.id, patch);
        doc.updateFields(existing.id, { attrs: { ...(existing.attrs ?? {}), ...attrs }, ...(args.name ? { name: args.name } : {}) });
        const old = doc.getChildren(existing.id).map((c) => c.id);
        if (old.length) doc.delete(old);
        doc.insertMany(existing.id, children);
        return existing.id;
      }
      return doc.insert(parent, { type: 'frame', tag: 'figure', name: args.name ?? `Mockup · ${scene?.name ?? 'Photo'}`, style, attrs, children });
    });
    ctx.touch([id]);
    return {
      id, width, height, scene: sceneId, strips: scaled.top.length - 1, design: main,
      ...(made ? { note: `${doc.getNode(main)?.name ?? 'The design'} is now a component, in place, so the mockup follows its changes.` } : {}),
      next: 'Look at it with canvas_screenshot. Nudge corners with node_id and corners if the print does not sit right, and use the same scene light across one presentation.',
    };
  });

  define('device_list', { description: 'The device frames for device_frame: current iPhones (measured from Apple\'s dimensional drawings: body, continuous corners, island or notch, buttons), Pixel and Galaxy phones and tablets, and a browser window, each with its screen size in points and its finishes.', readOnly: true }, {}, async () => ({
    devices: DEVICE_PROFILES.map((p) => ({ id: p.id, name: p.name, kind: p.kind, screen: `${p.width} x ${p.height}`, finishes: p.finishes.map((f, i) => `${i}: ${f.name}`) })),
  }));

  define('device_frame', { description: 'A device around a screen. Two uses. In a design (a store page, a landing page, a slide): put an artboard live into a phone, tablet or browser window with source (it becomes a component in place, so the screen follows every change), or a screenshot with image, or leave both out for an empty screen; the layer is real SVG and HTML and exports like any other. On the canvas: around shows the frame around an artboard while you design it, without changing the artboard (device none removes it). The device defaults to the one the screen\'s size is. Give node_id of a device layer to change its device, finish, screen or size.' }, {
    node_id: z.string().optional().describe('A device layer to change.'),
    around: z.string().optional().describe('An artboard to show in a device frame on the canvas, instead of placing a layer.'),
    source: z.string().optional().describe('The artboard or frame to show live in the screen.'),
    image: z.string().optional().describe('Or a screenshot: an image layer id or a bogen-asset src.'),
    device: z.string().optional().describe('A device id from device_list, or none (with around) to remove the frame. Default: the one matching the screen\'s size.'),
    finish: z.number().int().min(0).max(9).optional().describe('The finish (colour) by its number in device_list. Default: the darkest.'),
    width: z.number().min(80).max(6000).optional().describe('Width of the layer in px; its height follows the device. Default: the device at its own size.'),
    address: z.string().max(120).optional().describe('For the browser window: the address shown in its bar.'),
    x: z.number().optional(),
    y: z.number().optional(),
    parent_id: z.string().optional().describe('A frame to put it in, such as a hero section. Default is the page.'),
    name: z.string().min(1).max(200).optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async (args, ctx) => {
    const room = await ctx.room(args.file_id);
    const { doc } = room;
    if (args.around) {
      const board = doc.getNode(args.around);
      if (!board) throw new Error(`No layer with id ${args.around}.`);
      if (!board.artboard) throw new Error(`${board.name} is not an artboard. A frame on the canvas goes around an artboard; to put a layer in a device, use source.`);
      if (args.device === 'none') {
        ctx.write(room, () => setCanvasDeviceFrame(doc, board.id, null));
        return { around: board.id, device: null };
      }
      const size = await sourceSize(ctx, doc, board);
      const p = args.device ? deviceProfile(args.device) : deviceForSize(size.width, size.height);
      if (!p) throw new Error(`No device "${args.device}". device_list has them.`);
      ctx.write(room, () => setCanvasDeviceFrame(doc, board.id, { device: p.id, ...(args.finish !== undefined ? { finish: args.finish } : {}) }));
      return { around: board.id, device: p.id, name: p.name, screen: `${p.width} x ${p.height}`, size: `${size.width} x ${size.height}`, ...(Math.abs(p.width - Math.min(size.width, size.height)) > 0.5 ? { note: `The artboard is not ${p.name}'s size, so the frame is scaled to its width.` } : {}) };
    }
    const existing = args.node_id ? doc.getNode(args.node_id) : null;
    if (args.node_id && !existing) throw new Error(`No layer with id ${args.node_id}.`);
    const before = existing ? readDeviceConfig(existing.attrs?.[DEVICE_ATTR]) : null;
    if (existing && !before) throw new Error(`${existing.name} is not a device layer. Leave node_id out to make one.`);
    if (existing) assertUnlocked(doc, [existing.id]);
    if (args.source && args.image) throw new Error('Give source or image, not both.');

    let config: DeviceLayerConfig = before ? { ...before } : { device: '', width: 0 };
    let made = false;
    if (args.source) {
      const node = doc.getNode(args.source);
      if (!node) throw new Error(`No layer with id ${args.source}.`);
      if (node.type !== 'frame') throw new Error(`${node.name} is a ${node.type} layer. Show an artboard or a frame.`);
      const size = await sourceSize(ctx, doc, node);
      let main = '';
      ({ main, made } = ctx.write(room, () => ensureMain(doc, node)));
      config = { ...config, source: main, sourceWidth: size.width, sourceHeight: size.height };
      delete config.image;
    } else if (args.image) {
      const src = args.image.startsWith('bogen-asset:') || /^https?:/.test(args.image) ? args.image : doc.getNode(args.image)?.src;
      if (!src) throw new Error(`${args.image} is not an image layer with an image, nor an image src.`);
      config = { ...config, image: src };
      delete config.source; delete config.sourceWidth; delete config.sourceHeight;
    }
    const p = args.device ? deviceProfile(args.device) : before ? deviceProfile(before.device) : config.sourceWidth && config.sourceHeight ? deviceForSize(config.sourceWidth, config.sourceHeight) : DEVICE_PROFILES[0];
    if (!p) throw new Error(`No device "${args.device}". device_list has them.`);
    if (args.device && before && args.device !== before.device) delete config.finish;
    config.device = p.id;
    if (args.finish !== undefined) config.finish = Math.min(args.finish, p.finishes.length - 1);
    if (args.address !== undefined) config.address = args.address;
    // By default the device at its own size: its screen as many px wide as the device has points.
    config.width = args.width ?? (before && !args.device ? before.width : Math.round(deviceGeometry(p).width * 100) / 100);
    const ground = config.source ? doc.getNode(config.source)?.style.backgroundColor : undefined;
    const layer = deviceLayer(config, ground);
    const attrs = { [DEVICE_ATTR]: JSON.stringify(config), role: 'img', 'aria-label': `${config.source ? doc.getNode(config.source)?.name ?? 'A screen' : 'A screen'} on ${p.name}` };
    const style: Record<string, string> = { width: `${layer.width}px`, height: `${layer.height}px`, flexShrink: '0' };
    const parent = existing ? existing.parent : args.parent_id ?? ctx.page(room, args.page_id);
    if (!existing && args.parent_id) assertUnlocked(doc, [args.parent_id]);
    if (args.x !== undefined || args.y !== undefined || (!existing && doc.pages.has(parent))) Object.assign(style, { position: 'absolute', left: `${args.x ?? 0}px`, top: `${args.y ?? 0}px` });
    else style.position = 'relative';
    const id = ctx.write(room, () => {
      if (existing) {
        const patch: Record<string, string> = { width: style.width!, height: style.height! };
        if (args.x !== undefined || args.y !== undefined) Object.assign(patch, { position: 'absolute', left: style.left!, top: style.top! });
        doc.updateStyle(existing.id, patch);
        doc.updateFields(existing.id, { attrs: { ...(existing.attrs ?? {}), ...attrs }, ...(args.name ? { name: args.name } : {}) });
        const old = doc.getChildren(existing.id).map((c) => c.id);
        if (old.length) doc.delete(old);
        doc.insertMany(existing.id, layer.children);
        return existing.id;
      }
      return doc.insert(parent, { type: 'frame', tag: 'figure', name: args.name ?? `Device · ${p.name}`, style, attrs, children: layer.children });
    });
    ctx.touch([id]);
    return {
      id, device: p.id, name: p.name, width: layer.width, height: layer.height, ...(config.source ? { design: config.source } : {}),
      ...(made ? { note: `${doc.getNode(config.source!)?.name ?? 'The design'} is now a component, in place, so the screen follows its changes.` } : {}),
      ...(!config.source && !config.image ? { next: 'The screen is empty: give source (an artboard) or image (a screenshot) with node_id.' } : {}),
    };
  });
}
