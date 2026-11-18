import { execFile } from 'node:child_process';
import type { Connection } from './daemon.ts';

/**
 * `bogen open` prefers a window that is already there (open-routes.ts): the one that shows the file, else one in view.
 * When that window could not come to the front by itself, Hyprland is asked to raise it by its title. Only when no
 * window took it, or it could not be shown, does a new window open, which then says the file is open in another
 * window and offers to use it instead.
 */

export interface OpenAnswer { taken: boolean; focused?: boolean; visible?: boolean; title?: string }

export async function askWindows(conn: Connection, hash: string, raise: boolean): Promise<OpenAnswer> {
  try {
    const res = await fetch(`${conn.url}/api/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) },
      body: JSON.stringify({ hash, raise }),
      signal: AbortSignal.timeout(5000),
    });
    // An older server has no /api/open: nothing took it.
    if (!res.ok) return { taken: false };
    const body = await res.json() as OpenAnswer;
    return { taken: body.taken === true, ...(typeof body.focused === 'boolean' ? { focused: body.focused } : {}), ...(typeof body.visible === 'boolean' ? { visible: body.visible } : {}), ...(typeof body.title === 'string' ? { title: body.title } : {}) };
  } catch {
    return { taken: false };
  }
}

interface HyprClient { address: string; title: string; class: string }

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * The Hyprland window a title names: an Omarchy web app shows the page's title as it is, a browser adds its own name
 * after " - ". Only when exactly one window matches; otherwise the only Bogen web app window, if there is one.
 */
export function pickWindow(clients: readonly HyprClient[], title: string | undefined): HyprClient | null {
  const bogen = clients.filter((c) => /127\.0\.0\.1__|localhost__/.test(c.class));
  if (title) {
    const named = clients.filter((c) => c.title === title || c.title.startsWith(`${title} - `));
    if (named.length === 1) return named[0]!;
    if (named.length > 1) return null;
  }
  return bogen.length === 1 ? bogen[0]! : null;
}

/** Raises a window by its title on Hyprland. False anywhere else, or when it is not clear which window it is. */
export async function raiseWindow(title: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  const out = await run('hyprctl', ['-j', 'clients']);
  if (!out) return false;
  let clients: HyprClient[];
  try {
    clients = (JSON.parse(out) as HyprClient[]).filter((c) => typeof c?.address === 'string' && typeof c.title === 'string' && typeof c.class === 'string');
  } catch {
    return false;
  }
  const win = pickWindow(clients, title);
  if (!win) return false;
  return (await run('hyprctl', ['dispatch', 'focuswindow', `address:${win.address}`])) !== null;
}

/** Shows an address in a Bogen window: one that is there if it can, else a new one. Says which. */
export async function openInBogen(conn: Connection, hash: string, newWindow: () => void, platform: NodeJS.Platform = process.platform): Promise<'window' | 'new'> {
  // Where this command can bring a window forward itself, a window in view may take the file too.
  const answer = await askWindows(conn, hash, Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE) || platform === 'darwin');
  if (answer.taken) {
    if (answer.focused) return 'window';
    if (await raiseWindow(answer.title)) return 'window';
    // Only a Mac tells a page whether other windows cover it; elsewhere "visible" may mean behind them.
    if (answer.visible && platform === 'darwin') return 'window';
  }
  newWindow();
  return 'new';
}
