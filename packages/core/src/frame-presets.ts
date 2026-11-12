/**
 * Sizes for artboards, by what they are for. Phone and tablet sizes are the CSS viewport of the device in
 * portrait, which is what a page is laid out at, not its pixels.
 */

export type FramePresetGroup = 'Desktop' | 'Tablet' | 'Phone' | 'Watch' | 'Social' | 'Slides' | 'Print';

export interface FramePreset { name: string; w: number; h: number; group: FramePresetGroup }

export const FRAME_PRESETS: readonly FramePreset[] = [
  { name: 'Desktop', w: 1440, h: 1024, group: 'Desktop' },
  { name: 'Wide desktop', w: 1920, h: 1080, group: 'Desktop' },
  { name: 'Laptop', w: 1280, h: 800, group: 'Desktop' },
  { name: 'MacBook Air', w: 1280, h: 832, group: 'Desktop' },
  { name: 'MacBook Pro 16', w: 1728, h: 1117, group: 'Desktop' },
  { name: 'Tablet', w: 834, h: 1194, group: 'Tablet' },
  { name: 'iPad mini', w: 744, h: 1133, group: 'Tablet' },
  { name: 'iPad Pro 13', w: 1032, h: 1376, group: 'Tablet' },
  { name: 'Surface Pro', w: 912, h: 1368, group: 'Tablet' },
  { name: 'Phone', w: 393, h: 852, group: 'Phone' },
  { name: 'iPhone 16 Pro Max', w: 440, h: 956, group: 'Phone' },
  { name: 'iPhone SE', w: 375, h: 667, group: 'Phone' },
  { name: 'Pixel 9', w: 412, h: 923, group: 'Phone' },
  { name: 'Galaxy S24', w: 360, h: 780, group: 'Phone' },
  { name: 'Small phone', w: 360, h: 640, group: 'Phone' },
  { name: 'Apple Watch 45mm', w: 198, h: 242, group: 'Watch' },
  { name: 'Social square', w: 1080, h: 1080, group: 'Social' },
  { name: 'Social portrait', w: 1080, h: 1350, group: 'Social' },
  { name: 'Social story', w: 1080, h: 1920, group: 'Social' },
  { name: 'Open Graph', w: 1200, h: 630, group: 'Social' },
  { name: 'YouTube thumbnail', w: 1280, h: 720, group: 'Social' },
  { name: 'Slide 16:9', w: 1920, h: 1080, group: 'Slides' },
  { name: 'Slide 4:3', w: 1024, h: 768, group: 'Slides' },
  { name: 'A4', w: 595, h: 842, group: 'Print' },
  { name: 'A5', w: 420, h: 595, group: 'Print' },
  { name: 'Letter', w: 612, h: 792, group: 'Print' },
];

/** A preset by name, ignoring case and spaces, such as "iphone 16 pro max" or "slide-16:9". */
export function framePreset(name: string): FramePreset | undefined {
  const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  return FRAME_PRESETS.find((p) => key(p.name) === key(name));
}

/** The preset a frame of this size is, in either orientation. */
export function presetOfSize(w: number, h: number): { preset: FramePreset; landscape: boolean } | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  for (const preset of FRAME_PRESETS) {
    if (near(preset.w, w) && near(preset.h, h)) return { preset, landscape: false };
    if (preset.w !== preset.h && near(preset.w, h) && near(preset.h, w)) return { preset, landscape: true };
  }
  return undefined;
}
