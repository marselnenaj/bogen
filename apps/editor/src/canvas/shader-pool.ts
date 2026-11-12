import { editor, useEditor } from '../state/store.ts';
import { MAX_LIVE, planShaders } from './shader-budget.ts';

/** Keeps the live shaders within budget as the view and the selection change. */
export interface ShaderSlot { live: boolean; still: string | null }
type Listener = () => void;

interface Entry {
  id: string;
  el: HTMLElement;
  visible: boolean;
  slot: ShaderSlot;
  listener: Listener;
  capturing: boolean;
  dirty: boolean;
}

const entries = new Map<string, Entry>();
let frame = 0;
let observer: IntersectionObserver | null = null;
let offStore: (() => void) | null = null;

const STILL_SIZE = 480;

interface Mount { render: (t: number) => void; canvasElement: HTMLCanvasElement }

/** A picture of what the shader shows now. Drawn and read in one go, as WebGL clears after compositing. */
function captureStill(el: HTMLElement): string | null {
  const host = el.querySelector<HTMLElement & { paperShaderMount?: Mount }>('[data-paper-shader]');
  const mount = host?.paperShaderMount;
  if (!mount) return null;
  const gl = mount.canvasElement;
  if (!gl.width || !gl.height) return null;
  try {
    mount.render(performance.now());
    const scale = Math.min(1, STILL_SIZE / Math.max(gl.width, gl.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(gl.width * scale));
    c.height = Math.max(1, Math.round(gl.height * scale));
    c.getContext('2d')?.drawImage(gl, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', 0.85);
  } catch {
    return null;
  }
}

function update(e: Entry, slot: ShaderSlot): void {
  if (slot.live === e.slot.live && slot.still === e.slot.still) return;
  e.slot = slot;
  e.listener();
}

function replan(): void {
  frame = 0;
  const selection = new Set(editor().selection);
  const items = [...entries.values()].map((e) => {
    const r = e.el.getBoundingClientRect();
    return { id: e.id, visible: e.visible, area: r.width * r.height, selected: selection.has(e.id), hasStill: Boolean(e.slot.still) && !e.dirty };
  });
  const plan = planShaders(items);
  for (const e of entries.values()) {
    const next = plan.live.has(e.id);
    if (e.slot.live && !next) {
      // Leaving: keep what it shows now, and give the context back right away.
      update(e, { live: false, still: captureStill(e.el) ?? (e.dirty ? null : e.slot.still) });
      if (e.slot.still) e.dirty = false;
    } else if (!e.slot.live && next) update(e, { ...e.slot, live: true });
  }
  if (plan.capture) {
    const e = entries.get(plan.capture);
    if (e && e.slot.live && !e.capturing && e.el.querySelector('[data-paper-shader] canvas')) {
      e.capturing = true;
      // After a frame the shader has drawn, take the picture, and the next one gets the seat.
      requestAnimationFrame(() => {
        e.capturing = false;
        if (!entries.has(e.id) || !e.slot.live) return;
        const still = captureStill(e.el);
        if (still) {
          e.dirty = false;
          update(e, { live: e.slot.live, still });
        }
        schedule();
      });
    } else if (e && e.slot.live) setTimeout(schedule, 60);
  }
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(replan);
}

function observe(el: HTMLElement): void {
  if (!observer) {
    // Generous margins: a layer about to scroll in should not pop.
    observer = new IntersectionObserver((list) => {
      for (const item of list) {
        const id = (item.target as HTMLElement).dataset.bogenId;
        const e = id ? entries.get(id) : undefined;
        if (e) e.visible = item.isIntersecting;
      }
      schedule();
    }, { rootMargin: '120px' });
  }
  observer.observe(el);
}

/** A layer takes part in the pool for as long as it is on the page. */
export function joinPool(id: string, el: HTMLElement, listener: Listener): () => void {
  const entry: Entry = { id, el, visible: false, slot: { live: false, still: entries.get(id)?.slot.still ?? null }, listener, capturing: false, dirty: false };
  entries.set(id, entry);
  observe(el);
  if (!offStore) offStore = useEditor.subscribe((s, prev) => { if (s.selection !== prev.selection) schedule(); });
  schedule();
  return () => {
    observer?.unobserve(el);
    if (entries.get(id) === entry) entries.delete(id);
    schedule();
    if (!entries.size) {
      offStore?.();
      offStore = null;
    }
  };
}

export function slotOf(id: string): ShaderSlot {
  return entries.get(id)?.slot ?? { live: false, still: null };
}

/** The parameters changed, so a picture from before is out of date. */
export function invalidateStill(id: string): void {
  const e = entries.get(id);
  if (!e || !e.slot.still) return;
  e.dirty = true;
  schedule();
}

/** A glance at what is live, for the shortcuts of tests and for debugging. */
export function poolStats(): { total: number; live: number; max: number } {
  return { total: entries.size, live: [...entries.values()].filter((e) => e.slot.live).length, max: MAX_LIVE };
}
