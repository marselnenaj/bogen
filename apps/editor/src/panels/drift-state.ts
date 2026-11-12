import { create } from 'zustand';
import type { DriftReport } from '../lib/drift-api.ts';

interface DriftState {
  report: DriftReport | null;
  fileId: string | null;
  /** The differing pixels over the artboard, and boxes where the live page has more. */
  overlay: boolean;
  /** A drift that only the live page has, shown on the canvas when its row is clicked. */
  focus: number | null;
  set: (patch: Partial<Omit<DriftState, 'set'>>) => void;
}

export const useDriftState = create<DriftState>((set) => ({
  report: null,
  fileId: null,
  overlay: true,
  focus: null,
  set: (patch) => set(patch),
}));
