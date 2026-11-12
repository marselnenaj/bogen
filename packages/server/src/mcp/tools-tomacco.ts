import { z } from 'zod';
import { compareWithScreen, exportLive, listDevices, readBundle, tomaccoStatus, type AppScreen } from '../tomacco.ts';
import { importScreenInto } from '../http/tomacco-routes.ts';
import { fileIdArg, pageIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

const LOOPBACK = new Set([undefined, '127.0.0.1', 'localhost', '::1']);

const bundleArg = z.string().min(1).max(4096).optional().describe('A Tomacco screen export on this computer: the directory with screen.json and screen.png, or the path of its screen.json. Absolute (~/ works), under the home or temp folder.');
const deviceArg = z.string().regex(/^[\w.:-]{1,200}$/).optional().describe('Or a device id from the list, such as emulator-5554 or virtual-iphone: its screen now, taken with tomaccoctl screen.export.');
const platformArg = z.enum(['android', 'ios']).optional().describe('ios for a USB iPhone given by its UDID.');

async function screenFrom(ctx: ToolContext, bundle: string | undefined, device: string | undefined, platform: 'android' | 'ios' | undefined): Promise<AppScreen | null> {
  if (bundle && device) throw new Error('Give either bundle or device.');
  if (!bundle && !device) return null;
  // The disk and the devices are this computer's. A team server reads neither for anyone.
  if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('bundle and device work only on a server that listens on this machine alone.');
  return bundle ? readBundle(bundle) : exportLive(device!, platform);
}

async function devices(): Promise<object> {
  const list = await listDevices();
  return {
    ...list,
    next: list.available
      ? (list.devices.length ? 'Call again with device set to one of these ids, or with bundle for an export.' : 'No device is running. Start one with Tomacco, or give bundle for an export.')
      : 'Give bundle: the directory of a screen export (tomaccoctl call screen.export).',
  };
}

export function registerTomaccoTools(define: ToolDefiner): void {
  define('tomacco_status', { description: 'Whether a real app screen can be taken from Tomacco on this computer now, before tomacco_import or tomacco_compare with device: state is ready (with the running emulators, devices or virtual iPhone it sees), no-device (Tomacco is installed but nothing is running; steps are the next steps of tomaccoctl doctor, each with the command that does it and ask_first when the person must agree first, such as a 5 GB SDK download), or missing (tomaccoctl is not installed; fix is its install line). Reads only: Bogen never runs these commands, and never builds, installs or starts an app. To build and run the app, use Tomacco\'s own tools (project.run, job.wait) if they are connected, or tell the person the command. Kept for a minute; fresh asks again.', readOnly: true }, {
    fresh: z.boolean().default(false).describe('Ask Tomacco again instead of the answer of the last minute.'),
  }, async ({ fresh }, ctx) => {
    if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('Tomacco is asked only on a server that listens on this machine alone.');
    const status = await tomaccoStatus({ fresh });
    return {
      state: status.state, version: status.version, devices: status.devices,
      ...(status.notes.length ? { notes: status.notes } : {}),
      ...(status.steps.length ? { steps: status.steps.map((s) => ({ goal: s.goal, what: s.what, how: s.how, ask_first: s.askFirst })) } : {}),
      fix: status.fix,
      next: status.state === 'ready'
        ? 'Call tomacco_import with device and beside set to the design artboard, then tomacco_compare with that artboard and the same device.'
        : status.state === 'missing'
          ? 'Tell the person Tomacco is not installed and give them the fix line to run themselves. A screen export folder still works with bundle.'
          : 'Tell the person no device is running. Give them the steps; ask before any step with ask_first. A screen export folder still works with bundle.',
    };
  });

  define('tomacco_import', { description: 'Bring a real app screen onto the canvas: a phone or tablet screen from Tomacco (Android emulator or device, virtual or USB iPhone) becomes an artboard at the device size in dp or points. The screenshot sits at the bottom, locked, as a reference; above it every element of the UI tree is a layer, nested as in the app: text as real, editable text in the colour and about the size it has on the screen, pictures and controls as crops of the screenshot. Use it to redesign an existing screen, or to start a design from what the app shows. Give bundle for an export on disk or device for a running device; with neither it lists the devices. Font sizes and weights are estimates read from pixels, so check them with canvas_screenshot. The result is one undo step.' }, {
    bundle: bundleArg,
    device: deviceArg,
    platform: platformArg,
    text: z.boolean().default(true).describe('Text as text layers. false keeps text as pictures, exactly as on the screen.'),
    frame: z.boolean().default(false).describe('Put a phone frame around the screen.'),
    screenshot: z.boolean().default(true).describe('Keep the whole screenshot under the layers, locked.'),
    name: z.string().min(1).max(200).optional(),
    beside: z.string().optional().describe('A design artboard (or a layer in it): the screen goes to its right at the same top, on its page, so that the two can be compared side by side. Without it, after the last artboard of the page.'),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ bundle, device, platform, text, frame, screenshot, name, beside, page_id, file_id }, ctx) => {
    const screen = await screenFrom(ctx, bundle, device, platform);
    if (!screen) return devices();
    const room = await ctx.room(file_id);
    if (beside && !room.doc.getNode(beside)) throw new Error(`No layer with id ${beside} to put the screen beside. Call layer_tree.`);
    const pageId = beside ? undefined : ctx.page(room, page_id);
    const out = await importScreenInto(ctx.app, room.id, screen, { ...(pageId ? { pageId } : {}), text, frame, screenshot, ...(name ? { name } : {}), ...(beside ? { beside } : {}) }, (fn) => ctx.write(room, fn));
    ctx.touch([out.nodeId]);
    return {
      node_id: out.nodeId, page_id: out.pageId, width: out.width, height: out.height, unit: out.unit,
      device: screen.json.device.id ?? null, model: screen.json.device.model ?? null, app: screen.json.app?.package ?? null,
      layers: out.stats, ...(out.warnings.length ? { warnings: out.warnings } : {}),
      next: beside
        ? `Compare it with tomacco_compare, node_id ${beside} and the same ${bundle ? 'bundle' : 'device'}. Look at both with canvas_screenshot.`
        : 'Look at it with canvas_screenshot. To check a design against the app later, call tomacco_compare.',
    };
  });

  define('tomacco_compare', { description: 'Compare a design artboard with the real app screen: Bogen renders the artboard at the screen\'s pixel size and measures how many pixels differ, with a picture of the differences in red, then matches its text and leaf layers to the app\'s elements (same words first, then position) and lists each pair with how far it is off in dp or points, which text differs, and what is only in the design or only in the app. Use it to check that a screen was built as designed, or how a redesign differs from what ships. Give bundle for an export or device for a running device; with neither it lists the devices. The artboard should be the screen\'s width; an artboard made by tomacco_import with a frame is compared by its screen.', readOnly: true }, {
    node_id: z.string().describe('The design artboard or frame.'),
    bundle: bundleArg,
    device: deviceArg,
    platform: platformArg,
    file_id: fileIdArg,
  }, async ({ node_id, bundle, device, platform, file_id }, ctx) => {
    const screen = await screenFrom(ctx, bundle, device, platform);
    if (!screen) return devices();
    const room = await ctx.room(file_id);
    if (!room.doc.getNode(node_id)) throw new Error(`No layer with id ${node_id}. Call layer_tree.`);
    const out = await compareWithScreen(room.doc, ctx.app.renderer, node_id, screen);
    ctx.touch([node_id]);
    const summary = {
      different_percent: out.percent, different_pixels: out.differentPixels, total_pixels: out.totalPixels, bounds_px: out.bounds, unit: out.unit, design_to_screen: out.scale,
      matched: out.matched.map((m) => ({ layer_id: m.layer.id, layer: m.layer.name, element_id: m.element.id, role: m.element.role, label: m.element.label, dx: m.dx, dy: m.dy, dw: m.dw, dh: m.dh, ...(m.text ? { text: m.text } : {}), summary: m.summary })),
      only_in_design: out.onlyInDesign, only_in_app: out.onlyInApp,
      ...(out.warnings.length ? { warnings: out.warnings } : {}),
      picture: 'The design faded, with differing pixels in red.',
    };
    return {
      content: [
        { type: 'text', text: JSON.stringify(summary, null, 1) },
        { type: 'image', data: Buffer.from(out.diff).toString('base64'), mimeType: 'image/png' },
      ],
    };
  });
}
