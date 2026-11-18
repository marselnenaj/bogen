/**
 * One window per file, in one browser (one profile): the Bogen windows of it agree over a BroadcastChannel who shows
 * which file. When a second window opens a file another one shows, it asks that one to come to the front (which a
 * browser often does not allow), and shows a calm notice instead of a second editor: "This file is open in another
 * window", with Use this window (the other one goes Home) and Close. If the other window closes, this one takes the
 * file. A phone or another device is another browser and never takes part.
 *
 * The logic is a plain class over a message port and a host, so it is tested without a browser (one-window.test.ts).
 */

export type WindowMsg =
  | { k: 'hello'; from: string }
  | { k: 'showing'; from: string; fileId: string | null; at: number; take?: boolean }
  | { k: 'bye'; from: string }
  | { k: 'who'; from: string; fileId: string; nonce: string }
  | { k: 'here'; from: string; to: string; fileId: string; nonce: string }
  | { k: 'focus'; from: string; to: string; fileId: string; hash: string }
  | { k: 'focused'; from: string; to: string; fileId: string; ok: boolean }
  | { k: 'take'; from: string; to: string; fileId: string };

export interface WindowPort {
  post(msg: WindowMsg): void;
  listen(fn: (msg: WindowMsg) => void): () => void;
}

/** What the coordinator may do to its window. */
export interface WindowHost {
  now(): number;
  later(fn: () => void, ms: number): () => void;
  /** Asks the browser to bring this window to the front; it may not. */
  focus(): void;
  hasFocus(): boolean;
  /** The address of this window, and going to another one of the same file (a layer, a page). */
  hash(): string;
  setHash(hash: string): void;
  /** Home, after another window took the file. */
  goHome(): void;
  /** True when a script may close this window (opened alone, by a link or a launcher, and not navigated since). */
  closable(): boolean;
  close(): void;
}

/** What this window does with the file it wants to show. */
export type Holding =
  | { state: 'none' }
  | { state: 'checking'; fileId: string }
  | { state: 'mine'; fileId: string }
  | { state: 'elsewhere'; fileId: string; other: string };

/** How long a new window listens for the others before it decides, and how long a stale-looking window may take to answer. */
export const HELLO_MS = 150;
export const WHO_MS = 350;
export const FOCUS_MS = 250;

export class WindowCoordinator {
  readonly me: string;
  private others = new Map<string, { fileId: string | null; at: number }>();
  private mine: { fileId: string; at: number; taken: boolean } | null = null;
  private wanted: { fileId: string; hash: string } | null = null;
  private holding: Holding = { state: 'none' };
  private primed = false;
  private pending: { nonce: string; cancel: () => void } | null = null;
  private listeners = new Set<(h: Holding) => void>();
  private off: () => void;

  constructor(private readonly port: WindowPort, private readonly host: WindowHost, me?: string) {
    this.me = me ?? Math.random().toString(36).slice(2, 12);
    this.off = port.listen((m) => this.onMessage(m));
    port.post({ k: 'hello', from: this.me });
    host.later(() => {
      this.primed = true;
      this.decide();
    }, HELLO_MS);
  }

  get current(): Holding { return this.holding; }

  subscribe(fn: (h: Holding) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Whether this window shows the file. */
  holds(fileId: string): boolean { return this.mine?.fileId === fileId; }

  /** Whether another window of this browser shows the file, as far as this one knows. */
  heldElsewhere(fileId: string): boolean {
    for (const o of this.others.values()) if (o.fileId === fileId) return true;
    return false;
  }

  /** The editor wants to show a file here, or nothing (Home, another screen). */
  want(fileId: string | null, hash = ''): void {
    if (this.wanted?.fileId === fileId) {
      if (fileId) this.wanted = { fileId, hash };
      return;
    }
    this.cancelPending();
    this.wanted = fileId ? { fileId, hash } : null;
    if (!fileId) {
      this.release();
      this.set({ state: 'none' });
      return;
    }
    if (this.mine && this.mine.fileId !== fileId) this.release();
    this.decide();
  }

  /** Use this window: the other one goes Home. */
  take(): void {
    const h = this.holding;
    if (h.state !== 'elsewhere') return;
    this.port.post({ k: 'take', from: this.me, to: h.other, fileId: h.fileId });
    this.others.delete(h.other);
    this.claim(h.fileId, true);
  }

  /** Close: the window if the browser lets a script close it, else Home. */
  dismiss(): void {
    if (this.host.closable()) this.host.close();
    // Still here: closing was not allowed.
    this.host.later(() => this.host.goHome(), 120);
  }

  /** Before the page goes. */
  dispose(): void {
    this.cancelPending();
    this.port.post({ k: 'bye', from: this.me });
    this.off();
  }

  private set(h: Holding): void {
    if (JSON.stringify(h) === JSON.stringify(this.holding)) return;
    this.holding = h;
    for (const fn of this.listeners) fn(h);
  }

  private cancelPending(): void {
    this.pending?.cancel();
    this.pending = null;
  }

  private release(): void {
    if (!this.mine) return;
    this.mine = null;
    this.port.post({ k: 'showing', from: this.me, fileId: null, at: this.host.now() });
  }

  private claim(fileId: string, taken = false): void {
    this.cancelPending();
    this.mine = { fileId, at: this.host.now(), taken };
    this.set({ state: 'mine', fileId });
    this.port.post({ k: 'showing', from: this.me, fileId, at: this.mine.at, ...(taken ? { take: true } : {}) });
  }

  private holderOf(fileId: string): string | null {
    for (const [win, o] of this.others) if (o.fileId === fileId) return win;
    return null;
  }

  /** Decides for the wanted file: mine, someone else's (asked to be sure), or wait for the others to say. */
  private decide(): void {
    const w = this.wanted;
    if (!w || this.holds(w.fileId)) return;
    const other = this.holderOf(w.fileId);
    if (other) return this.verify(w.fileId, other);
    if (!this.primed) return this.set({ state: 'checking', fileId: w.fileId });
    this.claim(w.fileId);
  }

  /** A window seems to show it: it answers, or it is gone and this window takes the file. */
  private verify(fileId: string, other: string): void {
    if (this.pending) return;
    if (this.holding.state !== 'elsewhere') this.set({ state: 'checking', fileId });
    const nonce = Math.random().toString(36).slice(2, 10);
    const cancel = this.host.later(() => {
      if (this.pending?.nonce !== nonce) return;
      this.pending = null;
      if (this.others.get(other)?.fileId === fileId) this.others.delete(other);
      if (this.wanted?.fileId === fileId) this.decide();
    }, WHO_MS);
    this.pending = { nonce, cancel };
    this.port.post({ k: 'who', from: this.me, fileId, nonce });
  }

  private elsewhere(fileId: string, other: string): void {
    this.cancelPending();
    const was = this.holding;
    this.set({ state: 'elsewhere', fileId, other });
    if (was.state === 'elsewhere' && was.fileId === fileId && was.other === other) return;
    this.port.post({ k: 'focus', from: this.me, to: other, fileId, hash: this.wanted?.hash ?? '' });
  }

  private onMessage(m: WindowMsg): void {
    if (m.from === this.me) return;
    if ('to' in m && m.to !== this.me) return;
    switch (m.k) {
      case 'hello':
        if (this.mine) this.port.post({ k: 'showing', from: this.me, fileId: this.mine.fileId, at: this.mine.at, ...(this.mine.taken ? { take: true } : {}) });
        return;
      case 'bye': {
        this.others.delete(m.from);
        const h = this.holding;
        if (h.state === 'elsewhere' && h.other === m.from) this.decide();
        return;
      }
      case 'showing': {
        if (m.fileId) this.others.set(m.from, { fileId: m.fileId, at: m.at });
        else this.others.delete(m.from);
        const h = this.holding;
        if (!m.fileId) {
          if (h.state === 'elsewhere' && h.other === m.from) this.decide();
          return;
        }
        if (this.mine?.fileId === m.fileId) {
          if (m.take) {
            // Use this window, over there: this one goes Home.
            this.mine = null;
            this.wanted = null;
            this.set({ state: 'none' });
            this.host.goHome();
            return;
          }
          const older = m.at < this.mine.at || (m.at === this.mine.at && m.from < this.me);
          if (older && !this.mine.taken) {
            // Both opened it at once: the one that was first keeps it.
            this.mine = null;
            this.port.post({ k: 'showing', from: this.me, fileId: null, at: this.host.now() });
            this.elsewhere(m.fileId, m.from);
          } else {
            this.port.post({ k: 'showing', from: this.me, fileId: this.mine.fileId, at: this.mine.at, ...(this.mine.taken ? { take: true } : {}) });
          }
          return;
        }
        if (this.wanted?.fileId === m.fileId && h.state !== 'mine') this.elsewhere(m.fileId, m.from);
        return;
      }
      case 'who':
        if (this.mine?.fileId === m.fileId) this.port.post({ k: 'here', from: this.me, to: m.from, fileId: m.fileId, nonce: m.nonce });
        return;
      case 'here':
        if (this.pending?.nonce !== m.nonce) return;
        this.others.set(m.from, { fileId: m.fileId, at: this.others.get(m.from)?.at ?? 0 });
        if (this.wanted?.fileId === m.fileId) this.elsewhere(m.fileId, m.from);
        return;
      case 'focus': {
        if (this.mine?.fileId !== m.fileId) return;
        // A link to a layer or a page of this file is followed here.
        if (m.hash && m.hash !== this.host.hash() && fileIdOf(m.hash) === m.fileId) this.host.setHash(m.hash);
        this.host.focus();
        this.host.later(() => this.port.post({ k: 'focused', from: this.me, to: m.from, fileId: m.fileId, ok: this.host.hasFocus() }), FOCUS_MS);
        return;
      }
      case 'focused': {
        const h = this.holding;
        // The other window came to the front: a window that was opened only for this file closes.
        if (m.ok && h.state === 'elsewhere' && h.fileId === m.fileId && this.host.closable() && !this.host.hasFocus()) this.host.close();
        return;
      }
      case 'take':
        if (this.mine?.fileId !== m.fileId) return;
        this.mine = null;
        this.wanted = null;
        this.set({ state: 'none' });
        this.port.post({ k: 'showing', from: this.me, fileId: null, at: this.host.now() });
        this.host.goHome();
        return;
    }
  }
}

function fileIdOf(hash: string): string | null {
  if (/^#\/file\/[\w-]+\/preview/.test(hash)) return null;
  return /^#\/file\/([\w-]+)/.exec(hash)?.[1]?.toLowerCase() ?? null;
}
