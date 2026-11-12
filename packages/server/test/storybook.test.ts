import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readCodeRef } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiteralReader, UNKNOWN, JsName } from '../src/js-literal.ts';
import { parseStories, storyName } from '../src/storybook.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'storybook-project');
const read = (rel: string) => readFileSync(join(FIXTURE, rel), 'utf8');

describe('reading stories as text', () => {
  it('reads literals, and says unknown for code', () => {
    const value = new LiteralReader(`{ a: 'x', "b": [1, -2.5, true, null], c: fn(), d: <b>hi, there</b>, e: \`t\`, f: \`\${x}\`, g: Button, h: 'y' as const, ...rest, i() { return 1 }, j }`).value() as Record<string, unknown>;
    expect(value.a).toBe('x');
    expect(value.b).toEqual([1, -2.5, true, null]);
    expect(value.c).toBe(UNKNOWN);
    expect(value.d).toBe(UNKNOWN);
    expect(value.e).toBe('t');
    expect(value.f).toBe(UNKNOWN);
    expect(value.g).toBeInstanceOf(JsName);
    expect(value.h).toBe('y');
    expect(value.i).toBe(UNKNOWN);
    expect(value.j).toBeInstanceOf(JsName);
  });

  it('reads CSF 3: the meta, args, argTypes and named stories', () => {
    const parsed = parseStories(read('src/components/Button.stories.tsx'));
    expect(parsed.title).toBe('Actions/Button');
    expect(parsed.component).toEqual({ local: 'Button', source: './Button', imported: 'Button' });
    expect(parsed.argTypes).toEqual({ tone: { type: 'variant', options: ['primary', 'secondary', 'danger'] }, size: { type: 'variant', options: ['sm', 'md'] }, disabled: { type: 'boolean' } });
    expect(parsed.stories.map((s) => [s.exportName, s.name])).toEqual([['Primary', 'Primary'], ['Secondary', 'Secondary'], ['DangerSmall', 'Danger, small']]);
    expect(parsed.stories[0]!.args).toEqual({ children: 'Save', tone: 'primary' });
    expect(parsed.stories[1]!.args).toEqual({ children: 'Cancel', tone: 'secondary' });
    expect(parsed.stories[2]!.args).toEqual({ children: 'Delete', tone: 'danger', size: 'sm' });
    expect(parsed.stories[2]!.skipped.sort()).toEqual(['icon', 'onClick']);
    expect(parsed.problems).toEqual([]);
  });

  it('reads CSF 2: Template.bind, args and storyName', () => {
    const parsed = parseStories(read('src/components/Badge.stories.jsx'));
    expect(parsed.component).toEqual({ local: 'Badge', source: '@/components/Badge', imported: 'default' });
    expect(parsed.stories.map((s) => s.name)).toEqual(['Plain', 'Solid badge']);
    expect(parsed.stories[0]!.args).toEqual({ label: 'New', count: 3 });
    expect(parsed.stories[1]!.args).toEqual({ label: 'Hot', solid: true });
  });

  it('leaves out excluded and private exports, and takes story argTypes and function stories', () => {
    const parsed = parseStories(`import { Card as Panel } from '../ui/Card';
export default { component: Panel, excludeStories: ['mockData'], args: { title: 'Hi' } } as Meta<typeof Panel>;
export const mockData = { rows: [1, 2] };
export const __internal = {};
export const Empty = () => <Panel />;
export const Elevated: StoryObj<typeof Panel> = { args: { elevated: true }, argTypes: { tone: { control: 'inline-radio', options: ['a', 'b'] } } };
`);
    expect(parsed.component).toEqual({ local: 'Panel', source: '../ui/Card', imported: 'Card' });
    expect(parsed.stories.map((st) => st.exportName)).toEqual(['Empty', 'Elevated']);
    expect(parsed.stories[0]!.args).toEqual({ title: 'Hi' });
    expect(parsed.stories[1]!.args).toEqual({ title: 'Hi', elevated: true });
    expect(parsed.argTypes.tone).toEqual({ type: 'variant', options: ['a', 'b'] });
    expect(parsed.problems).toEqual([]);
    expect(parseStories('export const Lonely = {};').problems).toEqual(['No meta object was found in export default.', 'The meta names no component.']);
  });

  it('names stories as Storybook does', () => {
    expect(storyName('DangerSmall')).toBe('Danger Small');
    expect(storyName('primary_large')).toBe('Primary Large');
    expect(storyName('WithURLParam')).toBe('With URL Param');
  });
});

describe('stories as code components', () => {
  let h: Harness;
  let agent: Client;
  let fileId = '';
  let project = '';
  type Report = { page: string; changed: boolean; problems: { file: string; problem: string }[]; components: { set: string; frame: string; stories: { name: string; id: string; status: string }[] }[] };
  let report: Report;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Stories' })).id;
    project = (await call(agent, 'code_project_link', { dir: FIXTURE })).project.id;
  }, 30_000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('makes a variant set per component, one main per story, each a code component with its args', async () => {
    report = await call<Report>(agent, 'storybook_import', {});
    expect(report.changed).toBe(true);
    expect(report.components.map((c) => c.set).sort()).toEqual(['Badge', 'Button']);
    expect(report.problems.map((p) => p.file)).toEqual(['src/components/Broken.stories.tsx']);
    const { doc } = await h.server.rooms.get(fileId);
    expect(doc.getPages().find((p) => p.id === report.page)?.name).toBe('Storybook');
    const button = report.components.find((c) => c.set === 'Button')!;
    expect(button.stories.map((s) => s.name)).toEqual(['Primary', 'Secondary', 'Danger, small']);
    const danger = doc.getNode(button.stories[2]!.id)!;
    expect(danger.type).toBe('embed');
    expect(danger.parent).toBe(button.frame);
    expect(danger.code).toMatchObject({ project, file: 'src/components/Button.tsx', name: 'Button', props: { children: 'Delete', tone: 'danger', size: 'sm' } });
    expect(danger.component?.set).toBe('Button');
    expect(danger.component?.variant).toEqual({ story: 'Danger, small' });
    const props = Object.fromEntries((danger.component?.props ?? []).map((p) => [p.name, p]));
    expect(props.tone).toMatchObject({ type: 'variant', options: ['primary', 'secondary', 'danger'], default: 'danger', targets: [{ path: '', field: 'code.tone' }] });
    expect(props.disabled).toMatchObject({ type: 'boolean' });
    expect(props.children).toMatchObject({ type: 'text', default: 'Delete' });
    expect(props.onClick).toBeUndefined();
    const badge = report.components.find((c) => c.set === 'Badge')!;
    const solid = doc.getNode(badge.stories[1]!.id)!;
    expect(solid.code).toMatchObject({ file: 'src/components/Badge.jsx', name: 'default', import: '@/components/Badge', props: { label: 'Hot', solid: true } });
    // Rendered by the existing pipeline: the project's own build in a sandboxed frame.
    const frame = await fetch(`${h.base}/api/code/${project}/frame?file=src/components/Button.tsx&name=Button`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  }, 60_000);

  it('places a story, and its props drive the component', async () => {
    const placed = await call(agent, 'instance_create', { component: 'Button', variant: { story: 'Primary' }, props: { tone: 'danger', children: 'Remove' }, x: 0, y: 900 });
    const { doc } = await h.server.rooms.get(fileId);
    const ref = doc.getNode(placed.id)!.code!;
    expect(ref.name).toBe('Button');
    expect(ref.props).toMatchObject({ tone: 'danger', children: 'Remove' });
    const code = await call<string>(agent, 'code_get', { node_id: placed.id, format: 'react-tailwind' });
    expect(code).toContain('<Button tone="danger">Remove</Button>');
    expect(code).toMatch(/^import \{ Button \} from "@\/components\/Button";$/m);
    // A usage of the repository's own component, not a component Bogen writes around it.
    expect(code).not.toContain('export function Button');
    await call(agent, 'instance_set', { node_id: placed.id, props: { story: 'Secondary', tone: null, children: null } });
    expect(doc.getNode(placed.id)!.code!.props).toMatchObject({ tone: 'secondary', children: 'Cancel' });
  });

  it('writes nothing when the stories are the same', async () => {
    const again = await call<Report>(agent, 'storybook_import', {});
    expect(again.changed).toBe(false);
    expect(again.components.find((c) => c.set === 'Button')!.stories.every((s) => s.status === 'same')).toBe(true);
  });
});

describe('keeping stories in step', () => {
  const base = mkdtempSync(join(tmpdir(), 'bogen-stories-'));
  const dir = join(base, 'app');
  let h: Harness;
  let agent: Client;
  let fileId = '';

  beforeAll(async () => {
    cpSync(FIXTURE, dir, { recursive: true });
    h = await startServer({ storybookIntervalMs: 150 });
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Synced' })).id;
    await call(agent, 'code_project_link', { dir });
  }, 30_000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
    rmSync(base, { recursive: true, force: true });
  });

  it('follows the story files: changed args, a new story, a removed one kept while it is in use', async () => {
    const first = await call(agent, 'storybook_import', {});
    const button = first.components.find((c: { set: string }) => c.set === 'Button');
    const [primary, secondary, danger] = button.stories.map((s: { id: string }) => s.id);
    const used = await call(agent, 'instance_create', { component: danger, x: 0, y: 900 });
    const { doc } = await h.server.rooms.get(fileId);
    const before = JSON.stringify(doc.getNode(primary)!);

    const file = join(dir, 'src/components/Button.stories.tsx');
    const text = readFileSync(file, 'utf8');
    const cut = text.indexOf('export const DangerSmall');
    writeFileSync(file, `${text.slice(0, cut).replace("children: 'Cancel'", "children: 'Back'")}export const Ghost: Story = {\n  args: { tone: 'secondary', children: 'More' },\n};\n`);

    await until(() => [...doc.nodes.keys()].some((id) => (doc.nodes.get(id)!.get('storybook') as { export?: string } | undefined)?.export === 'Ghost'), 15_000);
    expect(readCodeRef(doc.nodes.get(secondary)!)!.props.children).toBe('Back');
    expect(JSON.stringify(doc.getNode(primary)!)).toBe(before);
    // In use, so it stays, marked as gone from Storybook.
    expect(doc.nodes.has(danger)).toBe(true);
    expect(doc.nodes.get(danger)!.get('storybook')).toMatchObject({ gone: true });
    expect(doc.getNode(used.id)!.code!.props.tone).toBe('danger');
    const ghost = [...doc.nodes.keys()].find((id) => (doc.nodes.get(id)!.get('storybook') as { export?: string } | undefined)?.export === 'Ghost')!;
    expect(doc.getNode(ghost)!.component?.variant).toEqual({ story: 'Ghost' });
    expect(doc.getNode(ghost)!.parent).toBe(button.frame);

    // A story nobody uses goes when it leaves the file.
    writeFileSync(file, readFileSync(file, 'utf8').replace(/export const Ghost[\s\S]*$/, ''));
    await until(() => !doc.nodes.has(ghost), 15_000);
  }, 60_000);
});
