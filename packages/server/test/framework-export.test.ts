import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BogenDoc, createComponent, createInstance, findMain, importHtml, setInstanceProps, setTokenMode, toSfc, toSwiftUI, updateComponent, type NewNode } from '@bogen/core';
import { iconSpec } from '@bogen/core/icons';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { allKits, membersOf, writeKitBoards, writeKitTokens } from '../src/kits/index.ts';
import { handoffCode } from '../src/code-handoff.ts';
import { call, callRaw, connectAgent, startServer } from './helpers.ts';


/** Adds one root of HTML under a parent and returns its id. */
function html(doc: BogenDoc, parent: string, markup: string): string {
  const { nodes } = importHtml(markup);
  const [id] = doc.insertMany(parent, nodes as NewNode[]) as [string];
  doc.invalidate();
  return id;
}

/**
 * A screen with what the handoff has to say: tokens in light and dark, a set of the file's own with a variant axis,
 * text and boolean props, a component with a slot that an instance fills, a markup kit (daisyUI) and a React kit
 * (shadcn/ui), an image, an icon, a layer placed absolutely, and a keyframe animation.
 */
function screen() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const kits = { daisy: allKits().find((k) => k.id === 'daisyui')!, shadcn: allKits().find((k) => k.id === 'shadcn')! };
  const ids = doc.transact(() => {
    writeKitTokens(doc, kits.daisy, true);
    writeKitTokens(doc, kits.shadcn);
    writeKitBoards(doc, page, kits.daisy);
    writeKitBoards(doc, page, kits.shadcn);
    doc.setToken('accent', 'color', '#2563eb');
    setTokenMode(doc, 'accent', 'dark', '#60a5fa');
    doc.setToken('space-3', 'spacing', '12px');
    doc.meta.set('keyframes', ['@keyframes rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }']);
    const lib = doc.insert(page, { type: 'frame', tag: 'div', name: 'Library', style: { position: 'absolute', left: '-2000px', top: '0px', display: 'flex', gap: '8px' } });
    doc.invalidate();
    const tag = (tone: string, bg: string) => {
      const id = html(doc, lib, `<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;background:${bg};color:#ffffff;font-size:13px;font-weight:600"><span data-name="Dot" style="width:6px;height:6px;border-radius:999px;background:#ffffff"></span><span data-name="Label">${tone === 'neutral' ? 'Draft' : 'Paid'}</span></span>`);
      createComponent(doc, id, { name: `Tag / ${tone}`, description: 'A short status.', set: 'Tag', variant: { tone } });
      doc.invalidate();
      const label = doc.descendants(id).find((n) => n.name === 'Label')!.id;
      const dot = doc.descendants(id).find((n) => n.name === 'Dot')!.id;
      updateComponent(doc, id, { props: [{ name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] }, { name: 'show-dot', type: 'boolean', targets: [{ path: dot, field: 'visible' }] }] });
      doc.invalidate();
      return id;
    };
    const neutral = tag('neutral', '#475569');
    const positive = tag('positive', 'var(--accent)');
    const card = html(doc, lib, '<article style="display:flex;flex-direction:column;gap:var(--space-3);padding:20px;border-radius:12px;border:1px solid #e2e8f0;background:#ffffff;box-shadow:0 1px 3px rgb(0 0 0 / 0.1)"><h2 data-name="Title" style="margin:0;font-size:18px">Invoice 1042</h2><div data-name="Body" data-slot="body" style="display:flex;flex-direction:column;gap:8px"><p data-name="Fallback" style="margin:0">Nothing here yet.</p></div></article>');
    createComponent(doc, card, { name: 'Card', description: 'A card with a title and a slot for its body.' });
    doc.invalidate();
    updateComponent(doc, card, { props: [{ name: 'title', type: 'text', targets: [{ path: doc.descendants(card).find((n) => n.name === 'Title')!.id, field: 'text' }] }] });
    doc.invalidate();
    const board = doc.insert(page, { type: 'frame', tag: 'main', name: 'Billing screen', artboard: true, style: { position: 'absolute', left: '4000px', top: '0px', width: '390px', display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px', backgroundColor: 'var(--color-base-100)', color: 'var(--color-base-content)', fontFamily: 'var(--font-sans)' } });
    doc.invalidate();
    html(doc, board, '<h1 style="margin:0;font-size:28px;line-height:34px;font-weight:700;animation:rise 600ms ease-out both">Billing</h1>');
    const row = html(doc, board, '<div style="display:flex;justify-content:space-between;align-items:center;position:relative"><img data-name="Logo" src="https://example.com/logo.png" alt="Northwind" style="width:32px;height:32px;border-radius:8px"><span data-name="Count" style="position:absolute;left:24px;top:-4px;font-size:11px">3</span></div>');
    const icon = doc.insert(row, { ...iconSpec('check', { size: 20 }), name: 'check' });
    doc.invalidate();
    const tags = createInstance(doc, positive, row);
    setInstanceProps(doc, tags, { label: 'Paid', 'show-dot': false });
    createInstance(doc, neutral, row);
    const cardUse = createInstance(doc, card, board);
    setInstanceProps(doc, cardUse, { title: 'Invoice 1043' });
    // A fill of the slot: the instance's own child in the slot named body.
    const fill = doc.insert(cardUse, { type: 'text', tag: 'p', name: 'Due', text: 'Due on 3 December. {Paid by card}', style: { margin: '0' }, slot: doc.descendants(card).find((n) => n.name === 'Body')!.id } as NewNode);
    const daisy = createInstance(doc, findMain(doc.source, 'Button', { color: 'primary', style: 'outline', size: 'md' })!.id, board);
    setInstanceProps(doc, daisy, { label: 'Pay now' });
    // Not a Button: two kits in one file each with a set named Button would be one set to code.
    createInstance(doc, findMain(doc.source, 'Switch', { checked: 'true' })!.id, board);
    return { board, icon, fill };
  });
  return { doc, ...ids };
}

function vueErrors(files: { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((x) => x.path.endsWith('.vue'))) {
    const { descriptor, errors } = parse(f.text, { filename: f.path });
    out.push(...errors.map((e) => `${f.path}: ${String(e)}`));
    try {
      const script = descriptor.scriptSetup || descriptor.script ? compileScript(descriptor, { id: f.path }) : undefined;
      const tpl = compileTemplate({ source: descriptor.template!.content, filename: f.path, id: f.path, compilerOptions: { bindingMetadata: script?.bindings, expressionPlugins: ['typescript'] } });
      out.push(...tpl.errors.map((e) => `${f.path}: ${String(e)}`));
    } catch (e) {
      out.push(`${f.path}: ${(e as Error).message}`);
    }
  }
  return out;
}

function svelteErrors(files: { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((x) => x.path.endsWith('.svelte'))) {
    try {
      const r = compile(f.text, { filename: f.path, generate: 'client' });
      out.push(...r.warnings.filter((w) => !/^a11y_/.test(w.code)).map((w) => `${f.path}: ${w.code}: ${w.message}`));
    } catch (e) {
      out.push(`${f.path}: ${(e as Error).message}`);
    }
  }
  return out;
}

const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status === 0;

/** swiftc -parse: the syntax, where swiftc is. SwiftUI itself is not on Linux, so the types are not checked here. */
function swiftParseErrors(files: { path: string; text: string }[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-swift-'));
  try {
    const paths = files.filter((f) => f.path.endsWith('.swift')).map((f) => {
      const p = join(dir, f.path);
      writeFileSync(p, f.text);
      return p;
    });
    const r = spawnSync('swiftc', ['-parse', ...paths], { encoding: 'utf8', timeout: 120_000 });
    return r.status === 0 ? [] : [r.stderr || r.stdout || `exit ${r.status}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Vue and Svelte export', () => {
  it('writes components as files with typed props, instances as usages, and markup kits as their markup, and they compile', () => {
    const { doc, board } = screen();
    const vue = toSfc(doc, board, 'vue');
    expect(vue.files.map((f) => f.path).sort()).toEqual(['BillingScreen.vue', 'Card.vue', 'Switch.vue', 'Tag.vue', 'bogen.css']);
    expect(vue.entry).toBe('BillingScreen.vue');
    expect(vueErrors(vue.files)).toEqual([]);
    const page = vue.files.find((f) => f.path === 'BillingScreen.vue')!.text;
    expect(page).toContain("import './bogen.css';");
    expect(page).toContain("import Tag from './Tag.vue';");
    expect(page).toContain('<Tag tone="positive" label="Paid" :showDot="false" />');
    expect(page).toContain('<Tag />');
    // The first slot is the default one, as children are in React; braces in text are text, not an expression.
    expect(page).toMatch(/<Card title="Invoice 1043">\n\s+<p style="margin:0;white-space:pre-wrap">Due on 3 December\. &#123;Paid by card&#125;<\/p>/);
    // daisyUI is markup with its classes, one class attribute.
    expect(page).toContain('<button class="btn btn-primary btn-outline">Pay now</button>');
    const tag = vue.files.find((f) => f.path === 'Tag.vue')!.text;
    expect(tag).toContain("tone?: 'neutral' | 'positive'");
    expect(tag).toContain("<template v-if=\"tone === 'positive'\">");
    expect(tag).toContain("{{ label ?? 'Paid' }}");
    expect(tag).toMatch(/v-if="showDot \?\? true"/);
    expect(tag).toContain('showDot: undefined');
    const card = vue.files.find((f) => f.path === 'Card.vue')!.text;
    expect(card).toMatch(/<slot>\n\s+<p style="margin:0;white-space:pre-wrap">Nothing here yet\.<\/p>\n\s+<\/slot>/);
    // shadcn/ui is React: its Switch is written from its drawing, and the notes say so.
    expect(vue.notes.join(' ')).toMatch(/Switch \(Switch of @\/components\/ui\/switch\) stands for a component of @\/components, a React library/);
    expect(vue.files.find((f) => f.path === 'Switch.vue')!.text).toContain("checked?: 'false' | 'true'");
    const css = vue.files.find((f) => f.path === 'bogen.css')!.text;
    expect(css).toContain('--accent:#2563eb');
    expect(css).toMatch(/\[data-mode="dark"\]\{[^}]*--accent:#60a5fa/);
    expect(css).toContain('@keyframes rise');
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(page).not.toContain('animation:');
  });

  it('writes Svelte 5 with runes and snippets, and it compiles', () => {
    const { doc, board } = screen();
    const svelte = toSfc(doc, board, 'svelte');
    expect(svelte.files.map((f) => f.path).sort()).toEqual(['BillingScreen.svelte', 'Card.svelte', 'Switch.svelte', 'Tag.svelte', 'bogen.css']);
    expect(svelteErrors(svelte.files)).toEqual([]);
    const tag = svelte.files.find((f) => f.path === 'Tag.svelte')!.text;
    expect(tag).toContain("let { tone = 'neutral', label, showDot, class: className = '', style = '' }: { tone?: 'neutral' | 'positive'; label?: string; showDot?: boolean; class?: string; style?: string } = $props();");
    expect(tag).toContain("{#if tone === 'positive'}");
    expect(tag).toContain("{label ?? 'Paid'}");
    const card = svelte.files.find((f) => f.path === 'Card.svelte')!.text;
    expect(card).toContain("import type { Snippet } from 'svelte';");
    expect(card).toContain('{@render children()}');
    const page = svelte.files.find((f) => f.path === 'BillingScreen.svelte')!.text;
    expect(page).toContain('<Tag tone="positive" label="Paid" showDot={false} />');
    expect(page).toMatch(/<Card title="Invoice 1043">\n\s+<p/);
    expect(page).toContain('<button class="btn btn-primary btn-outline">Pay now</button>');
  });

  it('compiles every member of every kit in Vue and Svelte', () => {
    for (const kit of allKits().filter((k) => k.source === 'builtin')) {
      const doc = new BogenDoc();
      doc.ensureFirstPage();
      const page = doc.getPages()[0]!.id;
      const frame = doc.transact(() => {
        writeKitTokens(doc, kit, true);
        writeKitBoards(doc, page, kit);
        const f = doc.insert(page, { type: 'frame', tag: 'div', name: 'Every member', style: { display: 'flex', flexDirection: 'column' } });
        for (const c of kit.components) for (const m of membersOf(c)) createInstance(doc, findMain(doc.source, c.name, m)!.id, f);
        return f;
      });
      expect(vueErrors(toSfc(doc, frame, 'vue').files), kit.id).toEqual([]);
      expect(svelteErrors(toSfc(doc, frame, 'svelte').files), kit.id).toEqual([]);
    }
  }, 120_000);
});

describe('SwiftUI export', () => {
  it('writes views with props and variant enums, usages, stacks, tokens in light and dark, and motion that reduce motion stops', () => {
    const { doc, board } = screen();
    const out = toSwiftUI(doc, board);
    expect(out.files.map((f) => f.path).sort()).toEqual(['BillingScreenView.swift', 'ButtonView.swift', 'CardView.swift', 'SwitchView.swift', 'TagView.swift', 'Tokens.swift']);
    const tag = out.files.find((f) => f.path === 'TagView.swift')!.text;
    expect(tag).toContain('enum Tone: String, CaseIterable {');
    expect(tag).toContain('var tone: Tone = .neutral');
    expect(tag).toContain('var label: String? = nil');
    expect(tag).toContain('if tone == .positive {');
    expect(tag).toContain('Text(label ?? "Paid")');
    expect(tag).toContain('if showDot ?? true {');
    expect(tag).toContain('.background(Tokens.accent, in: Capsule())');
    const card = out.files.find((f) => f.path === 'CardView.swift')!.text;
    expect(card).toContain('var content: AnyView? = nil');
    expect(card).toContain('if let content {');
    expect(card).toContain('.overlay {');
    expect(card).toContain('.shadow(color: Color(hex: 0x000000, opacity: 0.1), radius: 1.5, x: 0, y: 1)');
    const screenFile = out.files.find((f) => f.path === 'BillingScreenView.swift')!.text;
    expect(screenFile).toContain('TagView(\n');
    expect(screenFile).toMatch(/CardView\(\n\s+title: "Invoice 1043",\n\s+content: AnyView\(VStack/);
    expect(screenFile).toMatch(/tone: \.positive,\n\s+label: "Paid",\n\s+showDot: false/);
    expect(screenFile).toContain('HStack(alignment: .center, spacing: 0) {');
    expect(screenFile).toContain('Spacer(minLength: 0)');
    expect(screenFile).toContain('ZStack(alignment: .topLeading)');
    expect(screenFile).toContain('.offset(x: 24, y: -4)');
    expect(screenFile).toContain('AsyncImage(url: URL(string: "https://example.com/logo.png"))');
    expect(screenFile).toContain('Image("check")');
    expect(screenFile).toContain('@Environment(\\.accessibilityReduceMotion) private var reduceMotion');
    expect(screenFile).toContain('if reduceMotion { animate1 = true } else { withAnimation(Animation.easeOut(duration: 0.6)) { animate1 = true } }');
    expect(screenFile).toContain('.opacity(animate1 ? 1 : 0)');
    expect(screenFile).toContain('.offset(x: animate1 ? 0 : 0, y: animate1 ? 0 : 8)');
    const tokens = out.files.find((f) => f.path === 'Tokens.swift')!.text;
    expect(tokens).toContain('static let accent = Color(light: Color(hex: 0x2563EB), dark: Color(hex: 0x60A5FA))');
    expect(tokens).toContain('init(light: Color, dark: Color)');
    expect(out.assets.map((a) => a.name)).toContain('check');
    expect(out.notes.join(' ')).toMatch(/asset catalog/);
    // daisyUI and shadcn/ui are web libraries: written as views of their own, and said so.
    expect(out.notes.join(' ')).toMatch(/ButtonView \(Button of daisyui\)[^.]*of daisyui on the web/);
  });

  it.skipIf(!swiftc)('writes Swift that swiftc parses, for the screen and every kit', () => {
    const { doc, board } = screen();
    expect(swiftParseErrors(toSwiftUI(doc, board).files)).toEqual([]);
    for (const kit of allKits().filter((k) => k.source === 'builtin')) {
      const kdoc = new BogenDoc();
      kdoc.ensureFirstPage();
      const page = kdoc.getPages()[0]!.id;
      const frame = kdoc.transact(() => {
        writeKitTokens(kdoc, kit, true);
        writeKitBoards(kdoc, page, kit);
        const f = kdoc.insert(page, { type: 'frame', tag: 'div', name: 'Every member', style: { display: 'flex', flexDirection: 'column' } });
        for (const c of kit.components) for (const m of membersOf(c)) createInstance(kdoc, findMain(kdoc.source, c.name, m)!.id, f);
        return f;
      });
      expect(swiftParseErrors(toSwiftUI(kdoc, frame).files), kit.id).toEqual([]);
    }
  }, 300_000);

  it('code_get text names each file and ends with what could not be said', () => {
    const { doc, board } = screen();
    for (const format of ['vue', 'svelte', 'swiftui'] as const) {
      const text = handoffCode(doc, board, format, 'http://127.0.0.1:1');
      expect(text).toMatch(/File: (BillingScreen|Tokens)/);
      expect(text).toContain('Not expressed or different from the canvas');
    }
    expect(() => handoffCode(doc, board, 'vue', 'http://127.0.0.1:1', 'framer')).toThrow(/Framer Motion is for React/);
  });
});

describe('Vue, Svelte and SwiftUI over MCP', () => {
  it('code_get gives the files as one text, and export_file writes a folder of them with the icons for the asset catalog', async () => {
    const h = await startServer();
    const agent = await connectAgent(h.base, 'export-agent');
    try {
      await call(agent, 'file_create', { name: 'Exports' });
      const board = (await call(agent, 'artboard_create', { name: 'Ticket screen', width: 390, height: 600, background: '#ffffff' })).id;
      await call(agent, 'html_write', { target_id: board, html: '<div data-name="Body" style="display:flex;flex-direction:column;gap:12px;padding:24px"><h1 style="font-size:28px;margin:0">Night train to Venice</h1></div>' });
      await call(agent, 'icon_insert', { name: 'tabler:train', parent_id: board });
      const vue = await call<string>(agent, 'code_get', { node_id: board, format: 'vue' });
      expect(vue).toContain('<!-- File: TicketScreen.vue -->');
      expect(vue).toContain('Night train to Venice');
      const res = await call(agent, 'export_file', { format: 'swiftui', node_ids: [board] });
      const folder = res.paths[0] as string;
      expect(folder).toBe(join(h.home, 'exports', 'ticket-screen-swiftui'));
      expect(res.exports[0].entry).toBe('TicketScreenView.swift');
      for (const f of ['Tokens.swift', 'TicketScreenView.swift', 'Assets/tabler-train.svg']) expect(existsSync(join(folder, f)), f).toBe(true);
      expect(readFileSync(join(folder, 'TicketScreenView.swift'), 'utf8')).toContain('Image("tabler-train")');
      const svelte = await call(agent, 'export_file', { format: 'svelte', node_ids: [board] });
      expect(readdirSync(svelte.paths[0]).sort()).toEqual(['TicketScreen.svelte', 'bogen.css']);
      const refused = await callRaw(agent, 'export_file', { format: 'vue', node_ids: [board], path: join(h.home, 'exports', 'Screen.vue') });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain('A vue export is a folder');
    } finally {
      await agent.close();
      await h.cleanup();
    }
  }, 60_000);
});



