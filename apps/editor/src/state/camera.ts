import { fitRect, zoomAt, type Camera, type Rect, type Vec } from '../canvas/geometry.ts';

type Listener = () => void;

/**
 * Pan and zoom live outside React: the world transform is written straight to the DOM and the overlay
 * listens. Nothing in the layer tree re-renders while panning.
 */
class CameraStore {
  value: Camera = { x: 0, y: 0, z: 1 };
  private listeners = new Set<Listener>();
  private world: HTMLElement | null = null;
  private overlayRoot: HTMLElement | null = null;
  viewport: HTMLElement | null = null;
  width = 0;
  height = 0;
  left = 0;
  top = 0;
  private settleTimer = 0;

  attach(world: HTMLElement | null, overlayRoot: HTMLElement | null): void {
    this.world = world;
    this.overlayRoot = overlayRoot;
    this.write();
  }

  setViewport(el: HTMLElement | null): void {
    this.viewport = el;
    this.measureViewport();
  }

  measureViewport(): void {
    if (!this.viewport) return;
    const r = this.viewport.getBoundingClientRect();
    this.width = r.width;
    this.height = r.height;
    this.left = r.left;
    this.top = r.top;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private write(): void {
    const { x, y, z } = this.value;
    if (this.world) this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    const o = this.overlayRoot;
    if (o) {
      o.style.setProperty('--cx', String(x));
      o.style.setProperty('--cy', String(y));
      o.style.setProperty('--z', String(z));
    }
  }

  set(next: Camera, moving = true): void {
    this.value = next;
    this.write();
    if (moving && this.world) {
      // Keep the world on its own layer while moving, and let it re-rasterize sharp afterwards.
      this.world.style.willChange = 'transform';
      clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => {
        if (this.world) this.world.style.willChange = 'auto';
      }, 160);
    }
    for (const l of this.listeners) l();
  }

  pan(dx: number, dy: number): void {
    this.set({ ...this.value, x: this.value.x + dx, y: this.value.y + dy });
  }

  /** Zoom keeping a viewport-relative point fixed. */
  zoomAt(z: number, anchor?: Vec): void {
    this.set(zoomAt(this.value, z, anchor ?? { x: this.width / 2, y: this.height / 2 }));
  }

  fit(rect: Rect, maxZoom = 1, padding = 72): void {
    this.set(fitRect(rect, this.width, this.height, padding, maxZoom), false);
  }

  /** Viewport-relative position of a client coordinate. */
  fromClient(clientX: number, clientY: number): Vec {
    return { x: clientX - this.left, y: clientY - this.top };
  }

  /** World position of a client coordinate. */
  worldAt(clientX: number, clientY: number): Vec {
    const { x, y, z } = this.value;
    return { x: (clientX - this.left - x) / z, y: (clientY - this.top - y) / z };
  }

  visibleWorld(): Rect {
    const { x, y, z } = this.value;
    return { x: -x / z, y: -y / z, w: this.width / z, h: this.height / z };
  }
}

export const camera = new CameraStore();
