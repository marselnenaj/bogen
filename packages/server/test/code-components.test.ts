import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BogenDoc, codeUsageJsx, readCodeRef, toJsx, toReact, Y } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidates } from '../src/code-build.ts';
import { readablePath } from '../src/code-projects.ts';
import { scanModule } from '../src/code-scan.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'code-project');
const read = (rel: string) => readFileSync(join(FIXTURE, rel), 'utf8');

/** Every colour of a PNG, as hex without alpha. */
function pngColors(bytes: Buffer): Set<string> {
  let offset = 8;
  let width = 0, height = 0, channels = 4;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Set<string>();
  let prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start]!;
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = prior[i]!;
      const corner = i >= channels ? prior[i - channels]! : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[i] = (line[i]! + add) & 255;
    }
    prior = line;
    for (let x = 0; x < width; x++) out.add(line.subarray(x * channels, x * channels + 3).toString('hex'));
  }
  return out;
}

describe('reading components from source', () => {
  it('finds props from interfaces, inline types, unions and destructured defaults', () => {
    const [button] = scanModule(read('src/components/ui/button.tsx'));
    expect(button!.name).toBe('Button');
    const props = Object.fromEntries(button!.props.map((p) => [p.name, p]));
    expect(props.variant).toMatchObject({ type: 'enum', options: ['default', 'outline', 'ghost'], default: 'default', description: 'How loud the button is.' });
    expect(props.size).toMatchObject({ type: 'enum', options: ['sm', 'md', 'lg'], default: 'md' });
    expect(props.block).toMatchObject({ type: 'boolean', default: false });
    expect(props.children?.type).toBe('node');
    expect(props.disabled?.type).toBe('boolean');

    const [badge] = scanModule(read('src/components/ui/badge.tsx'));
    expect(badge!.props.find((p) => p.name === 'tone')).toMatchObject({ type: 'enum', options: ['neutral', 'success', 'danger'], default: 'neutral' });

    const card = scanModule(read('src/components/Card.tsx'));
    expect(card.map((c) => c.name)).toEqual(['Card']);
    expect(card[0]!.props.find((p) => p.name === 'title')).toMatchObject({ type: 'string', required: true });
    expect(card[0]!.props.find((p) => p.name === 'count')?.type).toBe('number');
    expect(scanModule(read('src/main.tsx'))).toEqual([]);
  });

  it('reads cva variants and forwardRef props as shadcn writes them', () => {
    const src = `
const buttonVariants = cva("inline-flex", { variants: { variant: { default: "a", "outline": "b" }, size: { sm: "c", icon: "d" } }, defaultVariants: { variant: "default" } })
function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) { return null }
const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => null)
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { label?: string; onPick?: (v: string) => void }
export { Button, buttonVariants, Input }`;
    const [button, input] = scanModule(src);
    expect(button!.props.find((p) => p.name === 'variant')).toMatchObject({ type: 'enum', options: ['default', 'outline'], default: 'default' });
    expect(button!.props.find((p) => p.name === 'asChild')).toMatchObject({ type: 'boolean', default: false });
    expect(input!.name).toBe('Input');
    expect(input!.props.map((p) => p.name)).toEqual(expect.arrayContaining(['label', 'placeholder', 'className']));
    expect(input!.props.some((p) => p.name === 'onPick')).toBe(false);
  });

  it('collects class candidates, including inside template literals', () => {
    const words = new Set<string>();
    candidates("className={`flex ${on ? 'ring-2' : ''}`} cn('h-8 px-3', x)", words);
    for (const w of ['flex', 'ring-2', 'h-8', 'px-3']) expect(words.has(w)).toBe(true);
  });

  it('keeps builds inside the project, its workspace and installed packages', () => {
    expect(readablePath(join(FIXTURE, 'src/App.tsx'), [FIXTURE])).toBe(true);
    expect(readablePath(join(FIXTURE, '..', '..', 'code-components.test.ts'), [FIXTURE])).toBe(false);
    expect(readablePath(join(FIXTURE, '../../../../../node_modules/react/index.js'), [FIXTURE])).toBe(true);
    expect(readablePath('/etc/passwd', [FIXTURE])).toBe(false);
  });
});

describe('code components in a document', () => {
  it('stores the ref and props, and drops refs that point out of a project', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    const id = doc.insert(page, { type: 'embed', name: 'Button', style: { width: '100px', height: '40px' }, code: { project: '703f6824ccd41722', file: 'src/components/ui/button.tsx', name: 'Button', import: '@/components/ui/button', props: { variant: 'ghost', children: 'Save' } } });
    expect(doc.getNode(id)!.code!.props).toEqual({ variant: 'ghost', children: 'Save' });
    expect(codeUsageJsx(doc.getNode(id)!.code!)).toBe('<Button variant="ghost">Save</Button>');
    expect(toJsx(doc, id)).toMatch(/^import \{ Button \} from "@\/components\/ui\/button";\n/);
    expect(toReact(doc, id)).toContain('<Button variant="ghost">Save</Button>');
    const copy = doc.duplicate([id])[0]!;
    expect(doc.getNode(copy)!.code!.file).toBe('src/components/ui/button.tsx');

    const bad = new Y.Map<unknown>();
    bad.set('code', { project: '703f6824ccd41722', file: '../../secret.txt', name: 'Button' });
    expect(readCodeRef(bad)).toBeUndefined();
    bad.set('code', { project: '703f6824ccd41722', file: '/etc/passwd', name: 'Button' });
    expect(readCodeRef(bad)).toBeUndefined();
  });
});

describe('code components on a server', () => {
  let h: Harness;
  let agent: Client;
  let projectId = '';
  let layer = '';

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'claude');
    await call(agent, 'file_create', { name: 'Code' });
  }, 30_000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('links the fixture project and lists its components with props', async () => {
    const linked = await call(agent, 'code_project_link', { dir: FIXTURE });
    projectId = linked.project.id;
    expect(linked.components).toBe(4);
    const list = await call(agent, 'code_components_list', {});
    const button = list.components.find((c: { name: string }) => c.name === 'Button');
    expect(button).toMatchObject({ file: 'src/components/ui/button.tsx', import: '@/components/ui/button' });
    expect(button.props.find((p: { name: string }) => p.name === 'variant').options).toEqual(['default', 'outline', 'ghost']);
  });

  it('serves a sandboxed frame with the project CSS, and a notice for what it cannot build', async () => {
    const res = await fetch(`${h.base}/api/code/${projectId}/frame?file=src/components/ui/button.tsx&name=Button`);
    expect(res.status).toBe(200);
    const policy = res.headers.get('content-security-policy')!;
    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('allow-same-origin');
    const html = await res.text();
    expect(html).toContain('.bg-brand{background-color:var(--color-brand)}');
    expect(html).toMatch(/--color-brand: ?#e5484d/);
    const again = await fetch(`${h.base}/api/code/${projectId}/frame?file=src/components/ui/button.tsx&name=Button`, { headers: { 'If-None-Match': res.headers.get('etag')! } });
    expect(again.status).toBe(304);
    const outside = await (await fetch(`${h.base}/api/code/${projectId}/frame?file=../../code-components.test.ts&name=X`)).text();
    expect(outside).toContain('is not a path inside the project');
    const unknown = await (await fetch(`${h.base}/api/code/0123456789abcdef/frame?file=a.tsx&name=A`)).text();
    expect(unknown).toContain('not linked on this device');
    const link = await fetch(`${h.base}/api/code/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.2' }, body: JSON.stringify({ dir: FIXTURE }) });
    expect(link.status).toBe(403);
  });

  it('places a Button measured from what it renders, and renders it with the project brand colour', async () => {
    const board = await call(agent, 'artboard_create', { name: 'Board', width: 400, height: 200, background: '#ffffff' });
    const placed = await call(agent, 'code_component_insert', { module: 'src/components/ui/button.tsx', name: 'Button', props: { children: 'Save changes' }, parent_id: board.id, x: 40, y: 40 });
    layer = placed.id;
    expect(placed.measured).toBe(true);
    expect(placed.size.height).toBe(40);
    expect(placed.size.width).toBeGreaterThan(60);
    expect(placed.jsx).toBe('<Button>Save changes</Button>');
    const shot = await callRaw(agent, 'canvas_screenshot', { node_id: board.id });
    const colors = pngColors(Buffer.from(shot.content.find((c) => c.type === 'image')!.data!, 'base64'));
    expect(colors.has('e5484d')).toBe(true);
  }, 60_000);

  it('changes props and exports the usage with its import', async () => {
    const updated = await call(agent, 'code_component_update', { layer_id: layer, props: { variant: 'outline', size: 'lg' }, fit: true });
    expect(updated.jsx).toBe('<Button variant="outline" size="lg">Save changes</Button>');
    expect(updated.size.height).toBe(48);
    const parent = (await call(agent, 'layer_get', { node_id: layer })).parent;
    const shot = await callRaw(agent, 'canvas_screenshot', { node_id: parent });
    expect(pngColors(Buffer.from(shot.content.find((c) => c.type === 'image')!.data!, 'base64')).has('e5484d')).toBe(false);
    const code = await call<string>(agent, 'code_get', { node_id: parent, format: 'react-tailwind' });
    expect(code).toMatch(/^import \{ Button \} from "@\/components\/ui\/button";$/m);
    expect(code).toContain('<Button variant="outline" size="lg">Save changes</Button>');
    const refused = await callRaw(agent, 'code_component_insert', { module: '../../code-components.test.ts', name: 'X' });
    expect(refused.isError).toBe(true);
  }, 60_000);
});
