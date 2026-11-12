import { create } from 'zustand';

/** Preferences of this person on this device. */
export interface Settings {
  appearance: 'system' | 'light' | 'dark';
  motion: 'system' | 'reduced';
  nudgeSmall: number;
  nudgeBig: number;
  /** Which way a ctrl+wheel moves the zoom. */
  zoomDirection: 'normal' | 'inverted';
  /** What a plain wheel does on the canvas. */
  wheel: 'pan' | 'zoom';
  /** The interface size in use: the person's choice, or the screen's default until they make one. */
  uiScale: number;
  /** Whether an agent in this browser may use Bogen's tools through WebMCP, when the browser has it. */
  webmcp: 'on' | 'off';
  /** Layout grids of frames show on the canvas, and moves snap to them. */
  layoutGrids: boolean;
}

export const DEFAULT_SETTINGS: Settings = { appearance: 'system', motion: 'system', nudgeSmall: 1, nudgeBig: 10, zoomDirection: 'normal', wheel: 'pan', uiScale: 1, webmcp: 'on', layoutGrids: true };
const KEY = 'bogen-settings';

/**
 * The interface size for someone who never chose one. A large screen at a pixel ratio near 1, like a 4K monitor at
 * scale 1, shows the interface at its CSS size in very small physical pixels, so it starts at 150%.
 */
export function defaultUiScale(screenWidth: number, devicePixelRatio: number): number {
  return screenWidth * devicePixelRatio >= 3200 && devicePixelRatio < 1.5 ? 1.5 : 1;
}

function screenUiScale(): number {
  if (typeof window === 'undefined' || typeof screen === 'undefined') return 1;
  return defaultUiScale(screen.width, window.devicePixelRatio || 1);
}

/** What is stored: the settings, with `uiScale` only once the person picked a size. */
type Stored = Partial<Omit<Settings, 'uiScale'>> & { uiScale?: number; uiScaleChosen?: boolean };

/**
 * Settings from what is stored, and whether the size in them was the person's choice. Before sizes followed the
 * screen, every save wrote uiScale, so an older 1 without the mark is the old default rather than a choice.
 */
export function readSettings(raw: string | null, screenDefault: number): { settings: Settings; uiScaleChosen: boolean } {
  let stored: Stored = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object') stored = parsed as Stored;
  } catch { /* defaults */ }
  const { uiScale, uiScaleChosen: mark, ...rest } = stored;
  const chosen = typeof uiScale === 'number' && uiScale > 0 && (mark === true || uiScale !== 1);
  return { settings: { ...DEFAULT_SETTINGS, ...rest, appearance: rest.appearance === 'light' || rest.appearance === 'dark' ? rest.appearance : 'system', motion: rest.motion === 'reduced' ? 'reduced' : 'system', uiScale: chosen ? uiScale : screenDefault }, uiScaleChosen: chosen };
}

function storedText(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

const initial = readSettings(storedText(), screenUiScale());
let uiScaleChosen = initial.uiScaleChosen;

function save(): void {
  const { update: _u, reset: _r, uiScale, ...plain } = useSettings.getState();
  const out: Stored = uiScaleChosen ? { ...plain, uiScale, uiScaleChosen: true } : plain;
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* stays for this session */ }
}

export const useSettings = create<Settings & { update: (patch: Partial<Settings>) => void; reset: () => void }>((set) => ({
  ...initial.settings,
  update: (patch) => {
    if (patch.uiScale !== undefined) uiScaleChosen = true;
    set(patch);
    save();
    applyUiScale();
  },
  /** Back to the defaults, with the interface size following the screen again. */
  reset: () => {
    uiScaleChosen = false;
    set({ ...DEFAULT_SETTINGS, uiScale: screenUiScale() });
    save();
    applyUiScale();
  },
}));

export function settings(): Settings {
  return useSettings.getState();
}

export function applyUiScale(): void {
  document.documentElement.style.setProperty('--ui-scale', String(settings().uiScale));
  document.documentElement.dataset.uiMotion = settings().motion;
}

/** Until the person picks a size, the default follows the screen, such as when the window moves to another monitor. */
export function followScreenScale(): void {
  const follow = () => {
    if (uiScaleChosen) return;
    const next = screenUiScale();
    if (next === settings().uiScale) return;
    useSettings.setState({ uiScale: next });
    applyUiScale();
  };
  window.addEventListener('resize', follow);
}

/** Category resets preserve unrelated device preferences. Appearance resumes automatic display scaling. */
export function resetSettingsSection(section: 'appearance' | 'canvas' | 'privacy'): void {
  if (section === 'appearance') {
    uiScaleChosen = false;
    useSettings.setState({ appearance: 'system', motion: 'system', uiScale: screenUiScale() });
  } else if (section === 'canvas') {
    const {nudgeSmall,nudgeBig,zoomDirection,wheel,layoutGrids}=DEFAULT_SETTINGS;
    useSettings.setState({nudgeSmall,nudgeBig,zoomDirection,wheel,layoutGrids});
  } else useSettings.setState({webmcp: DEFAULT_SETTINGS.webmcp});
  save(); applyUiScale();
}
