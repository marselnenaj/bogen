import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { addVariant, BogenDoc, createComponent, createInstance, setSlot, setTextStyle, applyTextStyle, toReact, updateComponent, type JsxMode } from '@bogen/core';

/** Type-checks generated code in strict mode, as a repository would, and returns what is wrong with it. */
function typeErrors(code: string): string[] {
  const options: ts.CompilerOptions = { strict: true, noUnusedLocals: true, noUnusedParameters: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: ['react'] };
  const file = `${process.cwd()}/apps/editor/test/__generated__.tsx`;
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const source = host.getSourceFile.bind(host);
  host.readFile = (f) => (f === file ? code : read(f));
  host.fileExists = (f) => f === file || exists(f);
  host.getSourceFile = (f, v, ...rest) => (f === file ? ts.createSourceFile(f, code, v, true, ts.ScriptKind.TSX) : source(f, v, ...rest));
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

/** Runs generated code for real and gives back its exports. */
function load(code: string): Record<string, React.ComponentType<Record<string, unknown>>> {
  const js = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, React.ComponentType<Record<string, unknown>>> = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', 'React', 'require', js)(exports, React, (name: string) => (name === 'react' ? React : {}));
  return exports;
}

function system() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const main = doc.insert(page, { type: 'frame', tag: 'button', name: 'Primary Button', style: { position: 'absolute', left: '10px', top: '10px', display: 'inline-flex', gap: '8px', padding: '8px', backgroundColor: 'rgb(1, 2, 3)' }, children: [
    { type: 'text', tag: 'span', name: 'Label', text: 'Buy', style: { color: 'var(--ink)' } },
    { type: 'svg', tag: 'svg', name: 'Icon', svg: '<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>', style: { width: '8px', height: '8px' } },
    { type: 'frame', tag: 'div', name: 'Extra', style: { display: 'flex' }, children: [{ type: 'text', tag: 'small', name: 'Fallback', text: 'Nothing', style: {} }] },
  ] });
  const [label, icon, extra] = doc.rawKids(main) as [string, string, string];
  createComponent(doc, main);
  setSlot(doc, extra, 'extra');
  updateComponent(doc, main, { props: [
    { name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] },
    { name: 'show-icon', type: 'boolean', targets: [{ path: icon, field: 'visible' }] },
  ] });
  return { doc, page, main, label };
}

describe.each(['inline', 'tailwind'] as JsxMode[])('generated React in %s mode', (mode) => {
  it('type-checks in strict mode and renders what the design shows', () => {
    const { doc, main } = system();
    const code = toReact(doc, main, mode);
    expect(typeErrors(code)).toEqual([]);
    const { PrimaryButton } = load(code);
    const plain = renderToStaticMarkup(createElement(PrimaryButton!));
    expect(plain).toContain('Buy');
    expect(plain).toContain('<circle');
    expect(plain).toContain('Nothing');
    const props = renderToStaticMarkup(createElement(PrimaryButton!, { label: 'Go', showIcon: false, children: 'Mine', className: 'extra', style: { margin: 1 } }));
    expect(props).toContain('Go');
    expect(props).not.toContain('<circle');
    expect(props).toContain('Mine');
    expect(props).not.toContain('Nothing');
    expect(props).toContain('extra');
    expect(props).toContain('margin:1');
  });

  it('a layer with instances, a variant set, fills and text styles still compiles', () => {
    const { doc, page, main, label } = system();
    const big = addVariant(doc, main, { size: 'lg' }, { base: { size: 'sm' } });
    doc.updateStyle(big, { padding: '24px' });
    const key = setTextStyle(doc, 'Title', { fontSize: '20px' });
    const board = doc.insert(page, { type: 'frame', tag: 'section', name: 'Hero section', style: { display: 'flex' }, children: [{ type: 'text', tag: 'h1', name: 'H', text: 'Hello {world} <b>', style: {} }] });
    applyTextStyle(doc, doc.rawKids(board)[0]!, key);
    const a = createInstance(doc, big, board, { props: { label: 'Large', 'show-icon': false }, style: { marginTop: '4px' } });
    const b = createInstance(doc, main, board);
    doc.insert(`${b}/${doc.rawKids(main)[2]}`, { type: 'text', tag: 'p', name: 'In slot', text: 'In slot' });
    const c = createInstance(doc, main, board);
    doc.updateFields(`${c}/${label}`, { text: 'Changed inside' });
    const code = toReact(doc, board, mode);
    expect(typeErrors(code)).toEqual([]);
    expect(code).toContain('<PrimaryButton size="lg"');
    expect(code).toContain('written out in full');
    const { HeroSection, PrimaryButton } = load(code);
    const html = renderToStaticMarkup(createElement(HeroSection!));
    expect(html).toContain('Large');
    expect(html).toContain('In slot');
    expect(html).toContain('Changed inside');
    expect(html).toContain('Hello {world} &lt;b&gt;');
    expect(html).toContain('ts-title');
    const lg = renderToStaticMarkup(createElement(PrimaryButton!, { size: 'lg' }));
    expect(mode === 'inline' ? lg.includes('padding:24px') : lg.includes('p-[24px]')).toBe(true);
    void a;
  });

  it('a set with two axes and no slot: a typed props interface, a union per axis, and only the imports it uses', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    const main = doc.insert(page, { type: 'frame', tag: 'button', name: 'Tag', style: { position: 'absolute', left: '0px', top: '0px', padding: '4px' }, children: [{ type: 'text', tag: 'span', name: 'Text', text: 'New', style: {} }] });
    createComponent(doc, main);
    updateComponent(doc, main, { props: [{ name: 'text', type: 'text', targets: [{ path: doc.rawKids(main)[0]!, field: 'text' }] }] });
    const red = addVariant(doc, main, { tone: 'red', size: 'sm' }, { base: { tone: 'grey', size: 'sm' } });
    doc.updateStyle(red, { backgroundColor: 'rgb(200, 0, 0)' });
    const big = addVariant(doc, main, { tone: 'grey', size: 'lg' });
    doc.updateStyle(big, { padding: '12px' });
    const board = doc.insert(page, { type: 'frame', tag: 'section', name: 'Tags', style: { position: 'absolute', left: '100px', top: '40px', display: 'flex' } });
    createInstance(doc, red, board, { props: { text: 'Hot' } });
    const code = toReact(doc, board, mode);
    // A project with noUnusedLocals, as Vite's React template has, fails on an import it does not use.
    expect(code).toContain("import type { CSSProperties } from 'react';");
    expect(code).toMatch(/export interface TagProps \{\n {2}tone\?: "grey" \| "red";\n {2}size\?: "sm" \| "lg";\n {2}text\?: string;/);
    expect(code).toContain('<Tag tone="red" text="Hot" />');
    // Where the board sits on the canvas is not part of the code.
    expect(code).not.toMatch(/left-\[100px\]|left: "100px"/);
    expect(typeErrors(code)).toEqual([]);
    const { Tag, Tags } = load(code);
    expect(renderToStaticMarkup(createElement(Tag!, { size: 'lg', text: 'Big' }))).toContain(mode === 'inline' ? 'padding:12px' : 'p-[12px]');
    expect(renderToStaticMarkup(createElement(Tags!))).toContain('Hot');
  });
});
