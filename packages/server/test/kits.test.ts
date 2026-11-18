import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BogenDoc, contrastRatio, craftFindings, createInstance, effectiveMode, findMain, listMains, nodeToHtml, readHandoff, safeUsage, setInstanceProps, SPECIMEN_EXEMPT, tokenValueIn, tokensCss, toReact, variantAxes, type BogenNode } from '@bogen/core';
import { copyIssues } from '../src/mcp/copy-check.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';
import { allKits, brandTheme, applyKitTheme, quoteFamilies, findKit, kitSummary, membersOf, registerKit, unregisterKit, writeKitBoards, writeKitTokens, type Kit } from '../src/kits/index.ts';

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
const IDS = ['shadcn', 'shadcn-base-ui', 'radix-themes', 'bootstrap-5', 'material-3', 'ionic-ios', 'mantine', 'carbon', 'uswds', 'daisyui', 'web-awesome', 'pico'];
/** The kits of the second batch, which are also held to the craft and copy checks of shipped content. */
const CHECKED = new Set(['mantine', 'carbon', 'uswds', 'daisyui', 'web-awesome', 'pico']);

describe('kits', () => {
  it('has the built-in kits, shadcn/ui first, with a phone kit and an iOS-like one without vendor fonts', () => {
    expect(KITS.map((k) => k.id)).toEqual(IDS);
    expect(KITS.find((k) => k.platform === 'android')?.id).toBe('material-3');
    const ios = KITS.find((k) => k.platform === 'ios-like')!;
    // No platform vendor's fonts, by name or by the keywords that resolve to them.
    expect(JSON.stringify(ios)).not.toMatch(/SF Pro|San Francisco|-apple-system|BlinkMacSystemFont|Apple/);
    for (const k of KITS) expect(['MIT', 'Apache-2.0', 'CC0-1.0']).toContain(k.library.license);
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
        // A dark board shows one instance per component in the dark mode, for a kit that has one: USWDS has none.
        const dark = kit.tokens.some((t) => t.dark !== undefined);
        expect(boards.length).toBe(dark ? 2 : 1);
        if (dark) expect(doc.getNode(boards[1]!)!.mode).toBe('dark');
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
          // Markup is written as it is, with no import by name: only the scripts that define custom elements.
          if (c.handoff.element) {
            for (const m of c.handoff.side ?? []) expect(code).toContain(`import "${m}";`);
            expect(code, `${kit.name} ${c.name}`).toContain(`<${c.handoff.element}`);
            continue;
          }
          // What the system draws on a device (a status bar, a home indicator) is written as nothing.
          if (c.handoff.usage === '<></>') continue;
          expect(code).toContain(`from "${c.handoff.from}"`);
          const tag = c.handoff.usage ? /<([A-Z][\w.]*)/.exec(c.handoff.usage)![1]! : c.handoff.name;
          expect(code, `${kit.name} ${c.name}`).toContain(`<${tag}`);
        }
        // One class attribute per tag, however many classes the variants add.
        expect(code).not.toMatch(/<[a-z][\w-]*[^<>]*\sclassName="[^"]*"[^<>]*\sclassName="/);
        // The library's components are imported, not written out.
        expect(code).not.toContain('export function Button(');
        expect(code).not.toMatch(/written out in full/);
      });
    });
  }

  for (const kit of KITS.filter((k) => CHECKED.has(k.id))) {
    it(`${kit.name}: its showcase passes the craft and copy checks of shipped content`, () => {
      const { doc, boards } = build(kit);
      const craft = boards.flatMap((b) => craftFindings(doc, b).filter((f) => !SPECIMEN_EXEMPT.includes(f.rule)).map((f) => `${doc.getNode(f.nodeId)?.name}: ${f.rule}: ${f.message}`));
      expect(craft).toEqual([]);
      const copy = boards.flatMap((b) => copyIssues([doc.getNode(b)!, ...doc.descendants(b)], [], { doc }).map((f) => `${f.name}: ${f.quote}: ${f.message}`));
      expect(copy).toEqual([]);
      const html = boards.map((b) => nodeToHtml(doc, b)).join('\n');
      // The habits of the generated look that the newer checks name: small tracked capitals, glow, gradients, emoji.
      expect(html).not.toMatch(/text-transform:\s*uppercase/);
      expect(html).not.toMatch(/gradient\(/);
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(html).not.toMatch(/lorem|ipsum|john doe|jane doe|acme/i);
      // A brand maps onto it through its roles.
      for (const r of ['background', 'foreground', 'primary', 'font'] as const) expect(kit.tokens.some((t) => t.role === r), `${kit.id} ${r}`).toBe(true);
      const theme = brandTheme(kit, { colors: [{ name: 'Ink', role: 'primary', value: '#123456' }, { name: 'Paper', role: 'background', value: '#fafaf7' }, { name: 'Text', role: 'text', value: '#111111' }], families: [{ role: 'body', family: 'Archivo', fallback: 'sans-serif' }], radius: [{ value: 6 }] } as never);
      const primary = kit.tokens.find((t) => t.role === 'primary')!.name;
      expect(theme[primary]).toBe('#123456');
      expect(theme[kit.tokens.find((t) => t.role === 'font')!.name]).toBe('Archivo, sans-serif');
      const used = build(kit);
      used.doc.transact(() => applyKitTheme(used.doc, kit, theme));
      expect(used.doc.tokens.get(primary)!.get('value')).toBe('#123456');
      const themed = used.boards.map((b) => nodeToHtml(used.doc, b)).join('\n');
      expect(themed).toContain(`var(--${primary})`);
    });
  }

  it('writes markup handoffs as markup: one class attribute, HTML names as JSX, scripts of custom elements as imports', () => {
    const { doc, page } = build(findKit('daisyui'));
    const frame = doc.insert(page, { type: 'frame', tag: 'div', name: 'Form', style: {} });
    const outline = findMain(doc.source, 'Button', { color: 'secondary', style: 'solid', size: 'md' })!;
    const id = createInstance(doc, outline.id, frame);
    setInstanceProps(doc, id, { label: 'Pay now' });
    createInstance(doc, findMain(doc.source, 'Checkbox', { checked: 'true' })!.id, frame);
    createInstance(doc, findMain(doc.source, 'Input', { state: 'error' })!.id, frame);
    const code = toReact(doc, frame);
    expect(code).not.toContain('from "daisyui"');
    expect(code).toContain('<button className="btn btn-secondary">Pay now</button>');
    expect(code).toContain('<input type="checkbox" className="checkbox checkbox-primary" defaultChecked />');
    expect(code).toContain('className="input input-error"');
    expect(code).toContain('<legend className="fieldset-legend">Email</legend>');
  });

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

  describe('phone kit gaps', () => {
    function layer(doc: BogenDoc, root: string, name: string): BogenNode {
      const node = doc.descendants(root).find((n) => n.name === name);
      expect(node, name).toBeDefined();
      return node!;
    }

    // Start from the default and change one axis at a time, like prop-* in html_write.
    // Checking only two different HTML strings missed wrong-member selections in the past.
    for (const [id, names] of [
      ['material-3', ['Text field', 'Bottom sheet', 'Menu', 'Menu item']],
      ['ionic-ios', ['Button', 'Stepper', 'Date picker']],
    ] as const) {
      it(`${id}: every new member resolves exactly, in light and dark, and all its text is editable`, () => {
        const kit = findKit(id);
        const { doc, page, boards } = build(kit);
        for (const name of names) {
          const component = kit.components.find((c) => c.name === name)!;
          const expectedCount = Object.values(component.axes ?? {}).reduce((n, values) => n * values.length, 1);
          expect(membersOf(component)).toHaveLength(expectedCount);
          for (const mode of ['light', 'dark']) {
            const parent = mode === 'dark' ? boards[1]! : page;
            for (const variant of membersOf(component)) {
              const main = findMain(doc.source, name, variant)!;
              const instance = createInstance(doc, findMain(doc.source, name, membersOf(component)[0])!.id, parent);
              for (const [axis, value] of Object.entries(variant)) setInstanceProps(doc, instance, { [axis]: value });
              expect(doc.getNode(instance)!.instanceOf, JSON.stringify(variant)).toBe(main.id);
              expect(nodeToHtml(doc, instance)).toBe(nodeToHtml(doc, createInstance(doc, main.id, parent)));
              expect(nodeToHtml(doc, instance)).not.toMatch(/undefined|NaN|\[object/);
              if (mode === 'dark') expect(effectiveMode(doc, instance)).toBe('dark');
              const textLayers = doc.descendants(instance).filter((n) => n.type === 'text' && n.text);
              const targets = (component.props ?? []).filter((p) => p.type === 'text').map((p) => p.target);
              expect(textLayers.map((n) => n.name).filter((n) => !targets.includes(n))).toEqual([]);
              const copy = Object.fromEntries((component.props ?? []).filter((p) => p.type === 'text').map((p) => [p.name, `Edited ${p.name}`]));
              setInstanceProps(doc, instance, copy);
              for (const prop of component.props ?? []) if (prop.type === 'text') expect(layer(doc, instance, prop.target).text).toBe(copy[prop.name]);
            }
          }
        }
        for (const token of kit.tokens.filter((t) => t.dark !== undefined)) {
          expect(tokenValueIn(doc.getTokens().find((t) => t.name === token.name)!, 'dark')).toBe(token.dark);
          expect(tokensCss(doc)).toContain(`--${token.name}:${token.dark}`);
        }
      });
    }

    it('Material: all eight field members have the right 56dp container, line, label, supporting text and flags', () => {
      const { doc, page } = build(findKit('material-3'));
      for (const variant of ['filled', 'outlined']) for (const state of ['enabled', 'focused', 'error', 'disabled']) {
        const instance = createInstance(doc, findMain(doc.source, 'Text field', { variant, state })!.id, page);
        const field = layer(doc, instance, 'Field');
        const accent = `var(--md-sys-color-${state === 'error' ? 'error' : state === 'focused' ? 'primary' : 'on-surface-variant'})`;
        const lineColor = state === 'error' || state === 'focused' ? accent : variant === 'filled' ? 'var(--md-sys-color-on-surface-variant)' : 'var(--md-sys-color-outline)';
        expect(field.style.height).toBe('56px');
        expect(field.style.boxSizing).toBe('border-box');
        expect(field.style[variant === 'filled' ? 'borderBottom' : 'border']).toBe(`${state === 'focused' ? 2 : 1}px solid ${lineColor}`);
        expect(field.style.background).toBe(variant === 'filled' ? 'var(--md-sys-color-surface-container-highest)' : 'transparent');
        expect(layer(doc, instance, 'Label').style.color).toBe(accent);
        expect(layer(doc, instance, 'Label').style.position).toBe(variant === 'filled' ? undefined : 'absolute');
        expect(layer(doc, instance, 'Supporting').style.color).toBe(`var(--md-sys-color-${state === 'error' ? 'error' : 'on-surface-variant'})`);
        expect(layer(doc, instance, 'Error icon').style.display).toBe(state === 'error' ? 'flex' : 'none');
        expect(field.style.opacity).toBe(state === 'disabled' ? '0.38' : undefined);
        const code = toReact(doc, instance);
        expect(code).toContain(`variant="${variant}"`);
        expect(code).not.toMatch(/state=|enabled=|helper=/);
        for (const flag of ['focused', 'error', 'disabled']) expect(code.includes(` ${flag}`)).toBe(state === flag);
      }
    });

    it('Material: modal surface, menu items and divider keep platform sizes and usable slots', () => {
      const { doc, page } = build(findKit('material-3'));
      const sheet = createInstance(doc, findMain(doc.source, 'Bottom sheet')!.id, page);
      expect(doc.getNode(sheet)!.style.background).toContain('var(--md-sys-color-scrim)');
      expect(layer(doc, sheet, 'Sheet').style).toMatchObject({ width: '100%', maxWidth: '640px', borderRadius: '28px 28px 0 0' });
      expect(layer(doc, sheet, 'Sheet').attrs).toMatchObject({ role: 'dialog', 'aria-modal': 'true' });
      expect(layer(doc, sheet, 'Handle target').style.minHeight).toBe('48px');
      expect(layer(doc, sheet, 'Drag handle').style).toMatchObject({ width: '32px', height: '4px' });
      expect(layer(doc, sheet, 'Content').slotName).toBe('content');
      const fill = doc.insert(sheet, { type: 'text', tag: 'p', text: 'Sheet content', slot: 'content', style: {} });
      expect(nodeToHtml(doc, sheet)).toContain('Sheet content');
      expect(toReact(doc, sheet)).toContain('Sheet content');
      expect(doc.getNode(fill)).toBeDefined();
      expect(toReact(doc, sheet)).toContain('<Drawer anchor="bottom" open');
      const menu = createInstance(doc, findMain(doc.source, 'Menu')!.id, page);
      expect(doc.getNode(menu)!.style).toMatchObject({ width: '100%', maxWidth: '280px', padding: '8px 0' });
      expect(layer(doc, menu, 'Items').slotName).toBe('items');
      expect(layer(doc, menu, 'Divider').attrs?.role).toBe('separator');
      for (let i = 1; i <= 3; i++) {
        expect(layer(doc, menu, `Item ${i}`).style.minHeight).toBe('48px');
        expect(layer(doc, menu, `Item ${i} leading`).type).toBe('frame');
      }
      for (const state of ['enabled', 'disabled']) {
        const item = createInstance(doc, findMain(doc.source, 'Menu item', { state })!.id, menu);
        expect(layer(doc, item, 'Item leading').slotName).toBe('leading');
        expect(doc.getNode(item)!.style.minHeight).toBe('48px');
        expect(doc.getNode(item)!.style.opacity).toBe(state === 'disabled' ? '0.38' : undefined);
        expect(toReact(doc, item).includes(' disabled')).toBe(state === 'disabled');
      }
      const code = toReact(doc, menu);
      expect(code).toContain('<Menu open');
      expect(code).toContain('<Divider />');
      expect(code).toContain('<ListItemIcon>');
    });

    it('Ionic: all 32 button combinations keep their intended fill, size, width and disabled state', () => {
      const kit = findKit('ionic-ios');
      const { doc, page } = build(kit);
      for (const variant of membersOf(kit.components.find((c) => c.name === 'Button')!)) {
        const instance = createInstance(doc, findMain(doc.source, 'Button', variant)!.id, page);
        const root = doc.getNode(instance)!;
        const filled = variant.fill === 'solid' || variant.fill === 'tinted';
        expect(root.style.background).toBe(filled ? `var(--ion-color-${variant.fill === 'solid' ? 'primary' : 'light'})` : 'transparent');
        expect(root.style.color).toBe(filled ? `var(--ion-color-${variant.fill === 'solid' ? 'primary' : 'light'}-contrast)` : 'var(--ion-color-primary)');
        expect(root.style.border).toBe(variant.fill === 'outline' ? '1px solid var(--ion-color-primary)' : '0');
        expect(root.style.height).toBe(variant.size === 'large' ? '50px' : '44px');
        expect(root.style.minHeight).toBe('44px');
        expect(root.style.width).toBe(variant.width === 'full' ? '100%' : undefined);
        expect(root.style.opacity).toBe(variant.state === 'disabled' ? '0.5' : undefined);
        expect(root.attrs?.disabled !== undefined).toBe(variant.state === 'disabled');
        const code = toReact(doc, instance);
        expect(code.includes(' disabled')).toBe(variant.state === 'disabled');
        expect(code.includes('expand="block"')).toBe(variant.width === 'full');
        expect(code.includes('size="large"')).toBe(variant.size === 'large');
        expect(code.includes('color="light"')).toBe(variant.fill === 'tinted');
        if (variant.fill !== 'solid') expect(code).toContain(`fill="${variant.fill === 'tinted' ? 'solid' : variant.fill}"`);
        expect(code).not.toMatch(/width=|state=|fill="tinted"|size="default"/);
        expect((code.match(/size="large"/g) ?? []).length).toBe(variant.size === 'large' ? 1 : 0);
      }
    });

    it('Ionic: stepper and inline date wheels use native metrics and composed Ionic handoffs', () => {
      const { doc, page } = build(findKit('ionic-ios'));
      for (const state of ['enabled', 'disabled']) {
        const stepper = createInstance(doc, findMain(doc.source, 'Stepper', { state })!.id, page);
        expect(layer(doc, stepper, 'Stepper').style).toMatchObject({ width: '94px', height: '44px', maxWidth: '100%' });
        expect(layer(doc, stepper, 'Track').style).toMatchObject({ height: '32px', top: '6px' });
        for (const name of ['Decrease', 'Increase']) {
          expect(layer(doc, stepper, name).style).toMatchObject({ height: '44px', minWidth: '44px' });
          expect(layer(doc, stepper, name).attrs?.disabled !== undefined).toBe(state === 'disabled');
        }
        const stepperCode = toReact(doc, stepper);
        expect(stepperCode).toContain('<IonButtons');
        expect(stepperCode).not.toContain('IonStepper');
        expect((stepperCode.match(/ disabled/g) ?? []).length).toBe(state === 'disabled' ? 2 : 0);
        const date = createInstance(doc, findMain(doc.source, 'Date picker', { state })!.id, page);
        expect(layer(doc, date, 'Wheels').style).toMatchObject({ height: '200px', padding: '0 16px' });
        expect(layer(doc, date, 'Selection').style).toMatchObject({ height: '34px', top: '83px' });
        expect(layer(doc, date, 'Wheels').style.opacity).toBe(state === 'disabled' ? '0.5' : undefined);
        for (const column of ['Month', 'Day', 'Year']) {
          expect(layer(doc, date, column).style.minWidth).toBe('44px');
          expect(layer(doc, date, `${column} selected`).style).toMatchObject({ fontSize: '22px', lineHeight: '34px' });
        }
        setInstanceProps(doc, date, { value: '2027-05-09' });
        const dateCode = toReact(doc, date);
        expect(dateCode).toContain('<IonDatetime mode="ios" presentation="date" preferWheel size="cover"');
        expect(dateCode).toContain('value="2027-05-09"');
        expect(dateCode.includes(' disabled')).toBe(state === 'disabled');
        expect(dateCode).not.toMatch(/monthSelected|daySelected|yearSelected|state=/);
      }
    });

    it('keeps active text colours at WCAG AA in light and dark (disabled controls are exempt)', () => {
      const pairs = {
        'material-3': [
          ['on-surface', 'surface-container-low'], ['on-surface-variant', 'surface-container-low'],
          ['on-surface', 'surface-container'], ['on-surface-variant', 'surface-container'],
          ...['surface', 'surface-container-highest'].flatMap((bg) => ['on-surface', 'on-surface-variant', 'primary', 'error'].map((fg) => [fg, bg])),
        ],
        'ionic-ios': [['color-primary-contrast', 'color-primary'], ['color-light-contrast', 'color-light'], ['text-color', 'item-background'], ['color-medium', 'item-background'], ['color-primary', 'background-color'], ['color-primary', 'item-background']],
      };
      for (const [id, colours] of Object.entries(pairs)) {
        const kit = findKit(id);
        const { doc } = build(kit);
        const prefix = id === 'material-3' ? 'md-sys-color-' : 'ion-';
        for (const mode of ['light', 'dark']) for (const [fg, bg] of colours) {
          const resolve = (name: string) => tokenValueIn(doc.getTokens().find((t) => t.name === prefix + name)!, mode);
          expect(contrastRatio(resolve(fg!), resolve(bg!)), `${id} ${mode}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
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
    expect(list.kits.map((k: { id: string }) => k.id)).toEqual(IDS);
    expect((await call(client, 'template_list')).kits.length).toBe(IDS.length);
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
    expect(list.map((k) => k.id)).toEqual(IDS);
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

  it('quotes a theme\'s family names that CSS only reads in quotes', () => {
    expect(quoteFamilies('Source Sans 3, sans-serif')).toBe('"Source Sans 3", sans-serif');
    expect(quoteFamilies("'Alegreya Sans', serif")).toBe("'Alegreya Sans', serif");
    expect(quoteFamilies('Lato, system-ui')).toBe('Lato, system-ui');
    expect(quoteFamilies('var(--font-body)')).toBe('var(--font-body)');
  });
});
