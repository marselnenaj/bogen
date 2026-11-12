const TOOLS = ['move', 'hand', 'frame', 'rect', 'ellipse', 'line', 'text', 'pen', 'pencil', 'comment', 'shader', 'zoom'] as const;
export type Tool = typeof TOOLS[number];
const KEY = 'bogen-tool';
function load(): Tool {
  try {
    const value = localStorage.getItem(KEY);
    return TOOLS.includes(value as Tool) ? value as Tool : 'move';
  } catch { return 'move'; }
}
let preferred = load();

/** Device preference: temporary pan and automatic post-draw tool changes do not overwrite it. */
export function rememberedTool(): Tool { return preferred; }
export function rememberTool(tool: Tool): void {
  preferred = tool;
  try { localStorage.setItem(KEY, tool); } catch { /* Keep the choice for this session. */ }
}
