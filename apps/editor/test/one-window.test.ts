import { describe, expect, it } from 'vitest';
import { HELLO_MS, WHO_MS, WindowCoordinator, type WindowHost, type WindowMsg } from '../src/tabs/one-window.ts';
import { hintText, tabHints } from '../src/tabs/tab-names.ts';

/** Windows of one browser: a channel that delivers when flushed, and a clock that moves when told. */
function world() {
  let now = 1000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const queue: { to: Set<(m: WindowMsg) => void>; m: WindowMsg; except: (m: WindowMsg) => void }[] = [];
  const listeners = new Map<string, (m: WindowMsg) => void>();
  const flush = () => {
    for (let i = 0; i < 1000 && queue.length; i++) {
      const { m, except } = queue.shift()!;
      for (const fn of [...listeners.values()]) if (fn !== except) fn(m);
    }
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      flush();
      const next = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.dead = true;
      next.fn();
    }
    now = end;
    flush();
  };
  const open = (name: string, opts: { closable?: boolean; focusWorks?: boolean } = {}) => {
    const log: string[] = [];
    const win = { hash: '#/', focused: false, closed: false, log, coord: null as unknown as WindowCoordinator };
    const host: WindowHost = {
      now: () => now,
      later: (fn, ms) => { const t = { at: now + ms, fn, dead: false }; timers.push(t); return () => { t.dead = true; }; },
      focus: () => { log.push('focus'); if (opts.focusWorks) win.focused = true; },
      hasFocus: () => win.focused,
      hash: () => win.hash,
      setHash: (h) => { win.hash = h; log.push(`hash ${h}`); },
      goHome: () => { win.hash = '#/'; log.push('home'); },
      closable: () => opts.closable ?? false,
      close: () => { win.closed = true; log.push('close'); },
    };
    let mine: ((m: WindowMsg) => void) | null = null;
    win.coord = new WindowCoordinator({
      post: (m) => queue.push({ to: new Set(), m, except: mine! }),
      listen: (fn) => { mine = fn; listeners.set(name, fn); return () => listeners.delete(name); },
    }, host, name);
    return win;
  };
  return { open, advance, flush };
}

describe('one window per file', () => {
  it('a file opened in a second window shows the notice there, and asks the first to come forward', () => {
    const w = world();
    const one = w.open('one');
    w.advance(HELLO_MS);
    one.coord.want('aaa', '#/file/aaa');
    expect(one.coord.current).toEqual({ state: 'mine', fileId: 'aaa' });

    const two = w.open('two');
    two.coord.want('aaa', '#/file/aaa?layer=Title');
    w.advance(HELLO_MS + 10);
    expect(two.coord.current).toEqual({ state: 'elsewhere', fileId: 'aaa', other: 'one' });
    expect(one.coord.current).toEqual({ state: 'mine', fileId: 'aaa' });
    // The first window follows the link to the layer and is asked to the front.
    expect(one.log).toContain('focus');
    expect(one.hash).toBe('#/file/aaa?layer=Title');
  });

  it('a window opened only for the file closes when the other one came to the front', () => {
    const w = world();
    const one = w.open('one', { focusWorks: true });
    w.advance(HELLO_MS);
    one.coord.want('aaa');
    const two = w.open('two', { closable: true });
    two.coord.want('aaa');
    w.advance(1000);
    expect(two.closed).toBe(true);
  });

  it('Use this window moves the file over, and the other window goes Home', () => {
    const w = world();
    const one = w.open('one');
    w.advance(HELLO_MS);
    one.coord.want('aaa');
    const two = w.open('two');
    two.coord.want('aaa');
    w.advance(HELLO_MS + 10);
    two.coord.take();
    w.advance(50);
    expect(two.coord.current).toEqual({ state: 'mine', fileId: 'aaa' });
    expect(one.coord.current).toEqual({ state: 'none' });
    expect(one.log).toContain('home');
    // The first window opens the file again later: now the second one has it.
    one.coord.want(null);
    one.coord.want('aaa');
    w.advance(WHO_MS + 10);
    expect(one.coord.current).toEqual({ state: 'elsewhere', fileId: 'aaa', other: 'two' });
  });

  it('Close closes a window a script may close, and goes Home in one it may not', () => {
    const w = world();
    const one = w.open('one');
    w.advance(HELLO_MS);
    one.coord.want('aaa');
    const two = w.open('two');
    two.coord.want('aaa');
    w.advance(HELLO_MS + 10);
    two.coord.dismiss();
    w.advance(200);
    expect(two.closed).toBe(false);
    expect(two.log).toContain('home');
  });

  it('when the other window closes, the waiting one takes the file', () => {
    const w = world();
    const one = w.open('one');
    w.advance(HELLO_MS);
    one.coord.want('aaa');
    const two = w.open('two');
    two.coord.want('aaa');
    w.advance(HELLO_MS + 10);
    one.coord.dispose();
    w.advance(10);
    expect(two.coord.current).toEqual({ state: 'mine', fileId: 'aaa' });
  });

  it('a window that went away without a word does not hold the file', () => {
    const w = world();
    const one = w.open('one');
    w.advance(HELLO_MS);
    one.coord.want('aaa');
    const two = w.open('two');
    w.advance(HELLO_MS + 10);
    // The first window crashed: it answers nothing any more.
    one.coord.dispose = () => {};
    (one.coord as unknown as { onMessage: () => void }).onMessage = () => {};
    two.coord.want('aaa');
    expect(two.coord.current).toEqual({ state: 'checking', fileId: 'aaa' });
    w.advance(WHO_MS + 10);
    expect(two.coord.current).toEqual({ state: 'mine', fileId: 'aaa' });
  });

  it('two windows that open the same file at once end with one editor', () => {
    const w = world();
    const one = w.open('one');
    const two = w.open('two');
    one.coord.want('aaa');
    two.coord.want('aaa');
    w.advance(HELLO_MS + 50);
    const states = [one.coord.current.state, two.coord.current.state].sort();
    expect(states).toEqual(['elsewhere', 'mine']);
  });

  it('different files in different windows, and switching files releases the old one', () => {
    const w = world();
    const one = w.open('one');
    const two = w.open('two');
    w.advance(HELLO_MS);
    one.coord.want('aaa');
    two.coord.want('bbb');
    w.advance(10);
    expect(one.coord.current.state).toBe('mine');
    expect(two.coord.current.state).toBe('mine');
    one.coord.want('ccc');
    w.advance(10);
    two.coord.want('aaa');
    w.advance(WHO_MS + 10);
    expect(two.coord.current).toEqual({ state: 'mine', fileId: 'aaa' });
    expect(one.coord.holds('ccc')).toBe(true);
    expect(two.coord.heldElsewhere('ccc')).toBe(true);
  });
});

describe('tabs with the same name', () => {
  it('tells them apart by folder, kept copy, then the start of the id', () => {
    const hints = tabHints([
      { id: '5ws7yeyyew', name: 'Catppuccin Custom · Omarchy theme', folder: 'Themes' },
      { id: 'ghe09ebii2', name: 'Catppuccin Custom · Omarchy theme', kept: true },
      { id: 'ghe0xxxxxx', name: 'catppuccin custom ·  omarchy theme ', kept: true },
      { id: 'p4h30ng0cf', name: 'App 01' },
    ]);
    const say = (id: string) => hintText(hints.get(id), 'kept copy');
    expect(say('5ws7yeyyew')).toBe('Themes');
    expect(say('ghe09ebii2')).toBe('kept copy · ghe09');
    expect(say('ghe0xxxxxx')).toBe('kept copy · ghe0x');
    expect(say('p4h30ng0cf')).toBe('');
  });

  it('two plain look-alikes get four characters of their ids, and untitled files count as one name', () => {
    const hints = tabHints([{ id: 'abcd1111', name: 'Pitch' }, { id: 'wxyz2222', name: 'Pitch' }, { id: 'u1', name: '' }, { id: 'u2', name: '' }], 'Untitled file');
    expect(hintText(hints.get('abcd1111'), 'kept copy')).toBe('abcd');
    expect(hintText(hints.get('wxyz2222'), 'kept copy')).toBe('wxyz');
    expect(hints.get('u1')?.id).toBe('u1');
  });
});
