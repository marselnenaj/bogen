import { afterAll, describe, expect, it } from 'vitest';
import { importHtml } from '@bogen/core';
import { diagramHtml, diagramPaint, layoutDiagram, type DiagramBox } from '../src/diagram.ts';
import { findBrowser, Renderer } from '../src/render.ts';

const renderer = new Renderer(async () => null);
afterAll(() => renderer.close());

const FLOW = `flowchart LR
  A[Sign up] --> B{Email verified?}
  B -- yes --> C[Dashboard]
  B -- no --> D[Resend link]
  D --> B
  C --> E((Done))
  subgraph Billing
    F[Plan] --> G[Pay]
  end
  C --> F`;

const SEQUENCE = `sequenceDiagram
  participant U as User
  participant A as App
  participant S as Server
  U->>A: Tap pay
  A->>S: POST /charge
  S-->>A: 200 OK
  A-->>U: Receipt
  Note right of S: Logged`;

const STATE = `stateDiagram-v2
  [*] --> Draft
  Draft --> Review: submit
  Review --> Draft: changes
  Review --> Published: approve
  Published --> [*]`;

function overlaps(boxes: DiagramBox[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) out.push([i, j]);
  }
  return out;
}

describe.skipIf(!findBrowser())('Mermaid to layers', () => {
  it('lays out a flowchart: nodes, connectors with heads, edge labels and a group, none overlapping', async () => {
    const m = await layoutDiagram(renderer, FLOW, { font: 'sans-serif', size: 14 });
    expect(m.type).toMatch(/flowchart/);
    expect(m.nodes.length).toBe(7);
    expect(m.edges.length).toBe(7);
    expect(m.edges.every((e) => e.end === 'arrow')).toBe(true);
    expect(m.labels.filter((l) => l.kind === 'edge').map((l) => l.text.lines.join(' ')).sort()).toEqual(['no', 'yes']);
    expect(m.clusters.length).toBe(1);
    expect(m.nodes.map((n) => n.label?.lines.join(' ')).sort()).toEqual(['Dashboard', 'Done', 'Email verified?', 'Pay', 'Plan', 'Resend link', 'Sign up']);
    expect(overlaps(m.nodes)).toEqual([]);
    expect(m.nodes.find((n) => n.label?.lines[0] === 'Email verified?')?.shape).toBe('svg');
    expect(m.nodes.find((n) => n.label?.lines[0] === 'Done')?.shape).toBe('ellipse');
  });

  it('lays out a sequence diagram: participants, messages and a note', async () => {
    const m = await layoutDiagram(renderer, SEQUENCE, { font: 'sans-serif', size: 14 });
    expect(m.type).toBe('sequence');
    // Each participant is drawn at the top and the bottom, and the note is a node too.
    expect(m.nodes.filter((n) => ['User', 'App', 'Server'].includes(n.label?.lines[0] ?? '')).length).toBe(6);
    expect(m.nodes.filter((n) => n.label?.lines[0] === 'Logged').length).toBe(1);
    expect(m.edges.length).toBe(4);
    expect(m.edges.filter((e) => e.dashed).length).toBe(2);
    expect(m.labels.map((l) => l.text.lines.join(' '))).toEqual(expect.arrayContaining(['Tap pay', 'POST /charge', '200 OK', 'Receipt']));
    expect(overlaps(m.nodes)).toEqual([]);
  });

  it('lays out a state diagram: states, start and end, labelled transitions', async () => {
    const m = await layoutDiagram(renderer, STATE, { font: 'sans-serif', size: 14 });
    expect(m.type).toMatch(/state/);
    expect(m.nodes.filter((n) => n.label).map((n) => n.label!.lines[0]).sort()).toEqual(['Draft', 'Published', 'Review']);
    expect(m.nodes.length).toBe(5);
    expect(m.edges.length).toBe(5);
    expect(m.labels.filter((l) => l.kind === 'edge').map((l) => l.text.lines[0]).sort()).toEqual(['approve', 'changes', 'submit']);
    expect(overlaps(m.nodes)).toEqual([]);
  });

  it('turns the layout into layers in the file\'s tokens', async () => {
    const m = await layoutDiagram(renderer, FLOW, { font: 'sans-serif', size: 14 });
    const paint = diagramPaint([
      { name: 'surface', kind: 'color', value: '#fff' }, { name: 'text', kind: 'color', value: '#111' }, { name: 'border', kind: 'color', value: '#ccc' },
      { name: 'accent', kind: 'color', value: '#e5484d' }, { name: 'font-body', kind: 'font-family', value: 'Inter, sans-serif' },
    ]);
    expect(paint.used).toMatchObject({ surface: 'surface', text: 'text', line: 'border', accent: 'accent', font: 'font-body' });
    const { nodes } = importHtml(diagramHtml(m, paint, { name: 'Diagram', padding: 24, background: true }));
    expect(nodes.length).toBe(1);
    const all: typeof nodes = [];
    const walk = (n: (typeof nodes)[number]) => { all.push(n); n.children?.forEach(walk); };
    walk(nodes[0]!);
    expect(all.filter((n) => n.type === 'svg').length).toBeGreaterThanOrEqual(7);
    expect(all.filter((n) => n.type === 'text').map((n) => n.text)).toEqual(expect.arrayContaining(['Sign up', 'yes', 'Billing']));
    expect(JSON.stringify(nodes)).toContain('var(--border)');
    expect(JSON.stringify(nodes)).not.toContain('mermaid');
  });
});
