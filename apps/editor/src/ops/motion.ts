import { elOf } from '../canvas/measure.ts';
import { ui } from '../state/ui.ts';

/** Everything moving on the canvas goes through the real Web Animations of the elements. */
function worldAnimations(): Animation[] {
  return document.querySelector('.bogen-world')?.getAnimations({ subtree: true }) ?? [];
}

export function pauseAllMotion(): void {
  ui().set({ motionPaused: true });
  document.querySelector('.bogen-world')?.classList.add('is-motion-paused');
  for (const a of worldAnimations()) a.pause();
}

export function playAllMotion(): void {
  ui().set({ motionPaused: false });
  document.querySelector('.bogen-world')?.classList.remove('is-motion-paused');
  for (const a of worldAnimations()) a.play();
}

export function toggleAllMotion(): void {
  if (ui().motionPaused) playAllMotion();
  else pauseAllMotion();
}

/** Holds every animation of an artboard at one moment of its timeline. */
export function scrubTo(rootId: string, time: number): void {
  const root = elOf(rootId);
  if (!root) return;
  if (!ui().motionPaused) ui().set({ motionPaused: true });
  document.querySelector('.bogen-world')?.classList.add('is-motion-paused');
  for (const a of root.getAnimations({ subtree: true })) {
    a.pause();
    a.currentTime = time;
  }
}
