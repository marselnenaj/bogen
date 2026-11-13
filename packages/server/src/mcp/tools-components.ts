import {
  addVariant, createComponent, createInstance, createMode, deleteMode, deleteTextStyle, designSystemCss, detachInstance, effectiveMode, findMain, getModes, getTextStyles, applyTextStyle,
  camelCss, instanceControls, instancesOf, isVirtualId, listMains, listOverrides, nodeToHtml, resetAllOverrides, resetOverride, setInstanceProps, setOverride, setPageMode, setSlot, setTextStyle, setTokenMode, slotsOf,
  TEXT_STYLE_PROPS, textStyleKey, libraryOf, updateComponent, variantAxes, type BogenDoc, type ComponentProp, type PropTarget, type PropValue,
} from '@bogen/core';
import { closestSetIcons, hasSetIcon, ICON_SETS, iconSetCounts, searchSetIcons, setIconSpec, type IconSetId } from '@bogen/core/icon-sets';
import { useIconSetFiles } from '../icon-set-files.ts';
import { z } from 'zod';
import { wrapLayers } from './tools-layout.ts';
import { assertSafeStyle } from './tools-write.ts';
import { assertUnlocked, fileIdArg, nextArtboardX, outline, pageIdArg, type ToolDefiner } from './kit.ts';
import { libraryMain, pendingLibraryChanges } from './tools-library.ts';

const propValue = z.union([z.string(), z.boolean()]);

const propArg = z.object({
  name: z.string().regex(/^[a-zA-Z_][\w-]*$/).describe('Such as label or show-icon.'),
  type: z.enum(['text', 'boolean', 'image', 'variant']).describe('text drives words, boolean shows or hides a layer, image drives a src. A variant value that picks another main comes from the variant set, so set variant_set and variant for that.'),
  target: z.string().optional().describe('The layer in the main this prop drives: an id or a layer name. Leave out only for a prop nothing reads yet.'),
  field: z.string().optional().describe('What it drives on that layer. Default by type: text, visible, src. Also hidden, style.<property>, attr.<name>, or prop.<name> of a nested instance.'),
  default: propValue.optional().describe('Only for a prop without a target. One with a target falls back on what the main shows, so that editing the main keeps working.'),
  options: z.array(z.string()).max(50).optional().describe('Allowed values, written into the code handoff as a union.'),
});

type PropArg = z.infer<typeof propArg>;

/** A layer in a main, by id or name, as the path a prop or override stores. */
function layerPath(doc: BogenDoc, mainId: string, ref: string): string {
  if (ref === mainId) return '';
  const all = doc.descendants(mainId);
  const hit = all.find((n) => n.id === ref) ?? all.find((n) => n.name === ref) ?? all.find((n) => n.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new Error(`There is no layer "${ref}" in this component. Read it with component_get.`);
  return hit.id;
}

function toProps(doc: BogenDoc, mainId: string, props: PropArg[]): ComponentProp[] {
  return props.map((p) => {
    const field = p.field ?? (p.type === 'text' ? 'text' : p.type === 'boolean' ? 'visible' : p.type === 'image' ? 'src' : undefined);
    const targets: PropTarget[] = p.target !== undefined && field ? [{ path: layerPath(doc, mainId, p.target), field }] : [];
    return { name: p.name, type: p.type, ...(p.default !== undefined ? { default: p.default } : {}), ...(p.options ? { options: p.options } : {}), targets };
  });
}

function requireMain(doc: BogenDoc, ref: string, variant?: Record<string, string>) {
  const main = findMain(doc.source, ref, variant);
  if (!main) {
    const known = listMains(doc.source).map((m) => `${m.name} (${m.id})`).join(', ') || 'none yet; make one with component_create';
    throw new Error(`There is no component "${ref}". Components in this file: ${known}.`);
  }
  return main;
}

function describeMain(doc: BogenDoc, id: string) {
  const src = doc.source;
  const main = src.raw(id)!;
  const c = main.component!;
  const lib = libraryOf(doc, id);
  return {
    id, name: main.name, page: doc.pageOf(id),
    ...(lib ? { library: { id: lib.meta.lib, version: lib.meta.version, note: 'A copy from a shared library: edit it in the library and publish there, then library_accept here.' } } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.set ? { variant_set: c.set, variant: c.variant ?? {}, axes: variantAxes(src, c.set) } : {}),
    props: c.props ?? [],
    slots: slotsOf(src, id).map((s) => ({ name: s.name, layer: s.path })),
    instances: instancesOf(doc, id).length,
  };
}

export function registerComponentTools(define: ToolDefiner): void {
  define('component_create', { description: `Make a component from layers that exist, so that the design reuses it instead of repeating markup. The layer becomes the main, in place: it stays where it is and you go on editing it with the usual tools, and every instance follows, on all pages. Several layers are wrapped in a frame first. Build the layer with html_write, then call this, then place instances with instance_create or <x-instance> in html_write.

Expose what varies as props, such as the label of a button. Mark frames as slots to let instances put layers of their own in them. To group mains into variants, such as size and state, give variant_set and variant, or add_variant on component_update.` }, {
    node_ids: z.array(z.string()).min(1).max(100),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    props: z.array(propArg).max(100).optional(),
    slots: z.array(z.object({ layer: z.string().describe('A frame in the main: an id or a layer name.'), name: z.string().regex(/^[a-zA-Z_][\w-]*$/) })).max(50).optional(),
    variant_set: z.string().min(1).max(200).optional().describe('Mains with the same set are variants of one component, such as Button.'),
    variant: z.record(z.string(), z.string()).optional().describe('This main\'s place in the set, such as {"size":"lg","state":"hover"}.'),
    file_id: fileIdArg,
  }, async ({ node_ids, name, description, props, slots, variant_set, variant, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    assertUnlocked(doc, node_ids);
    for (const id of node_ids) if (isVirtualId(id)) throw new Error(`Layer ${id} is inside an instance. Edit its main, or call instance_detach first.`);
    let target = node_ids[0]!;
    if (node_ids.length > 1 || doc.rawNode(target)?.instanceOf !== undefined) target = (await wrapLayers(ctx, room, node_ids, { name: name ?? 'Component' })).id;
    ctx.write(room, () => {
      createComponent(doc, target, { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(variant_set ? { set: variant_set } : {}), ...(variant ? { variant } : {}) });
      doc.invalidate();
      if (props) updateComponent(doc, target, { props: toProps(doc, target, props) });
      for (const slot of slots ?? []) setSlot(doc, layerPath(doc, target, slot.layer) || target, slot.name);
    });
    ctx.touch([target]);
    return { ...describeMain(doc, target), next: 'Place it with instance_create, or <x-instance component="..."> in html_write. Do not copy its markup.' };
  });

  define('component_list', { description: 'The components of this file, with their props, variants, slots and how often they are used. Call this before you build anything repeated: use what exists.', readOnly: true }, {
    query: z.string().optional().describe('Part of a name or description.'),
    file_id: fileIdArg,
  }, async ({ query, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    const q = query?.trim().toLowerCase();
    const mains = listMains(doc.source).filter((m) => !q || m.name.toLowerCase().includes(q) || (m.component?.description ?? '').toLowerCase().includes(q) || (m.component?.set ?? '').toLowerCase().includes(q));
    return { total: mains.length, components: mains.map((m) => describeMain(doc, m.id)) };
  });

  define('component_get', { description: 'One component in full: props, slots, variants, its layers and markup, and where its instances are. Read this before you use its props or edit its main.', readOnly: true }, {
    component: z.string().describe('An id, a name, or a variant set.'),
    file_id: fileIdArg,
  }, async ({ component, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    const main = requireMain(doc, component);
    return {
      ...describeMain(doc, main.id),
      instance_ids: instancesOf(doc, main.id).slice(0, 200),
      tree: outline(doc, [main.id], 6, 200),
      html: nodeToHtml(doc, main.id, { stripRootPosition: true, indent: true }).slice(0, 20_000),
    };
  });

  define('instance_create', { description: 'Place an instance of a component: one linked layer that follows its main. On a page it gets a free spot; in a flex or grid parent it follows layout. This is how you repeat something: never copy the main\'s markup.' }, {
    component: z.string().describe('An id, a name, or a variant set.'),
    library: z.string().optional().describe('A shared library, by id or name (library_list): the component comes from it and stays linked to it. The library is linked on first use.'),
    parent_id: z.string().optional().describe('A frame, or a slot of another instance. Default is the current page.'),
    variant: z.record(z.string(), z.string()).optional().describe('Which member of a variant set, such as {"size":"lg"}.'),
    props: z.record(z.string(), propValue).optional(),
    x: z.number().optional().describe('Sets left in px, for a parent without layout or a page.'),
    y: z.number().optional().describe('Sets top in px.'),
    index: z.number().int().min(0).optional().describe('Position among the new siblings.'),
    style: z.record(z.string(), z.string()).optional().describe('The instance\'s own CSS, such as {"width":"100%"}. It is an override of the main for this instance.'),
    name: z.string().min(1).max(200).optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ component, library, parent_id, variant, props, x, y, index, style, name, page_id, file_id }, ctx) => {
    const fromLibrary = library ? await libraryMain(ctx, file_id, library, component, variant) : undefined;
    const room = await ctx.room(file_id);
    const { doc } = room;
    const main = requireMain(doc, fromLibrary ?? component, variant);
    const parent = parent_id ?? ctx.page(room, page_id);
    if (parent_id && !doc.pages.has(parent_id)) assertUnlocked(doc, [parent_id]);
    const own: Record<string, string> = {};
    for (const [k, v] of Object.entries(style ?? {})) {
      assertSafeStyle(k, v);
      own[camelCss(k)] = v;
    }
    const onPage = doc.pages.has(parent);
    if (onPage || x !== undefined || y !== undefined) {
      own.position = 'absolute';
      own.left = `${x ?? (onPage ? nextArtboardX(doc, parent) : 0)}px`;
      own.top = `${y ?? 0}px`;
    }
    const id = ctx.write(room, () => {
      const out = createInstance(doc, main.id, parent, { style: own, ...(index !== undefined ? { index } : {}), ...(name ? { name } : {}) });
      doc.invalidate();
      if (props) setInstanceProps(doc, out, props);
      return out;
    });
    ctx.touch([id]);
    return { id, component: main.id, controls: instanceControls(doc.source, id), tree: outline(doc, [id], 3, 40), next: 'Change it with instance_set. Layers inside have ids like <instance>/<layer>, and layer_style, layer_text and layer_attrs on them make overrides on this instance only.' };
  });

  define('instance_set', { description: 'Change one instance without touching its main: props, a variant value (which switches the main it shows), overrides on inner layers, and resets. An override can also be made with layer_style, layer_text and layer_attrs on an id such as <instance>/<layer>. To hide an inner layer, override hidden.' }, {
    node_id: z.string().describe('The instance, or a nested instance such as <instance>/<nested>.'),
    props: z.record(z.string(), z.union([propValue, z.null()])).optional().describe('Props and variant values, such as {"label":"Buy","size":"lg"}. null goes back to what the main shows.'),
    overrides: z.array(z.object({
      layer: z.string().optional().describe('A layer in the main: an id, a name, or a path through nested instances. Leave out for the instance itself.'),
      field: z.string().describe('text, src, hidden, style.<property> or attr.<name>.'),
      value: z.union([propValue, z.null()]).describe('null takes the override back.'),
    })).max(200).optional(),
    reset: z.array(z.string()).max(200).optional().describe('Override keys to take back, as listed in overrides in this tool\'s result.'),
    reset_all: z.boolean().default(false).describe('Back to the main: overrides, props and slot contents go. Position and variant stay.'),
    file_id: fileIdArg,
  }, async ({ node_id, props, overrides, reset, reset_all, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    assertUnlocked(doc, [node_id]);
    const node = doc.getNode(node_id);
    if (!node?.instanceOf) throw new Error(`Layer ${node_id} is not an instance. Call layer_tree to find one.`);
    ctx.write(room, () => {
      if (reset_all) resetAllOverrides(doc, node_id);
      for (const key of reset ?? []) resetOverride(doc, node_id, key);
      if (props) setInstanceProps(doc, node_id, props);
      for (const o of overrides ?? []) {
        const main = doc.getNode(node_id)!.instanceOf!;
        const layer = o.layer === undefined ? node_id : o.layer.includes('/') ? `${node_id}/${o.layer}` : `${node_id}/${layerPath(doc, main, o.layer)}`;
        const target = layer.endsWith('/') ? node_id : layer;
        if (!doc.getNode(target)) throw new Error(`There is no layer "${o.layer}" in this instance. Read it with layer_tree.`);
        if (typeof o.value === 'string' && o.field.startsWith('style.')) assertSafeStyle(o.field, o.value);
        if (o.field === 'src' && typeof o.value === 'string' && /^javascript:/i.test(o.value.trim())) throw new Error('This URL scheme is not allowed.');
        setOverride(doc, target, o.field, o.value);
      }
    });
    ctx.touch([node_id]);
    return { id: node_id, component: doc.getNode(node_id)?.instanceOf, controls: instanceControls(doc.source, node_id), overrides: listOverrides(doc.source, node_id) };
  });

  define('instance_detach', { description: 'Turn an instance into ordinary layers that look the same, with its overrides built in. It no longer follows the main, and nested instances stay instances. Use it only when the layer must really diverge; a prop, a variant or a slot usually says it better.', destructive: true }, {
    node_id: z.string(),
    file_id: fileIdArg,
  }, async ({ node_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    assertUnlocked(room.doc, [node_id]);
    ctx.write(room, () => detachInstance(room.doc, node_id));
    ctx.touch([node_id]);
    return { id: node_id, detached: true, tree: outline(room.doc, [node_id], 3, 60) };
  });

  define('component_update', { description: 'Change what a component is: its name, description, props, slots and place in a variant set, or add a variant. To change how it looks, edit its layers with the usual tools, and all instances follow.' }, {
    component: z.string().describe('An id or a name.'),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    props: z.array(propArg).max(100).optional().describe('The whole list. A prop left out goes away.'),
    slots: z.array(z.object({ layer: z.string(), name: z.string().regex(/^[a-zA-Z_][\w-]*$/).nullable().describe('null makes it an ordinary frame again.') })).max(50).optional(),
    variant_set: z.string().max(200).optional().describe('An empty string takes it out of its set.'),
    variant: z.record(z.string(), z.string()).optional(),
    add_variant: z.record(z.string(), z.string()).optional().describe('Copies this main as another member of its set, such as {"size":"lg"}. Returns its id, for you to restyle.'),
    base_variant: z.record(z.string(), z.string()).optional().describe('With add_variant on a main that has no set yet: this main\'s own values, such as {"size":"sm"}.'),
    handoff: z.object({
      from: z.string().max(200).describe('The module, such as @/components/ui/button or @mui/material.'),
      name: z.string().max(100).describe('The component in code, such as Button.'),
      imports: z.array(z.string()).max(30).optional().describe('More names from the same module that the usage needs.'),
      props: z.record(z.string(), z.string()).optional().describe('Prop or variant axis name to the prop name in code. "children" makes a text prop the children; "" leaves it out.'),
      values: z.record(z.string(), z.record(z.string(), z.string())).optional().describe('Variant values to their value in code, per axis.'),
      defaults: z.record(z.string(), z.string()).optional().describe('The variant values code leaves unsaid.'),
    }).nullable().optional().describe('The component of a code library this stands for: code_get then imports it rather than writing it out. null takes it away.'),
    file_id: fileIdArg,
  }, async ({ component, name, description, props, slots, variant_set, variant, add_variant, base_variant, handoff, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const main = requireMain(doc, component);
    assertUnlocked(doc, [main.id]);
    let added: string | undefined;
    ctx.write(room, () => {
      updateComponent(doc, main.id, {
        ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}),
        ...(variant_set !== undefined ? { set: variant_set } : {}), ...(variant ? { variant } : {}),
        ...(props ? { props: toProps(doc, main.id, props) } : {}),
        ...(handoff !== undefined ? { handoff } : {}),
      });
      for (const slot of slots ?? []) setSlot(doc, layerPath(doc, main.id, slot.layer) || main.id, slot.name);
      if (add_variant) {
        const width = Number.parseFloat(main.style.width ?? '') || 0;
        const left = Number.parseFloat(main.style.left ?? '');
        added = addVariant(doc, main.id, add_variant, { ...(base_variant ? { base: base_variant } : {}), ...(Number.isFinite(left) ? { left: `${left + width + 40}px` } : {}) });
      }
    });
    ctx.touch([added ?? main.id]);
    const unpublished = pendingLibraryChanges(doc);
    return { ...describeMain(doc, main.id), ...(added ? { added_variant: added, next: `Restyle the new variant through its layers. Layer ids in it are new: read them with component_get ${added}.` } : {}), ...(unpublished ? { library: `This file publishes a library, and ${unpublished} component(s) changed since. library_publish offers them to the files that link it.` } : {}) };
  });

  define('modes_list', { description: 'The theme modes of this file, such as light, dark or compact, and which one holds the plain token values. Tokens have one value per mode, and a page or artboard says which mode it shows.', readOnly: true }, { file_id: fileIdArg }, async ({ file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return { modes: getModes(doc).map((m) => ({ name: m.name, base: m.base })), pages: doc.getPages().map((p) => ({ id: p.id, name: p.name, mode: p.mode ?? null })) };
  });

  define('mode_create', { description: 'Add a theme mode. The first one also names what the plain token values are, which is light unless you say otherwise. Then give tokens values for it with tokens_set modes, or tokens_from_css with mode.' }, {
    name: z.string().regex(/^[a-zA-Z_][\w-]*$/).describe('Such as dark or compact.'),
    base_name: z.string().regex(/^[a-zA-Z_][\w-]*$/).optional().describe('What the plain token values are called, when the file has no modes yet. Default light.'),
    file_id: fileIdArg,
  }, async ({ name, base_name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.write(room, () => createMode(room.doc, name, base_name ? { baseName: base_name } : {}));
    return { modes: getModes(room.doc).map((m) => ({ name: m.name, base: m.base })) };
  });

  define('mode_delete', { description: 'Delete a theme mode and the token values in it. Layers set to it go back to the plain values.', destructive: true }, {
    name: z.string(),
    file_id: fileIdArg,
  }, async ({ name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.write(room, () => deleteMode(room.doc, name));
    return { deleted: name };
  });

  define('mode_set', { description: 'Say which theme mode an artboard, layer or page shows. Everything inside it follows, down to its nearest part in another mode. Pass mode null to go back to what it inherits.' }, {
    mode: z.string().nullable(),
    node_ids: z.array(z.string()).max(200).optional().describe('Layers. Leave out to set the mode of the page.'),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ mode, node_ids, page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    if (mode && !getModes(doc).some((m) => m.name === mode)) throw new Error(`There is no mode "${mode}". Add it with mode_create.`);
    if (node_ids?.length) {
      assertUnlocked(doc, node_ids);
      ctx.write(room, () => {
        for (const id of node_ids) doc.updateFields(id, { mode: mode ?? undefined });
      });
      ctx.touch(node_ids);
      return { layers: node_ids.map((id) => ({ id, mode: effectiveMode(doc, id) ?? null })) };
    }
    const page = ctx.page(room, page_id);
    ctx.write(room, () => setPageMode(doc, page, mode));
    return { page_id: page, mode };
  });

  define('text_styles_list', { description: 'The named text styles of this file: bundles of family, size, weight, line height and tracking. Use them rather than setting those by hand on each layer.', readOnly: true }, { file_id: fileIdArg }, async ({ file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return getTextStyles(doc).map((s) => ({ key: s.key, name: s.name, class: `ts-${s.key}`, style: s.style }));
  });

  define('text_style_set', { description: 'Create or update a named text style. Updating one updates every layer that uses it. Values can be tokens, such as var(--font-display), which then also follow theme modes. It exports as a CSS class. Null removes a value.' }, {
    name: z.string().min(1).max(100).describe('Such as "Heading 1".'),
    style: z.record(z.string(), z.string().nullable()).describe(`Either camelCase or kebab-case names, out of: ${TEXT_STYLE_PROPS.join(', ')}.`),
    file_id: fileIdArg,
  }, async ({ name, style, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const clean = Object.fromEntries(Object.entries(style).map(([k, v]) => {
      if (v !== null) assertSafeStyle(k, v);
      return [camelCss(k), v];
    }));
    const key = ctx.write(room, () => setTextStyle(room.doc, name, clean));
    return { key, class: `ts-${key}`, style: getTextStyles(room.doc).find((s) => s.key === key)?.style, usage: 'text_style_apply, or text-style="..." on a text element in html_write.' };
  });

  define('text_style_apply', { description: 'Use a text style on text layers. The layers give up their own family, size, weight, line height and tracking where the style sets them, so that later updates of the style show. Null takes the style off. Works on a layer inside an instance as an override.' }, {
    node_ids: z.array(z.string()).min(1).max(200),
    style: z.string().nullable().describe('A key or a name.'),
    file_id: fileIdArg,
  }, async ({ node_ids, style, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    assertUnlocked(room.doc, node_ids);
    const key = style === null ? null : textStyleKey(style);
    ctx.write(room, () => {
      for (const id of node_ids) applyTextStyle(room.doc, id, key);
    });
    ctx.touch(node_ids);
    return { updated: node_ids.length, style: key };
  });

  define('text_style_delete', { description: 'Delete a text style. Layers using it keep their look, as its values move onto them.', destructive: true }, {
    style: z.string(),
    file_id: fileIdArg,
  }, async ({ style, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.write(room, () => deleteTextStyle(room.doc, textStyleKey(style)));
    return { deleted: textStyleKey(style) };
  });

  // The sets beyond Lucide are read from their files on first use, not bundled.
  useIconSetFiles();
  define('icon_search', { description: `Find icons by name or by a word such as settings or close. Use real icons rather than emoji or drawing your own, and one set per design. set: lucide (the default), ${ICON_SETS.filter((x) => x.id !== 'lucide').map((x) => `${x.id} (${x.name.replace(/^[^(]*\(|\)$/g, '')})`).join(', ')}, or all to search every set. Names outside Lucide carry their set, such as tabler:home; pass them to icon_insert as they are. No set has the logos of other companies.`, readOnly: true }, {
    query: z.string().min(1).max(100),
    set: z.enum(['lucide', 'phosphor', 'tabler', 'heroicons', 'heroicons-solid', 'material-symbols', 'all']).default('lucide'),
    limit: z.number().int().min(1).max(200).default(30),
  }, async ({ query, set, limit }) => {
    const icons = await searchSetIcons(query, { set: set as IconSetId | 'all', limit });
    return { icons, ...(icons.length ? {} : { sets: (await iconSetCounts()).map((x) => ({ id: x.id, name: x.name, license: x.license, icons: x.icons })) }) };
  });

  define('icon_insert', { description: 'Place an icon from icon_search as an editable vector layer. It takes the text colour of its parent unless you give a colour, so it follows tokens and theme modes. Stroked sets (lucide, tabler, heroicons) take stroke_width; filled ones ignore it. In html_write, an icon can also be inline <svg>.' }, {
    name: z.string().max(120).describe('From icon_search, such as arrow-right or tabler:home.'),
    parent_id: z.string().optional().describe('A frame. Default is the current page.'),
    size: z.number().min(1).max(4000).default(24),
    color: z.string().max(200).optional().describe('A CSS colour for the stroke. To use a token, set color with layer_style instead.'),
    stroke_width: z.number().min(0.25).max(8).optional().describe('For a stroked set. Default: the set\'s own, 2 for Lucide and Tabler, 1.5 for Heroicons.'),
    index: z.number().int().min(0).optional(),
    x: z.number().optional().describe('Sets left in px.'),
    y: z.number().optional().describe('Sets top in px.'),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ name, parent_id, size, color, stroke_width, index, x, y, page_id, file_id }, ctx) => {
    if (!(await hasSetIcon(name))) {
      throw new Error(`There is no icon "${name}". Close ones: ${(await closestSetIcons(name)).join(', ')}.`);
    }
    const room = await ctx.room(file_id);
    const { doc } = room;
    const parent = parent_id ?? ctx.page(room, page_id);
    if (parent_id && !doc.pages.has(parent_id)) assertUnlocked(doc, [parent_id]);
    if (color) assertSafeStyle('color', color);
    const spec = await setIconSpec(name, { size, strokeWidth: stroke_width, ...(color ? { color } : {}) });
    const onPage = doc.pages.has(parent);
    if (onPage || x !== undefined || y !== undefined) {
      spec.style = { ...spec.style, position: 'absolute', left: `${x ?? (onPage ? nextArtboardX(doc, parent) : 0)}px`, top: `${y ?? 0}px` };
    }
    const id = ctx.write(room, () => doc.insert(parent, spec, index));
    ctx.touch([id]);
    return { id, name, svg_length: spec.svg?.length ?? 0 };
  });

  define('design_system_css', { description: 'The file\'s design system as one stylesheet for a repository: tokens with one block per theme mode, and text styles as classes. The same blocks as tokens_export with format css, and it also answers for a file that has text styles but no tokens. For Tailwind 4 or Tailwind 3 output use tokens_export.', readOnly: true }, {
    selector: z.string().regex(/^[\w\s.:#\-[\]="']{1,80}$/).default(':root'),
    mode_selector: z.string().regex(/^[\w\s.:#\-[\]="'{}]{1,80}$/).optional().describe('Where a mode\'s values go, with {mode} for its name, such as .{mode}. Default [data-mode="{mode}"].'),
    file_id: fileIdArg,
  }, async ({ selector, mode_selector, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return designSystemCss(doc, { selector, ...(mode_selector ? { modeSelector: (m: string) => mode_selector.replaceAll('{mode}', m) } : {}) }) || '/* This file has no tokens or text styles yet. */';
  });
}

