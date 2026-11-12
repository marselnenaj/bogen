import { FRAME_PRESETS } from '@bogen/core';

/** Artboard sizes; the list lives in core, where agents read it too. */
export const ARTBOARD_PRESETS: { name: string; w: number; h: number }[] = FRAME_PRESETS.map(({ name, w, h }) => ({ name, w, h }));

export const EXPORT_PRESETS: { label: string; scale: number }[] = [
  { label: '0.5x', scale: 0.5 },
  { label: '1x', scale: 1 },
  { label: '2x', scale: 2 },
  { label: '3x', scale: 3 },
  { label: '4x', scale: 4 },
];
