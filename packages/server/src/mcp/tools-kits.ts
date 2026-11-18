import type { CodeRef } from '@bogen/core';
import { z } from 'zod';
import { measureCode } from '../code-measure.ts';
import { allKits, findKit, kitSummary, registerKit, useKit, type KitComponent, type Variant } from '../kits/index.ts';
import { codeKitId, kitFromProject } from '../kits/from-code.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

const FALLBACK = { width: 240, height: 48 };

/** A variant of a kit's first component with an axis, written as instance_create takes it. */
function firstAxis(kit: { components: KitComponent[] }): string | undefined {
  const c = kit.components.find((k) => k.axes && Object.keys(k.axes).length);
  if (!c?.axes) return undefined;
  const [axis, values] = Object.entries(c.axes)[0]!;
  return JSON.stringify({ [axis]: values[1] ?? values[0] });
}

/** How a phone screen is put together from a platform kit: the parts in order, at the platform's sizes. */
const PHONE_RECIPE: Record<string, string> = {
  'ionic-ios': 'An iPhone screen from this kit: an artboard 393x852 with display:flex; flex-direction:column; background:var(--ion-background-color), holding in order <x-instance component="Status bar">, <x-instance component="Toolbar" prop-size="large" prop-title="Today" prop-show-back="false">, the content in a <section style="flex:1;display:flex;flex-direction:column;gap:24px;padding:8px 16px 24px">, and <x-instance component="Tab bar" prop-tab-1="Today"> (Tab item instances as its children for your own icons), or on a flow step <x-instance component="Button" prop-size="large" prop-width="full" prop-label="Continue"> and <x-instance component="Home indicator">. Lists: <x-instance component="List section" prop-header="Due"> with <x-instance component="List row" prop-accessory="chevron" prop-title="…" prop-detail="…"> children; a modal is a Sheet; nothing yet is an Empty state. Variant values and props are both prop-*.',
  'material-3': 'An Android screen from this kit: an artboard 412x915 with display:flex; flex-direction:column; background:var(--md-sys-color-surface), holding in order <x-instance component="Top app bar" prop-size="large" prop-title="Today">, the content in a <section style="flex:1;display:flex;flex-direction:column;gap:24px;padding:8px 16px 24px">, and <x-instance component="Navigation bar">. Lists are List item instances; the one primary action is a filled Button or a FAB.',
};

/** Component kits: ready libraries such as shadcn/ui, with tokens, dark mode and the import for code. See kits/. */
export function registerKitTools(define: ToolDefiner): void {
  define('kit_list', { description: 'Component kits to design with: shadcn/ui on Radix (shadcn) and on Base UI (shadcn-base-ui; pick the one whose base the project\'s components.json style names), Radix Themes, Bootstrap 5, Material 3 (an Android phone kit, code as MUI) and Ionic in iOS mode (an iPhone kit: status bar, navigation bar, grouped lists, tab bar, sheet; start every iPhone screen here), and kits made from a linked code project. Each has components with variants, props and slots, tokens in its own CSS variable names with light and dark modes, and for each component the import and props of its code library.', readOnly: true }, {
    kit: z.string().optional().describe('One kit, by id or name, for its whole component list.'),
  }, ({ kit }) => {
    if (kit) return kitSummary(findKit(kit));
    return {
      kits: allKits().map((k) => {
        const s = kitSummary(k);
        return { id: s.id, name: s.name, description: s.description, platform: s.platform, library: s.library, ...(s.design ? { design: s.design } : {}), source: s.source, components: s.components.map((c) => c.name) };
      }),
      next: 'kit_use with a kit id links it into the file. Then place its components with instance_create or <x-instance component="Button" prop-variant="outline"> in html_write: variant values and props are both prop-*.',
    };
  });

  define('kit_use', { description: 'Use a component kit in a file: links its library (made once on this device, in a file of its own with a showcase page of every component in light and dark), and adds its tokens and its dark mode. A theme, or the file\'s brand with from_brand, maps onto the kit\'s tokens: the brand\'s primary colour becomes the kit\'s primary, and so on. Place the components afterwards like any library component; code_get then writes imports of the kit\'s code library, such as import { Button } from "@/components/ui/button". With from_code, the kit is made from the project linked to the file (code_project_link): its React components with their enum props as variants, built onto a page of this file.' }, {
    kit: z.string().optional().describe('A kit id or name from kit_list.'),
    from_code: z.boolean().default(false).describe('Make the kit from the linked code project instead.'),
    components: z.array(z.string()).max(40).optional().describe('With from_code: only these components, by name.'),
    theme: z.record(z.string(), z.string().max(200)).optional().describe('Values for the kit\'s tokens by their name, such as {"primary":"#2b3df2","radius":"0px"}. Values can be var(--a-token-of-the-file).'),
    from_brand: z.boolean().default(false).describe('Map the brand the file links to onto the kit\'s tokens: colours by role, the body font and the radius.'),
    file_id: fileIdArg,
  }, async ({ kit, from_code, components, theme, from_brand, file_id }, ctx) => {
    if (!kit && !from_code) throw new Error('Give a kit from kit_list, or from_code: true.');
    const room = await ctx.room(file_id);
    const write = <T>(fn: () => T) => ctx.write(room, fn);
    let chosen = kit ? findKit(kit) : undefined;
    let insertCode: ((parent: string, c: KitComponent, variant: Variant) => string) | undefined;
    let codeKit: string | undefined;
    if (from_code) {
      const linked = room.doc.meta.get('codeProject') as { id?: unknown } | undefined;
      const project = typeof linked?.id === 'string' ? ctx.app.codeProjects.get(linked.id) : undefined;
      if (!project) throw new Error('This file has no code project linked on this device. Call code_project_link with the folder of the repository first.');
      chosen = kitFromProject(project, await ctx.app.codeProjects.components(project), components);
      codeKit = codeKitId(project);
      registerKit(chosen);
      // Measured before the write, which is one transaction and cannot wait for a browser.
      const sizes = new Map<string, { width: number; height: number }>();
      const refOf = (c: KitComponent, variant: Variant): CodeRef => ({ project: c.code!.project, file: c.code!.file, name: c.code!.name, ...(c.code!.import ? { import: c.code!.import } : {}), props: c.code!.props?.(variant) ?? {} });
      for (const c of chosen.components) {
        for (const variant of c.members ?? [{}]) {
          const ref = refOf(c, variant);
          sizes.set(JSON.stringify(ref), await measureCode(ctx.app.renderer, ctx.app.codeBuilder, ref).catch(() => FALLBACK));
        }
      }
      insertCode = (parent, c, variant) => {
        const ref = refOf(c, variant);
        const size = sizes.get(JSON.stringify(ref)) ?? FALLBACK;
        return room.doc.insert(parent, { type: 'embed', name: c.name, style: { width: `${size.width}px`, height: `${size.height}px` }, code: ref });
      };
    }
    const out = await useKit(ctx.app, room, chosen!, { theme, fromBrand: from_brand, write, insertCode });
    if (out.page) ctx.touch(out.page.boards);
    return {
      ...out,
      ...(codeKit ? { kit_id: codeKit } : {}),
      next: out.library
        ? `${PHONE_RECIPE[chosen!.id] ?? `Place components with instance_create (component "${chosen!.components[0]?.name ?? 'Button'}"${firstAxis(chosen!) ? `, variant ${firstAxis(chosen!)}` : ''}) or <x-instance component="${chosen!.components[0]?.name ?? 'Button'}"> in html_write.`} The showcase is in the file ${out.library.id}.`
        : 'The mains are on their own page of this file. Place instances of them like any component.',
    };
  });
}
