import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { Browser } from 'puppeteer-core';
import { compile } from 'tailwindcss';
import { addVariant, applyTextStyle, BogenDoc, createComponent, createInstance, setTextStyle, textStyleCssFor, toReact, tokensCss, updateComponent } from '@bogen/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fontLinkTags, findBrowser, Renderer } from '../src/render.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * The react-tailwind handoff built for real: Bogen's code is compiled by Tailwind 4 (the same compiler
 * as `@tailwindcss/cli`, with its preflight), rendered in Chromium, and compared pixel by pixel with
 * Bogen's own render of the layer.
 */
const twDir = dirname(createRequire(import.meta.url).resolve('tailwindcss/package.json'));
const F = 'DejaVu Sans, sans-serif';

function load(code: string): Record<string, React.ComponentType> {
  const js = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, React.ComponentType> = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', 'React', 'require', js)(exports, React, (name: string) => (name === 'react' ? React : {}));
  return exports;
}

async function tailwindCss(input: string, candidates: string[]): Promise<string> {
  const compiler = await compile(input, {
    base: twDir,
    loadStylesheet: async (id: string) => {
      const name = /^tailwindcss(?:\/(\w+))?(?:\.css)?$/.exec(id)?.[1] ?? 'index';
      const path = join(twDir, `${name}.css`);
      return { path, base: twDir, content: readFileSync(path, 'utf8') };
    },
  } as never);
  return compiler.build(candidates);
}

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

function basics() {
  const { doc, page } = fresh();
  doc.setToken('accent', 'color', '#c2410c');
  doc.setToken('ink', 'color', 'rgb(20 20 30)');
  doc.setToken('r-md', 'radius', '10px');
  doc.setToken('size-lg', 'font-size', '22px');
  doc.setToken('weight-bold', 'font-weight', '700');
  doc.setToken('space-4', 'spacing', '16px');
  const key = setTextStyle(doc, 'Title', { fontSize: '28px', fontWeight: '700', lineHeight: '1.2', letterSpacing: '-0.01em', fontFamily: F });
  const id = doc.insert(page, { type: 'frame', tag: 'section', name: 'Card', style: { position: 'absolute', left: '0px', top: '0px', width: '640px', display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px', backgroundColor: '#fafaf7', fontFamily: F, color: 'var(--ink)' }, children: [
    { type: 'text', tag: 'h1', name: 'Title', text: 'Quarterly report', style: { color: 'var(--accent)' } },
    { type: 'text', tag: 'h2', name: 'Plain heading', text: 'A heading with no size of its own', style: {} },
    { type: 'text', tag: 'p', name: 'Body', text: 'Body text in a token size and weight.', style: { fontSize: 'var(--size-lg)', fontWeight: 'var(--weight-bold)', lineHeight: '1.5', letterSpacing: '0.02em', opacity: '0.8' } },
    { type: 'text', tag: 'p', name: 'Bold', text: 'A keyword weight', style: { fontWeight: 'bold', fontSize: '15px' } },
    { type: 'frame', tag: 'div', name: 'Gradient', style: { height: '60px', borderRadius: 'var(--r-md)', backgroundImage: 'linear-gradient(90deg, #f97316 0%, #2563eb 100%)', boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25), 0 0 0 2px var(--accent)' } },
    { type: 'frame', tag: 'div', name: 'Bordered', style: { padding: 'var(--space-4)', borderWidth: '3px', borderStyle: 'solid', borderColor: 'var(--accent)', borderRadius: '6px', width: 'calc(100% - 40px)', marginLeft: '-4px' }, children: [
      { type: 'text', tag: 'span', name: 'Small', text: 'Bordered box', style: { fontSize: '13px', textTransform: 'uppercase', fontFamily: 'DejaVu Serif, serif' } },
      { type: 'text', tag: 'small', name: 'Note', text: ' and a note', style: {} },
    ] },
    { type: 'frame', tag: 'div', name: 'Ratio', style: { width: '160px', aspectRatio: '16 / 9', backgroundColor: 'rgb(37 99 235 / 50%)' } },
  ] });
  applyTextStyle(doc, doc.rawKids(id)[0]!, key);
  return { doc, id, width: 640 };
}

function rules() {
  const { doc, page } = fresh();
  doc.setToken('accent', 'color', '#0f766e');
  const grey = 'rgb(220 220 220)';
  const id = doc.insert(page, { type: 'frame', tag: 'section', name: 'Rules', style: { position: 'absolute', left: '0px', top: '0px', width: '640px', display: 'flex', flexDirection: 'column', gap: '12px', backgroundColor: 'white', fontFamily: F }, children: [
    { type: 'text', tag: 'p', name: 'Before', text: 'Item with a marker', style: { position: 'relative', paddingLeft: '20px', fontSize: '16px' }, rules: { '::before': { content: '"+"', position: 'absolute', left: '0px', top: '0px', color: 'var(--accent)', fontWeight: '700' }, '::after': { content: '" (new_one)"', color: 'rgb(200 0 0)', fontSize: '12px' }, ':hover': { color: 'red' } } },
    // At exactly the width of the query: max-width includes it, Tailwind's max-[640px] would not.
    { type: 'frame', tag: 'div', name: 'Media max', style: { height: '20px', backgroundColor: grey }, rules: { '@media (max-width: 640px)': { backgroundColor: 'rgb(16 185 129)' } } },
    { type: 'frame', tag: 'div', name: 'Media min', style: { height: '20px', backgroundColor: grey }, rules: { '@media (min-width: 640px)': { backgroundColor: 'rgb(59 130 246)' } } },
    { type: 'frame', tag: 'div', name: 'Media range', style: { height: '20px', backgroundColor: grey }, rules: { '@media (min-width: 600px) and (max-width: 700px)': { backgroundColor: 'rgb(244 63 94)' } } },
    { type: 'frame', tag: 'div', name: 'Holder', style: { width: '300px', containerType: 'inline-size' }, children: [
      { type: 'frame', tag: 'div', name: 'Container', style: { height: '20px', backgroundColor: grey }, rules: { '@container (max-width: 300px)': { backgroundColor: 'rgb(234 179 8)', borderRadius: '10px' } } },
    ] },
    { type: 'frame', tag: 'div', name: 'Named holder', style: { width: '250px', containerType: 'inline-size', containerName: 'card' }, children: [
      { type: 'frame', tag: 'div', name: 'Named', style: { height: '20px', backgroundColor: grey }, rules: { '@container card (max-width: 250px)': { backgroundColor: 'rgb(14 165 233)' } } },
    ] },
    { type: 'frame', tag: 'div', name: 'Inline wins', style: { height: '20px', backgroundColor: 'black', gridTemplateColumns: '1fr' }, rules: { '@media (max-width: 800px)': { backgroundColor: 'rgb(168 85 247)', gridTemplateColumns: '1fr 1fr' } } },
    { type: 'text', tag: 'p', name: 'Badge', text: 'Pseudo-element badge', style: { fontSize: '14px' }, rules: { '::after': { content: '"!"', display: 'inline-block', marginLeft: '6px', padding: '0 6px', backgroundColor: 'var(--accent)', color: 'white', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.3)' } } },
  ] });
  return { doc, id, width: 640 };
}

function components() {
  const { doc, page } = fresh();
  doc.setToken('accent', 'color', '#1d4ed8');
  const main = doc.insert(page, { type: 'frame', tag: 'button', name: 'Button', style: { position: 'absolute', left: '700px', top: '0px', display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 14px', borderRadius: '8px', backgroundColor: 'var(--accent)', color: 'white', fontFamily: F, fontSize: '14px', fontWeight: '600' }, rules: { '::after': { content: '"›"', marginLeft: '2px' } }, children: [
    { type: 'text', tag: 'span', name: 'Label', text: 'Continue', style: {} },
    { type: 'frame', tag: 'span', name: 'Badge', style: { display: 'inline-flex', padding: '0 6px', borderRadius: '999px', backgroundColor: 'rgb(255 255 255 / 25%)', fontSize: '12px' }, children: [{ type: 'text', tag: 'span', name: 'Count', text: '3', style: {} }] },
  ] });
  const [label, badge] = doc.rawKids(main) as [string, string];
  createComponent(doc, main);
  updateComponent(doc, main, { props: [
    { name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] },
    { name: 'show-badge', type: 'boolean', targets: [{ path: badge, field: 'visible' }] },
  ] });
  const ghost = addVariant(doc, main, { tone: 'ghost' }, { base: { tone: 'solid' } });
  doc.updateStyle(ghost, { backgroundColor: 'transparent', color: 'var(--accent)', boxShadow: 'inset 0 0 0 1px var(--accent)' });
  const id = doc.insert(page, { type: 'frame', tag: 'section', name: 'Toolbar', style: { position: 'absolute', left: '0px', top: '0px', width: '520px', display: 'flex', gap: '12px', padding: '16px', backgroundColor: '#f8fafc', fontFamily: F } });
  createInstance(doc, main, id, { props: { label: 'Save' } });
  createInstance(doc, ghost, id, { props: { label: 'Cancel', 'show-badge': false } });
  createInstance(doc, main, id, { props: { label: 'Publish now' } });
  return { doc, id, width: 520 };
}

describe('Tailwind classes that say what the style says', () => {
  it('compiles to the same declarations', async () => {
    const { doc, id } = basics();
    const code = toReact(doc, id, 'tailwind');
    // Tailwind reads text-(--x) as a colour and font-[bold] as a family: these say which they are.
    expect(code).toContain('text-(length:--size-lg)');
    expect(code).toContain('font-[weight:bold]');
    expect(code).toContain('font-[family-name:DejaVu_Serif,_serif]');
    const css = await tailwindCss('@import "tailwindcss/utilities";', ['text-(length:--size-lg)', 'font-(--weight-bold)', 'font-[weight:bold]', 'font-[family-name:DejaVu_Serif,_serif]', "after:content-['_(new\\_one)']", '[@media(max-width:_640px)]:bg-[red]', '[@container_card_(max-width:_250px)]:bg-[red]']);
    expect(css).toMatch(/text-\\\(length\\:--size-lg\\\) \{\s*font-size: var\(--size-lg\);/);
    expect(css).toMatch(/font-\\\[weight\\:bold\\\] \{\s*--tw-font-weight: bold;\s*font-weight: bold;/);
    expect(css).toContain('font-family: DejaVu Serif, serif;');
    expect(css).toContain("--tw-content: ' (new_one)';");
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('@container card (max-width: 250px)');
  });
});

describe.skipIf(!findBrowser())('react-tailwind built by Tailwind 4 renders as the canvas does', () => {
  let browser: Browser;
  let renderer: Renderer;

  beforeAll(async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: findBrowser()!, headless: true, pipe: true, args: ['--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    renderer = new Renderer(async () => null);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await renderer?.close();
  });

  /** The share of pixels that differ between Bogen's render and the compiled code. */
  async function compare({ doc, id, width }: { doc: BogenDoc; id: string; width: number }): Promise<{ percent: number; code: string }> {
    const code = toReact(doc, id, 'tailwind');
    const markup = renderToStaticMarkup(React.createElement(Object.values(load(code)).at(-1)!));
    const page = await browser.newPage();
    try {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8">${fontLinkTags(doc)}</head><body style="margin:0">${markup}</body></html>`);
      // What Tailwind's scanner would find: every class in the markup.
      const candidates = await page.evaluate(() => [...new Set([...document.querySelectorAll('[class]')].flatMap((el) => [...el.classList]))]);
      const css = await tailwindCss(`@import "tailwindcss";\n${tokensCss(doc)}\n${textStyleCssFor(doc, code)}`, candidates);
      await page.addStyleTag({ content: css });
      await page.evaluate(() => document.fonts.ready);
      const box = await page.evaluate(() => {
        const r = document.body.querySelector(':scope > :not(style)')!.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      const built = await page.screenshot({ type: 'png', clip: box });
      const bogen = await renderer.screenshot(doc, { nodeIds: [id] }, { format: 'png', scale: 1 });
      const diff = await renderer.compareImages({ bytes: new Uint8Array(built), mime: 'image/png' }, { bytes: bogen.bytes, mime: 'image/png' }, { threshold: 0.1, fit: false, maxDimension: 4000, maxBytes: 8_000_000 });
      return { percent: (diff.different / diff.total) * 100, code };
    } finally {
      await page.close();
    }
  }

  it('tokens, text styles, gradients, shadows, arbitrary values and preflight', async () => {
    expect((await compare(basics())).percent).toBeLessThan(0.1);
  }, 60000);

  it('pseudo-elements, media and container queries at their boundaries', async () => {
    const { percent, code } = await compare(rules());
    expect(code).toContain('[@media(max-width:_640px)]:bg-[rgb(16_185_129)]');
    expect(percent).toBeLessThan(0.1);
  }, 60000);

  it('components with variants and props', async () => {
    expect((await compare(components())).percent).toBeLessThan(0.1);
  }, 60000);
});

describe('tokens_export as Tailwind 4', () => {
  let h: Harness;
  let agent: Client;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'tokens');
    await call(agent, 'file_create', { name: 'Tokens' });
  }, 60000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('builds, and its utilities read the same variables as the code', async () => {
    await call(agent, 'tokens_set', { tokens: [
      { name: 'accent', kind: 'color', value: '#ff5500' },
      { name: 'radius-md', kind: 'radius', value: '8px' },
      { name: 'font-display', kind: 'font-family', value: '"Instrument Serif", serif' },
      { name: 'weight-strong', kind: 'font-weight', value: '650' },
      { name: 'text-sm', kind: 'font-size', value: '14px' },
      { name: 'leading-tight', kind: 'line-height', value: '1.15' },
      { name: 'tracking-wide', kind: 'letter-spacing', value: '0.04em' },
      { name: 'space-4', kind: 'spacing', value: '16px' },
      { name: 'container-narrow', kind: 'container', value: '40rem' },
      { name: 'bp-tablet', kind: 'breakpoint', value: '768px' },
    ] });
    const theme = await call<string>(agent, 'tokens_export', { format: 'tailwind' });
    const css = await tailwindCss(`@import "tailwindcss";\n${theme}`, ['bg-accent', 'rounded-md', 'font-display', 'font-strong', 'text-sm', 'leading-tight', 'tracking-wide', 'p-4', 'max-w-narrow', 'tablet:hidden', '@narrow:flex']);
    const rule = (cls: string) => new RegExp(`\\.${cls.replace(/[:@]/g, '\\\\$&')} \\{([^}]*)\\}`).exec(css)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    // @theme inline: a utility reads the file's own variable, as code_get's var(--name) does.
    expect(rule('bg-accent')).toBe('background-color: var(--accent);');
    expect(rule('rounded-md')).toBe('border-radius: var(--radius-md);');
    expect(rule('font-display')).toBe('font-family: var(--font-display);');
    expect(rule('font-strong')).toContain('font-weight: var(--weight-strong);');
    expect(rule('leading-tight')).toContain('line-height: var(--leading-tight);');
    expect(rule('tracking-wide')).toContain('letter-spacing: var(--tracking-wide);');
    expect(rule('p-4')).toBe('padding: var(--space-4);');
    expect(rule('max-w-narrow')).toBe('max-width: 40rem;');
    // A size token is only a size: Tailwind's own line height for text-sm stays out.
    expect(rule('text-sm')).toBe('font-size: var(--text-sm);');
    // Media and container queries cannot read a variable, so breakpoints and containers are their values.
    expect(css).toMatch(/@media \(width >= 768px\) \{\s*\.tablet\\:hidden/);
    expect(css).toMatch(/@container \(width >= 40rem\) \{\s*\.\\@narrow\\:flex/);
    expect(css).not.toContain('var(--bp-tablet)');
  });
});
