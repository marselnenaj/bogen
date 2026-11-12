import type { BogenDoc, NewNode } from './doc.ts';

/**
 * An artboard made from a screen of an app (see `packages/server/src/tomacco.ts`), and what the file remembers
 * about it in `meta.appScreens`, keyed by the artboard: which device it came from, its size and unit, and which
 * layers are the screenshot and the screen, so that a comparison later knows what to leave out. Older builds keep
 * the key and ignore it.
 */
export interface AppScreenRecord {
  device?: string;
  platform: string;
  model?: string;
  capturedAt?: string;
  app?: string;
  unit: string;
  width: number;
  height: number;
  /** The screenshot as an asset src. */
  screenshot?: string;
  /** The locked image layer with the whole screenshot, when it was kept. */
  screenshotLayer?: string;
  /** The frame that is the screen, inside a device frame. */
  screen?: string;
}

export const SCREENSHOT_LAYER = 'App screenshot';
export const SCREEN_LAYER = 'Screen';

export function appScreenRecords(doc: BogenDoc): Record<string, AppScreenRecord> {
  const value = doc.meta.get('appScreens');
  return value && typeof value === 'object' ? value as Record<string, AppScreenRecord> : {};
}

/** Inserts an artboard planned from a screen and records it. Call inside the caller's transaction, so it is one step. */
export function insertAppScreen(doc: BogenDoc, pageId: string, spec: NewNode, record: Omit<AppScreenRecord, 'screenshotLayer' | 'screen'>): string {
  const id = doc.insert(pageId, spec);
  // Read from the maps: inside a transaction the layers just written are not in the cached views yet.
  const field = (n: string, key: string) => doc.nodes.get(n)?.get(key);
  const below = (parent: string): string[] => [...doc.nodes.keys()].filter((n) => field(n, 'parent') === parent);
  const firstLevel = below(id);
  const shot = [...firstLevel, ...firstLevel.flatMap(below)].find((n) => field(n, 'name') === SCREENSHOT_LAYER && field(n, 'type') === 'image');
  if (shot) doc.updateFields(shot, { locked: true });
  const screen = firstLevel.find((n) => field(n, 'name') === SCREEN_LAYER);
  doc.meta.set('appScreens', { ...appScreenRecords(doc), [id]: { ...record, ...(shot ? { screenshotLayer: shot } : {}), ...(screen ? { screen } : {}) } });
  return id;
}
