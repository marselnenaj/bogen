import { parse, wcagLuminance } from 'culori';

/** Black or white, whichever reads better on a colour someone picked. Falls back on white. */
export function readableOn(color: string): string {
  try {
    const c = parse(color);
    if (!c) return '#ffffff';
    const l = wcagLuminance(c);
    return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
  } catch {
    return '#ffffff';
  }
}
