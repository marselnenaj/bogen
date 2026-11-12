import { create } from 'zustand';
import type { BrandReport } from '../lib/brand-api.ts';
import type { ServerEvent } from '../lib/events.ts';
import { onServerEvent } from '../lib/events.ts';
import { editor } from '../state/store.ts';
import { laneOfRun } from './race-state.ts';

export interface RunReport { runId: string; runner: string; score: number; hard: number; soft: number; waived: number; checklist: number; text: string; at: number; violations: { node_id: string; layer: string; rule: string; severity: string; message: string }[] }

interface BrandState {
  /** Violations on the canvas, with a toggle of their own. */
  markers: boolean;
  report: BrandReport | null;
  reportFileId: string | null;
  runs: RunReport[];
  set: (patch: Partial<Omit<BrandState, 'set'>>) => void;
}

const MARKER_KEY = 'bogen-brand-markers';

function savedMarkers(): boolean {
  try {
    return localStorage.getItem(MARKER_KEY) !== 'off';
  } catch {
    return true;
  }
}

export const useBrandState = create<BrandState>((set) => ({
  markers: savedMarkers(),
  report: null,
  reportFileId: null,
  runs: [],
  set: (patch) => {
    if (patch.markers !== undefined) {
      try {
        localStorage.setItem(MARKER_KEY, patch.markers ? 'on' : 'off');
      } catch {
        // Fine: it just does not survive a reload.
      }
    }
    set(patch);
  },
}));

function onReport(e: Extract<ServerEvent, { t: 'brand-report' }>): void {
  const state = editor();
  if (e.fileId !== state.fileId) return;
  const report: RunReport = { runId: e.runId, runner: e.runner, score: e.score, hard: e.hard, soft: e.soft, waived: e.waived, checklist: e.checklist, text: e.text, at: Date.now(), violations: e.violations };
  useBrandState.getState().set({ runs: [report, ...useBrandState.getState().runs].slice(0, 20) });
  // In the run's own output, as its last line. The lanes of a race end one by one, so each says whose it is.
  const lane = laneOfRun(e.runId);
  state.set({ prompt: { ...state.prompt, messages: [...state.prompt.messages, { role: 'agent', text: lane ? `${lane.agent}: ${e.text}` : e.text }] } });
}

export function startBrandEvents(): () => void {
  return onServerEvent((e) => {
    if (e.t === 'brand-report') onReport(e);
  });
}
