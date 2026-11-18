import { describe, expect, it } from 'vitest';
import { MOCKUP_SCENES, mapPoint, mockupChildren, quadMatrix, readMockupConfig, sanitizeSvgMarkup, type MockupConfig, type Quad } from '../src/index.ts';

describe('mockup geometry', () => {
  it('maps the design\'s corners onto the quad, also in perspective', () => {
    const q: Quad = [[300, 200], [1320, 268], [1312, 724], [308, 760]];
    for (const [x, y, want] of [[0, 0, q[0]], [600, 0, q[1]], [600, 300, q[2]], [0, 300, q[3]]] as const) {
      const [px, py] = mapPoint(600, 300, q, x, y);
      expect(px).toBeCloseTo(want[0], 4);
      expect(py).toBeCloseTo(want[1], 4);
    }
  });

  it('is a plain scale and move for a rectangle', () => {
    expect(quadMatrix(100, 50, [[10, 20], [210, 20], [210, 120], [10, 120]])).toBe('matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)');
  });

  it('refuses corners on one line', () => {
    expect(() => quadMatrix(10, 10, [[0, 0], [10, 0], [20, 0], [5, 0]])).toThrow(/one line/);
  });

  it('lays out scene, strips of a live instance, light and front, cropped to the surface', () => {
    const tote = MOCKUP_SCENES.find((s) => s.id === 'tote-bag')!;
    const c: MockupConfig = { source: 'main1', sourceWidth: 1000, sourceHeight: 1000, scene: tote.id, width: 1600, height: 1200, mesh: tote.mesh, blend: 'multiply', shading: 0.9, fit: 'cover' };
    const kids = mockupChildren(c, tote);
    expect(kids.map((k) => k.name)).toEqual(['Scene', 'Surface', 'Light on the surface']);
    const strips = kids[1]!.children!;
    expect(strips).toHaveLength(tote.mesh.top.length - 1);
    const design = strips[3]!.children![0]!;
    expect(design.instanceOf).toBe('main1');
    // 1.25 : 1 surface from a square design: its middle band, 800 tall, shows.
    expect(parseFloat(strips[0]!.style!.height!)).toBeCloseTo(800, -1);
    expect(parseFloat(design.style!.top!)).toBeCloseTo(-100, -1);
    expect(kids[1]!.style!.mixBlendMode).toBe('multiply');
  });

  it('round-trips its config and keeps every scene clean under the sanitizer', () => {
    const s = MOCKUP_SCENES[0]!;
    const c: MockupConfig = { source: 'a', sourceWidth: 10, sourceHeight: 10, scene: s.id, width: 800, height: 600, mesh: s.mesh, blend: 'multiply', shading: 0.5, fit: 'cover' };
    expect(readMockupConfig(JSON.stringify(c))).toEqual(c);
    expect(readMockupConfig('{"source":1}')).toBeNull();
    for (const scene of MOCKUP_SCENES) {
      for (const part of [scene.svg, scene.shade, scene.sheen, scene.front].filter(Boolean) as string[]) {
        const clean = sanitizeSvgMarkup(part, 'layer1');
        expect(clean.length).toBeGreaterThan(part.length * 0.8);
        expect(clean).not.toMatch(/data-bogen-scope/);
      }
      expect(scene.mesh.top.length).toBe(scene.mesh.bottom.length);
    }
  });
});
