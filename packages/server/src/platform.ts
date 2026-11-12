/**
 * The theme where the desktop offers none. `mode` stays unset, so that the editor keeps following the system's
 * light or dark through `prefers-color-scheme`; on a Mac only the accent changes, to the system blue.
 */
export function platformTheme(platform: NodeJS.Platform = process.platform): { name: string; vars: Record<string, string> } | null {
  if (platform !== 'darwin') return null;
  return { name: 'macOS', vars: { '--ui-accent': '#007aff', '--ui-accent-fg': '#ffffff' } };
}
