import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BogenDoc, createInstance, findMain, listMains, nodeToHtml, readHandoff, safeUsage, setInstanceProps, toReact, variantAxes } from '@bogen/core';
import { afterEach, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';
import { allKits, brandTheme, applyKitTheme, findKit, kitSummary, membersOf, registerKit, unregisterKit, writeKitBoards, writeKitTokens, type Kit } from '../src/kits/index.ts';

function build(kit: Kit) {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const out = doc.transact(() => {
    writeKitTokens(doc, kit, true);
    return writeKitBoards(doc, page, kit);
  });
  return { doc, page, ...out };
}

const KITS = allKits().filter((k) => k.source === 'builtin');

describe('kits', () => {
  it('has the built-in kits, shadcn/ui first, with a phone kit and an iOS-like one without vendor fonts', () => {
    expect(KITS.map((k) => k.id)).toEqual(['shadcn', 'shadcn-base-ui', 'radix-themes', 'bootstrap-5', 'material-3', 'ionic-ios']);
    expect(KITS.find((k) => k.platform === 'android')?.id).toBe('material-3');
    const ios = KITS.find((k) => k.platform === 'ios-like')!;
    // No platform vendor's fonts, by name or by the keywords that resolve to them.
    expect(JSON.stringify(ios)).not.toMatch(/SF Pro|San Francisco|-apple-system|BlinkMacSystemFont|Apple/);
    for (const k of KITS) expect(['MIT', 'Apache-2.0']).toContain(k.library.license);
    expect(findKit('shadcn/ui').components.length).toBeGreaterThanOrEqual(25);
  });

  for (const kit of KITS) {
    describe(kit.name, () => {
      it('renders every member as a main of its set, with only its own tokens', () => {
        const { doc, boards, mains } = build(kit);
        expect(mains.length).toBe(kit.components.reduce((n, c) => n + membersOf(c).length, 0));
        expect(listMains(doc.source).length).toBe(mains.length);
        const html = boards.map((b) => nodeToHtml(doc, b)).join('\n');
        expect(html).not.toMatch(/undefined|NaN|\[object/);
        // Every variable a component uses is one of the kit's tokens, so a theme reaches all of it.
        const names = new Set(kit.tokens.map((t) => t.name));
        const used = new Set([...html.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]!));
        expect([...used].filter((n) => !names.has(n) && n !== 'kit-showcase-font')).toEqual([]);
        // A dark board shows one instance per component in the dark mode.
        expect(boards.length).toBe(2);
        expect(doc.getNode(boards[1]!)!.mode).toBe('dark');
        expect(doc.tokens.size).toBe(kit.tokens.length);
      });

      it('switches the variants of every set', () => {
        const { doc, page } = build(kit);
        for (const c of kit.components.filter((k) => k.axes && membersOf(k).length > 1)) {
          const axes = variantAxes(doc.source, c.name);
          expect(axes.map((a) => a.axis).sort()).toEqual(Object.keys(c.axes!).sort());
          const [first, second] = membersOf(c) as [Record<string, string>, Record<string, string>];
          const a = findMain(doc.source, c.name, first)!;
          const b = findMain(doc.source, c.name, second)!;
          expect(a && b && a.id !== b.id, `${c.name}: ${JSON.stringify(second)}`).toBe(true);
          const inst = createInstance(doc, a.id, page);
          const before = nodeToHtml(doc, inst);
          // As the inspector and instance_set do it: a variant value is a control like a prop.
          setInstanceProps(doc, inst, second);
          expect(doc.getNode(inst)!.instanceOf).toBe(b.id);
          expect(nodeToHtml(doc, inst), `${kit.name} ${c.name}`).not.toBe(before);
        }
      });

      it('hands every component off as an import of its library', () => {
        const { doc, page } = build(kit);
        const frame = doc.insert(page, { type: 'frame', tag: 'div', name: 'Screen', style: { display: 'flex' } });
        for (const c of kit.components) {
          expect(readHandoff(c.handoff), c.name).toEqual(c.handoff);
          expect(readHandoff(findMain(doc.source, c.name, membersOf(c)[0])!.component!.handoff)!.from).toBe(c.handoff.from);
          const main = findMain(doc.source, c.name, membersOf(c)[0])!;
          createInstance(doc, main.id, frame);
        }
        const code = toReact(doc, frame);
        for (const c of kit.components) {
          expect(code).toContain(`from "${c.handoff.from}"`);
          const tag = c.handoff.usage ? /<([A-Z][\w.]*)/.exec(c.handoff.usage)![1]! : c.handoff.name;
          expect(code, `${kit.name} ${c.name}`).toContain(`<${tag}`);
        }
        // The library's components are imported, not written out.
        expect(code).not.toContain('export function Button(');
        expect(code).not.toMatch(/written out in full/);
      });
    });
  }

  it('writes shadcn usages in shadcn\'s own props', () => {
    const { doc, page } = build(findKit('shadcn'));
    const frame = doc.insert(page, { type: 'frame', tag: 'div', name: 'Form', style: {} });
    const outline = findMain(doc.source, 'Button', { variant: 'outline', size: 'sm' }) ?? findMain(doc.source, 'Button', { variant: 'outline', size: 'default' })!;
    const id = createInstance(doc, outline.id, frame);
    setInstanceProps(doc, id, { label: 'Save' });
    createInstance(doc, findMain(doc.source, 'Checkbox', { checked: 'true' })!.id, frame);
    createInstance(doc, findMain(doc.source, 'Input', { state: 'invalid' })!.id, frame);
    const code = toReact(doc, frame);
    expect(code).toContain('import { Button } from "@/components/ui/button";');
    expect(code).toContain('import { Checkbox } from "@/components/ui/checkbox";');
    expect(code).toContain('import { Label } from "@/components/ui/label";');
    expect(code).toContain('<Button variant="outline">Save</Button>');
    expect(code).toMatch(/<Checkbox id="terms" defaultChecked \/>/);
    expect(code).toMatch(/<Input aria-invalid="true" placeholder="you@example.com" \/>/);
  });

  it('writes shadcn on Base UI in Base UI\'s API, and Radix with the provider its Tooltip needs', () => {
    const everything = (id: string) => {
      const { doc, page } = build(findKit(id));
      const frame = doc.insert(page, { type: 'frame', tag: 'div', name: 'Screen', style: {} });
      for (const c of findKit(id).components) createInstance(doc, findMain(doc.source, c.name, membersOf(c)[0])!.id, frame);
      return toReact(doc, frame);
    };
    const base = everything('shadcn-base-ui');
    expect(base).not.toContain('asChild');
    expect(base).toContain('<DropdownMenuTrigger render={<Button variant="outline" />}>Open</DropdownMenuTrigger>');
    expect(base).toContain('<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>');
    expect(base).toContain('<Accordion defaultValue={["item-1"]}>');
    expect(base).toContain('import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup,');
    expect(base).not.toContain('TooltipProvider');
    const radix = everything('shadcn');
    expect(radix).toContain('<DropdownMenuTrigger asChild>');
    expect(radix).toMatch(/<TooltipProvider>\n\s+<Tooltip>/);
    expect(radix).toContain('import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";');
    // The same drawings and tokens: only the code differs.
    expect(findKit('shadcn-base-ui').tokens).toEqual(findKit('shadcn').tokens);
  });

  it('lets a usage hold a list of strings or one element as a value, and nothing that runs', () => {
    expect(safeUsage('<Accordion defaultValue={["item-1", "item-2"]}>{{children}}</Accordion>')).toBe(true);
    expect(safeUsage('<DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>')).toBe(true);
    expect(safeUsage('<A onClick={() => fetch("x")} />')).toBe(false);
    expect(safeUsage('<A value={["a", x]} />')).toBe(false);
    expect(safeUsage('<A render={<Button onClick={go} />} />')).toBe(false);
    expect(safeUsage('<A render={<script src="x" />} />')).toBe(false);
    expect(safeUsage('<A render={<B />} x={y} />')).toBe(false);
    expect(safeUsage('<A v={["a`b"]} />')).toBe(false);
  });

  // Against real shadcn projects: `npx shadcn init -t vite -b radix` and `-b base`, then `shadcn add` of every
  // component the kit has. Set BOGEN_SHADCN_RADIX and BOGEN_SHADCN_BASE to those folders to run it.
  for (const [id, env] of [['shadcn', 'BOGEN_SHADCN_RADIX'], ['shadcn-base-ui', 'BOGEN_SHADCN_BASE']] as const) {
    const project = process.env[env];
    it.skipIf(!project || !existsSync(join(project, 'components.json')))(`hands off every ${id} member as code that type-checks in a real shadcn project`, () => {
      const kit = findKit(id);
      const { doc, page } = build(kit);
      const frame = doc.insert(page, { type: 'frame', tag: 'div', name: 'Every member', style: { display: 'flex', flexDirection: 'column' } });
      for (const c of kit.components) for (const m of membersOf(c)) createInstance(doc, findMain(doc.source, c.name, m)!.id, frame);
      const file = join(project!, 'src', 'BogenKitCheck.tsx');
      writeFileSync(file, toReact(doc, frame));
      try {
        execFileSync('npx', ['tsc', '-p', 'tsconfig.app.json', '--noEmit'], { cwd: project, stdio: 'pipe', timeout: 120_000 });
      } catch (e) {
        throw new Error(String((e as { stdout?: Buffer }).stdout ?? e));
      } finally {
        rmSync(file, { force: true });
      }
    }, 150_000);
  }

  it('writes MUI for Material 3 in MUI\'s names', () => {
    const { doc, page } = build(findKit('material-3'));
    const frame = doc.insert(page, { type: 'frame', tag: 'div', name: 'Screen', style: {} });
    createInstance(doc, findMain(doc.source, 'Button', { variant: 'tonal' })!.id, frame);
    createInstance(doc, findMain(doc.source, 'Button', { variant: 'outlined' })!.id, frame);
    const code = toReact(doc, frame);
    expect(code).toContain('import { Button } from "@mui/material";');
    expect(code).toContain('<Button color="secondary" variant="contained">Button</Button>');
    expect(code).toContain('<Button variant="outlined">Button</Button>');
  });

  it('maps a brand and a theme onto a kit\'s own token names', () => {
    const kit = findKit('shadcn');
    const brand = { colors: [{ name: 'Blue', role: 'primary', value: '#2b3df2', token: 'brand-blue' }, { name: 'Paper', role: 'background', value: '#f4f2ec' }], families: [{ role: 'body', family: 'Archivo', fallback: 'sans-serif' }], radius: [{ value: 0 }] } as never;
    const theme = brandTheme(kit, brand);
    expect(theme).toMatchObject({ primary: 'var(--brand-blue)', background: '#f4f2ec', 'font-sans': 'Archivo, sans-serif', radius: '0px' });
    const { doc } = build(kit);
    doc.transact(() => applyKitTheme(doc, kit, theme));
    expect(doc.tokens.get('primary')!.get('value')).toBe('var(--brand-blue)');
    // One brand colour for both modes, unless a mode is named.
    expect(doc.tokens.get('primary')!.get('mode:dark')).toBeUndefined();
    expect(() => applyKitTheme(doc, kit, { 'md-sys-color-primary': '#000' })).toThrow(/no token/);
  });

  it('registers a kit from code, and refuses one without a valid handoff', () => {
    const kit: Kit = {
      id: 'acme-ds', name: 'Acme DS', description: 'From a repository.', platform: 'web', font: 'Inter', version: 1,
      library: { name: 'Acme', package: '@acme/ui', license: 'MIT', url: 'https://example.com' },
      tokens: [{ name: 'acme-primary', kind: 'color', light: '#000' }],
      components: [{ name: 'Button', group: 'Actions', description: '', html: () => '<button data-name="Button">Go</button>', handoff: { from: '@acme/ui', name: 'Button' } }],
    };
    registerKit(kit);
    expect(findKit('acme-ds').source).toBe('code');
    expect(kitSummary(findKit('acme-ds')).components[0]!.import).toBe('import { Button } from "@acme/ui";');
    expect(() => registerKit({ ...kit, id: 'acme-bad', components: [{ ...kit.components[0]!, handoff: { from: '../x', name: 'button' } }] })).toThrow(/handoff/);
    expect(() => registerKit({ ...kit, id: 'shadcn' })).toThrow(/built-in/);
    unregisterKit('acme-ds');
  });
});

describe('kit tools', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.cleanup();
  });

  it('lists kits, uses shadcn/ui in a file as a linked library, and hands off its imports', async () => {
    const h = await startServer();
    harnesses.push(h);
    const client = await connectAgent(h.base, 'claude');
    const list = await call(client, 'kit_list');
    expect(list.kits.map((k: { id: string }) => k.id)).toEqual(['shadcn', 'shadcn-base-ui', 'radix-themes', 'bootstrap-5', 'material-3', 'ionic-ios']);
    expect((await call(client, 'template_list')).kits.length).toBe(6);
    const file = await call(client, 'file_create', { name: 'App' });
    const used = await call(client, 'kit_use', { kit: 'shadcn', file_id: file.id, theme: { primary: '#2b3df2' } });
    expect(used.library.created).toBe(true);
    // Linking brings the tokens its components use; kit_use adds the rest.
    expect(used.tokens_added).toEqual(['ring']);
    expect(used.themed).toEqual(['primary']);
    // Made once per device: a second file links the same library file.
    const other = await call(client, 'file_create', { name: 'Other' });
    const again = await call(client, 'kit_use', { kit: 'shadcn/ui', file_id: other.id });
    expect(again.library).toMatchObject({ id: used.library.id, created: false });

    const { doc } = await h.server.rooms.get(file.id);
    expect(doc.tokens.get('primary')!.get('value')).toBe('#2b3df2');
    expect(findKit('shadcn').tokens.every((t) => doc.tokens.has(t.name))).toBe(true);
    expect(doc.tokens.get('background')!.get('mode:dark')).toBe('oklch(0.145 0 0)');
    // The kit's own file is its showcase: a light board with every main and a dark board.
    const kitDoc = (await h.server.rooms.get(used.library.id)).doc;
    expect(kitDoc.getChildren(kitDoc.getPages()[0]!.id).map((b) => b.name)).toEqual(['shadcn/ui', 'shadcn/ui, dark']);

    const page = doc.getPages()[0]!.id;
    const frame = await call(client, 'html_write', { file_id: file.id, parent_id: page, html: '<div style="display:flex;gap:8px;width:600px"></div>' });
    const parent = frame.ids[0];
    await call(client, 'instance_create', { file_id: file.id, component: 'Button', variant: { variant: 'secondary' }, props: { label: 'Cancel' }, parent_id: parent });
    await call(client, 'instance_create', { file_id: file.id, component: 'Card', parent_id: parent });
    const code = await call(client, 'code_get', { file_id: file.id, node_id: parent, format: 'react-tailwind' });
    const text = typeof code === 'string' ? code : code.code;
    expect(text).toContain('import { Button } from "@/components/ui/button";');
    expect(text).toContain('import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";');
    expect(text).toContain('<Button variant="secondary">Cancel</Button>');
    expect(text).toContain('<CardTitle>Card title</CardTitle>');
  }, 60_000);

  it('offers kits to the editor, which links the library and writes the tokens itself', async () => {
    const h = await startServer();
    harnesses.push(h);
    const list = await (await fetch(`${h.base}/api/kits`)).json() as { id: string; tokenValues: unknown[] }[];
    expect(list.map((k) => k.id)).toEqual(['shadcn', 'shadcn-base-ui', 'radix-themes', 'bootstrap-5', 'material-3', 'ionic-ios']);
    expect(list[0]!.tokenValues).toContainEqual({ name: 'primary', kind: 'color', light: 'oklch(0.205 0 0)', dark: 'oklch(0.922 0 0)', role: 'primary' });
    const made = await (await fetch(`${h.base}/api/kits/material-3/library`, { method: 'POST' })).json() as { fileId: string; created: boolean };
    expect(made.created).toBe(true);
    const again = await (await fetch(`${h.base}/api/kits/material-3/library`, { method: 'POST' })).json() as { fileId: string; created: boolean };
    expect(again).toEqual({ fileId: made.fileId, created: false });
    expect((await fetch(`${h.base}/api/libraries/${made.fileId}`)).status).toBe(200);
    expect((await fetch(`${h.base}/api/kits/tailwind-plus/library`, { method: 'POST' })).status).toBe(404);
  }, 60_000);

  it('hands off a component of the file\'s own to a code library with component_update', async () => {
    const h = await startServer();
    harnesses.push(h);
    const client = await connectAgent(h.base, 'claude');
    const file = await call(client, 'file_create', { name: 'Own' });
    const page = (await h.server.rooms.get(file.id)).doc.getPages()[0]!.id;
    const written = await call(client, 'html_write', { file_id: file.id, parent_id: page, html: '<button style="display:flex;gap:4px;padding:8px"><span data-name="Label">Go</span><span data-name="Mark">+</span></button>' });
    await call(client, 'component_create', { file_id: file.id, node_ids: [written.ids[0]], name: 'Action', props: [{ name: 'label', type: 'text', target: 'Label' }] });
    await call(client, 'component_update', { file_id: file.id, component: 'Action', handoff: { from: '@acme/ui', name: 'ActionButton', props: { label: 'children' } } });
    const box = await call(client, 'html_write', { file_id: file.id, parent_id: page, html: '<div style="display:flex"><x-instance component="Action" prop-label="Send"></x-instance></div>' });
    const code = await call(client, 'code_get', { file_id: file.id, node_id: box.ids[0], format: 'react-inline' });
    const text = typeof code === 'string' ? code : code.code;
    expect(text).toContain('import { ActionButton } from "@acme/ui";');
    expect(text).toContain('<ActionButton>Send</ActionButton>');
    await expect(call(client, 'component_update', { file_id: file.id, component: 'Action', handoff: { from: '../../etc', name: 'X' } })).rejects.toThrow(/handoff is not valid/);
  }, 60_000);
});
