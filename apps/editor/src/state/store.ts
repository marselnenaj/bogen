import { create } from 'zustand';
import { rememberedTool, rememberTool, type Tool } from './tool-preference.ts';
export type { Tool } from './tool-preference.ts';
import type { Guide, GapMark } from '../canvas/snap.ts';
import type { Measurement, Rect } from '../canvas/geometry.ts';
import type { Peer } from '../doc/session.ts';
import type { ThreadRun } from '../lib/api.ts';
import type { ServerEvent } from '../lib/events.ts';

export type RightTab = 'design' | 'code' | 'comments' | 'export' | 'agents' | 'motion' | 'history' | 'drift';
export type LeftTab = 'layers' | 'tokens' | 'brand' | 'assets' | 'data';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface DropIndicator {
  /** A line in world coordinates, or a highlighted container. */
  line?: { x0: number; y0: number; x1: number; y1: number };
  container?: Rect;
}

/** Transient overlay data of the running gesture. */
export interface GestureView {
  marquee?: Rect;
  guides?: Guide[];
  gaps?: GapMark[];
  drop?: DropIndicator;
  drawing?: Rect;
  label?: { text: string; x: number; y: number };
  zoomBox?: Rect;
  pencil?: string;
  linePreview?: { x0: number; y0: number; x1: number; y1: number };
  /** Active while dragging, to hide handles. */
  active?: 'move' | 'resize' | 'rotate';
}

export interface ActivityEntry { id: string; agent: string; tool: string; nodeIds: string[]; at: number }
/**
 * One line of the chat with the agent. `runId` on an agent's message: the run that wrote it, whose changes show under
 * its last words. A person's message keeps what went with it (`context`: the names of the layers, `images`: stored
 * images) and how it was asked (`runner`, `review`), so that Ask again repeats it. `note` is what Bogen says about a
 * run, such as that it was stopped.
 */
export interface PromptMessage {
  role: 'user' | 'agent' | 'tool' | 'error' | 'note';
  text: string;
  runId?: string;
  at?: number;
  runner?: string;
  review?: string;
  context?: string[];
  images?: string[];
}
export interface PromptState {
  /** An explicit scoped redo; opening it starts no agent. */
  redo?: { id: string; nodeId: string; name: string };
  open: boolean;
  runId: string | null;
  running: boolean;
  messages: PromptMessage[];
  nodeIds: string[];
  /** When the run going now started, for the time it has taken. */
  startedAt?: number;
}

export interface PendingComment { x: number; y: number; nodeId?: string }

export interface EditorState {
  fileId: string | null;
  fileName: string;
  ready: boolean;
  connection: ConnectionState;
  everConnected: boolean;
  pageId: string | null;

  tool: Tool;
  /** The last tool stays armed after drawing when picked with a double press. Not used yet by default. */
  selection: string[];
  hoverId: string | null;
  editingTextId: string | null;
  editingPathId: string | null;
  altDown: boolean;

  gesture: GestureView;
  peers: Peer[];
  followClientId: number | null;
  activeAgents: Record<string, { nodeIds: string[]; at: number; tool: string }>;
  activity: ActivityEntry[];

  leftTab: LeftTab;
  rightTab: RightTab;
  leftWidth: number;
  rightWidth: number;
  /** The chat panel's width, in UI pixels. Whether it is open is `prompt.open`, remembered per file. */
  chatWidth: number;
  minimal: boolean;
  collapsed: Record<string, boolean>;
  shortcutsOpen: boolean;
  renamingLayerId: string | null;
  /** The same, in the frame label on the canvas. */
  renamingLabelId: string | null;

  prompt: PromptState;
  pendingComment: PendingComment | null;
  activeThreadId: string | null;
  /** Agents working on or waiting for a comment, by thread. */
  threadRuns: Record<string, ThreadRun>;
  /** Whether agents may select layers and move the view for this person. */
  followAgents: boolean;
  cursorChat: { open: boolean; text: string };
  toast: string | null;

  set: (patch: Partial<EditorState>) => void;
  setSelection: (ids: string[]) => void;
  setTool: (tool: Tool) => void;
  setGesture: (g: GestureView) => void;
  showToast: (text: string) => void;
}

const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem('bogen-layout') ?? '{}') as Partial<Pick<EditorState, 'leftWidth' | 'rightWidth' | 'chatWidth' | 'minimal' | 'followAgents'>>;
  } catch {
    return {};
  }
})();

let toastTimer = 0;

export const useEditor = create<EditorState>((set) => ({
  fileId: null,
  fileName: '',
  ready: false,
  connection: 'connecting',
  everConnected: false,
  pageId: null,

  tool: rememberedTool(),
  selection: [],
  hoverId: null,
  editingTextId: null,
  editingPathId: null,
  altDown: false,

  gesture: {},
  peers: [],
  followClientId: null,
  activeAgents: {},
  activity: [],

  leftTab: 'layers',
  rightTab: 'design',
  leftWidth: stored.leftWidth ?? 248,
  rightWidth: stored.rightWidth ?? 280,
  chatWidth: Math.max(280, Math.min(640, stored.chatWidth ?? 340)),
  minimal: stored.minimal ?? false,
  collapsed: {},
  shortcutsOpen: false,
  renamingLayerId: null,
  renamingLabelId: null,

  prompt: { open: false, runId: null, running: false, messages: [], nodeIds: [] },
  pendingComment: null,
  activeThreadId: null,
  threadRuns: {},
  followAgents: stored.followAgents ?? true,
  cursorChat: { open: false, text: '' },
  toast: null,

  set: (patch) => set(patch),
  setSelection: (ids) => set({ selection: ids }),
  setTool: (tool) => { rememberTool(tool); set({ tool, pendingComment: null }); },
  setGesture: (gesture) => set({ gesture }),
  showToast: (text) => {
    clearTimeout(toastTimer);
    set({ toast: text });
    toastTimer = window.setTimeout(() => set({ toast: null }), 3200);
  },
}));

export function editor(): EditorState {
  return useEditor.getState();
}

useEditor.subscribe((s, prev) => {
  if (s.leftWidth !== prev.leftWidth || s.rightWidth !== prev.rightWidth || s.chatWidth !== prev.chatWidth || s.minimal !== prev.minimal) {
    try {
      localStorage.setItem('bogen-layout', JSON.stringify({ leftWidth: s.leftWidth, rightWidth: s.rightWidth, chatWidth: s.chatWidth, minimal: s.minimal, followAgents: s.followAgents }));
    } catch {
      // Layout simply does not persist in private mode.
    }
  }
});

export type { ServerEvent };
