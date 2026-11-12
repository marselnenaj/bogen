import { useSyncExternalStore } from 'react';
import { applyResponsive, responsiveLink, type ResponsiveMethod } from '@bogen/core';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** What the server's width check says about one width, as responsive_check returns it. */
export interface WidthIssue { id: string; name: string; by?: number; side?: string; text?: string }
export interface WidthReport { width: number; ok: boolean; content_wider_by: number; overflow: WidthIssue[]; clipped_text: WidthIssue[]; artboard?: string }
export interface ResponsiveRun { method: ResponsiveMethod; widths: number[]; layers: number; artboards: string[]; notes: string[]; check: WidthReport[] | null; error?: string }

export const DEFAULT_WIDTHS = [768, 390];

// The last run per source artboard, so that the section shows it however the run was started.
const runs = new Map<string, ResponsiveRun>();
const listeners = new Set<() => void>();
const publish = (id: string, run: ResponsiveRun) => {
  runs.set(id, run);
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useResponsiveRun(id: string): ResponsiveRun | undefined {
  return useSyncExternalStore(subscribe, () => runs.get(id));
}

async function check(fileId: string, nodeId: string, widths: number[]): Promise<WidthReport[]> {
  const res = await fetch('/api/responsive-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeId, widths }) });
  const body = await res.json().catch(() => ({})) as { widths?: WidthReport[]; error?: string };
  if (!res.ok || !body.widths) throw new Error(body.error ?? t('The check answered {status}.', { status: res.status }));
  return body.widths;
}

/**
 * Makes an artboard's narrower versions as one undo step, then asks the server to lay each width out
 * and say what still sticks out. The check needs the renderer, so it can fail where editing does not.
 */
export async function makeResponsive(id: string, options: { widths?: number[]; method?: ResponsiveMethod } = {}): Promise<ResponsiveRun> {
  const s = session();
  const widths = options.widths?.length ? options.widths : DEFAULT_WIDTHS;
  const method = options.method ?? 'rules';
  const result = s.tx(() => applyResponsive(s.doc, id, { widths, method }));
  const run: ResponsiveRun = { method, widths: result.steps.map((st) => st.width), layers: result.layers, artboards: method === 'artboards' ? result.artboards.map((a) => a.id) : [], notes: result.notes, check: null };
  publish(id, run);
  const fileId = editor().fileId;
  if (!fileId) return run;
  // The edit reaches the server over the socket; this gives it a moment to arrive before the server lays it out.
  await new Promise((r) => setTimeout(r, 250));
  try {
    const reports = method === 'rules'
      ? await check(fileId, id, run.widths)
      : await Promise.all(result.artboards.map(async (a) => ({ ...(await check(fileId, a.id, [a.width]))[0]!, artboard: a.id })));
    const done = { ...run, check: reports };
    publish(id, done);
    return done;
  } catch (e) {
    const failed = { ...run, error: (e as Error).message };
    publish(id, failed);
    return failed;
  }
}

/** The palette command: the selected artboard, or the one the selection is in, at 768 and 390. */
export function makeResponsiveFromSelection(): void {
  const { snap } = session();
  const first = editor().selection[0];
  if (!first) return editor().showToast(t('Select an artboard to make its narrower versions.'));
  const top = snap.ancestors(first).at(-1) ?? first;
  const node = snap.nodes.get(top);
  if (!node?.artboard) return editor().showToast(t('Select an artboard to make its narrower versions.'));
  const source = responsiveLink(session().doc, top)?.source ?? top;
  editor().set({ selection: [source], rightTab: 'design' });
  void makeResponsive(source).then((run) => {
    if (run.error) editor().showToast(t('Made the variants. The check did not run: {error}', { error: run.error }));
    else editor().showToast(run.check?.every((r) => r.ok) ? t('Made 768 and 390. Everything fits.') : t('Made 768 and 390. Some layers still stick out: see Responsive.'));
  }, (e) => editor().showToast((e as Error).message));
}
