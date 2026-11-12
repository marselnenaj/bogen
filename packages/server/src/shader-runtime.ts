/**
 * Runs inside the page, bundled by esbuild into one script. Mounts every `[data-shader]` element with
 * the parameters in `window.__BOGEN_SHADERS__`, keyed by layer id. Goes through the React wrappers of
 * the shader package since those hold each effect's defaults and parameter mapping.
 */
import * as shaders from '@paper-design/shaders-react';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

type Params = Record<string, string>;
declare global {
  interface Window {
    __BOGEN_SHADERS__?: Record<string, Params>;
    /** Set by the renderer: one fixed frame per effect, as a picture. Absent in an exported page, which animates. */
    __BOGEN_STILL__?: boolean;
    /** Set for video: effects stay live and move only when told to, to an exact time. */
    __BOGEN_SEEKABLE__?: boolean;
    __bogenSeekShaders?: (ms: number) => Promise<void>;
    __bogenShadersReady?: Promise<void>;
  }
}

const library = shaders as unknown as Record<string, unknown>;

function pascal(type: string): string {
  return type.split(/[-_\s]+/).filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
}

function splitColors(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as string[];
    } catch {
      // Falls through to the comma form.
    }
  }
  return trimmed.match(/[^,()]+(?:\([^)]*\))?/g)?.map((c) => c.trim()).filter(Boolean) ?? [];
}

/** Same reading of parameters as the editor's canvas, so that canvas and renders agree. */
function toProps(params: Params, still: boolean): Record<string, unknown> {
  const props: Record<string, unknown> = { style: { width: '100%', height: '100%' } };
  for (const [key, raw] of Object.entries(params)) {
    if (key === 'type' || key.startsWith('data-')) continue;
    if (key === 'colors') props.colors = splitColors(raw);
    else if (raw === 'true' || raw === 'false') props[key] = raw === 'true';
    else if (raw !== '' && !Number.isNaN(Number(raw))) props[key] = Number(raw);
    else props[key] = raw;
  }
  if (still) {
    props.speed = 0;
    props.frame ??= 1000;
    props.webGlContextAttributes = { preserveDrawingBuffer: true };
  }
  return props;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * For renders: draws one effect, keeps a picture of it, and gives the WebGL context back. Browsers
 * allow 16 live contexts on a page and drop the oldest, and a canvas does not survive PDF or SVG.
 */
async function drawStill(el: HTMLElement, root: Root): Promise<void> {
  const deadline = performance.now() + 5000;
  let canvas = el.querySelector('canvas');
  // The canvas appears once any image the effect uses has loaded.
  while (!canvas && performance.now() < deadline) {
    await nextFrame();
    canvas = el.querySelector('canvas');
  }
  if (!canvas) return root.unmount();
  for (let i = 0; i < 6; i++) await nextFrame();
  const src = canvas.toDataURL('image/png');
  root.unmount();
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.style.cssText = 'display:block;width:100%;height:100%';
  el.append(img);
  await img.decode().catch(() => {});
}

/** Effects under a video's clock: each frame is its own parameters at that moment. */
const seekable: { root: Root; component: unknown; props: Record<string, unknown>; base: number; speed: number }[] = [];

window.__bogenSeekShaders = async (ms) => {
  for (const s of seekable) flushSync(() => s.root.render(createElement(s.component as never, { ...s.props, frame: s.base + ms * s.speed } as never)));
  await nextFrame();
  await nextFrame();
};

async function mountAll(): Promise<void> {
  const still = Boolean(window.__BOGEN_STILL__);
  const seek = Boolean(window.__BOGEN_SEEKABLE__);
  const elements = [...document.querySelectorAll<HTMLElement>('[data-shader]')];
  let next = 0;
  const worker = async () => {
    while (next < elements.length) {
      const el = elements[next++]!;
      const type = pascal(el.dataset.shader ?? '');
      const component = library[type];
      if (!component || !type) continue;
      const params = window.__BOGEN_SHADERS__?.[el.dataset.bogenId ?? ''] ?? {};
      const root = createRoot(el);
      const props = toProps(params, still);
      if (seek) {
        const base = typeof props.frame === 'number' ? props.frame : 0;
        const speed = typeof props.speed === 'number' ? props.speed : 1;
        props.speed = 0;
        props.frame = base;
        props.webGlContextAttributes = { preserveDrawingBuffer: true };
        seekable.push({ root, component, props, base, speed });
      }
      root.render(createElement(component as never, props as never));
      if (still) await drawStill(el, root);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

window.__bogenShadersReady = document.readyState === 'loading'
  ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => void mountAll().then(resolve), { once: true }))
  : mountAll();
