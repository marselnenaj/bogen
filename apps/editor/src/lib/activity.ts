import { create } from 'zustand';

/**
 * Work that goes on in the background: a design review, a fix run, pictures being made, a brand taken from a
 * website. Each is a pill in the dock at the foot of the window (ActivityDock.tsx), the one the call bar uses, with
 * what is happening, how long it has run, Open and Stop. Whoever starts the work keeps its pill current here.
 */
export type ActivityKind = 'review' | 'fix' | 'image' | 'brand';
export type ActivityState = 'running' | 'done' | 'failed' | 'stopped';

export interface Activity {
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  /** What is happening, short: "Fable is looking", "Review done · 7.4". */
  title: string;
  /** Where and what: "Teahouse Kiri · 6 screens". */
  detail?: string;
  startedAt: number;
  endedAt?: number;
  /** A done review's score, drawn as a small ring. */
  score?: number;
  /** Small pictures of what is being worked on, for the pill's art. */
  pictures?: string[];
  /** Back to where the work is shown in full. */
  open?: () => void;
  /** Ends the work. Only work that can really be stopped has it. */
  stop?: () => void;
  /** What Stop says to a screen reader and in its tooltip: "Stop the review". */
  stopLabel?: string;
  /** True while the work's own surface shows it, such as its dialog: the pill would only repeat it. */
  covered?: () => boolean;
}

interface ActivityStore { items: Activity[] }
export const useActivities = create<ActivityStore>(() => ({ items: [] }));

/** Adds an activity, or changes the one with this id. */
export function putActivity(a: Activity): void {
  useActivities.setState((s) => {
    const at = s.items.findIndex((x) => x.id === a.id);
    if (at < 0) return { items: [...s.items, a] };
    const items = s.items.slice();
    items[at] = a;
    return { items };
  });
}

/** Changes part of an activity, when it is there. */
export function patchActivity(id: string, patch: Partial<Activity>): void {
  const now = useActivities.getState().items.find((x) => x.id === id);
  if (now) putActivity({ ...now, ...patch });
}

export function dropActivity(id: string): void {
  useActivities.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

export function activity(id: string): Activity | undefined {
  return useActivities.getState().items.find((x) => x.id === id);
}

/** m:ss, or h:mm:ss past an hour. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
