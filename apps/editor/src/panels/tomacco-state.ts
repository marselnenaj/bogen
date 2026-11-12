/**
 * What the editor says about Tomacco before a screen is taken, from `GET /api/tomacco/status`. Kept apart from the
 * components so that it can be tested without a browser. Bogen only ever shows the command; the person runs it.
 */

export interface TomaccoStep { goal: string | null; what: string; how: string | null; askFirst: boolean }
export interface TomaccoStatus {
  state: 'missing' | 'no-device' | 'ready';
  version: string | null;
  devices: { id: string; platform: string; name: string; state?: string }[];
  notes: string[];
  steps: TomaccoStep[];
  fix: string | null;
}

export type TomaccoView =
  | { kind: 'checking' }
  | { kind: 'ready'; devices: number }
  /** tomaccoctl is not on this computer: `command` installs it. */
  | { kind: 'missing'; command: string | null }
  /**
   * Installed, nothing running: `what` is doctor's next step, `command` its command when it has one, `detail` its
   * instructions when they are prose, `askFirst` when Tomacco marks it as one to agree to.
   */
  | { kind: 'no-device'; what: string | null; command: string | null; detail: string | null; askFirst: boolean }
  /** Not asked: on a paired phone, or the server answered with an error. */
  | { kind: 'unknown'; message: string };

/** Commands only, never prose: doctor writes "Run: tomaccoctl setup --yes. It downloads ...", and the copy button takes the command. */
export function commandOf(how: string | null): string | null {
  if (!how) return null;
  const text = how.trim();
  const run = /^Run:\s*(.+?)(?:\.\s+[A-Z]|\.?$)/.exec(text);
  if (run) return run[1]!.trim();
  // A bare command: one line, starting with a program name, without sentence punctuation at its end.
  return /^[a-z][\w.-]*(\s|$)/.test(text) && !text.includes('\n') && !/[.!?]$/.test(text) ? text : null;
}

export function tomaccoView(status: TomaccoStatus | null, error?: string | null): TomaccoView {
  if (error) return { kind: 'unknown', message: error };
  if (!status) return { kind: 'checking' };
  if (status.state === 'ready') return { kind: 'ready', devices: status.devices.length };
  if (status.state === 'missing') return { kind: 'missing', command: commandOf(status.fix) ?? status.fix };
  const step = status.steps.find((s) => s.how) ?? status.steps[0] ?? null;
  const how = step?.how ?? status.fix;
  const command = commandOf(how);
  return { kind: 'no-device', what: step?.what ?? null, command, detail: command === how ? null : how, askFirst: step?.askFirst ?? false };
}
