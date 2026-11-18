import { describe, expect, it } from 'vitest';
import { pickWindow } from '../src/cli-open.ts';
import type { BogenEvent } from '../src/events.ts';
import { OpenBroker } from '../src/http/open-routes.ts';

describe('bogen open asks the windows first', () => {
  const broker = (windows: number) => {
    const sent: BogenEvent[] = [];
    const b = new OpenBroker((e) => { sent.push(e); return windows; }, { claimMs: 40, doneMs: 80 });
    const id = () => (sent.at(-1) as { id: string }).id;
    return { b, sent, id };
  };

  it('nothing takes it when no window on this machine listens', async () => {
    const { b } = broker(0);
    expect(await b.request('#/file/abc')).toEqual({ taken: false });
  });

  it('the window that shows the file takes it at once, over one in view', async () => {
    const { b, id, sent } = broker(2);
    const asked = b.request('#/file/abc?layer=Title');
    expect(sent[0]).toMatchObject({ t: 'open-request', hash: '#/file/abc?layer=Title', raise: false });
    const inView = b.claim(id(), 1, Date.now());
    const showing = b.claim(id(), 2, 0);
    expect(await showing).toBe(true);
    expect(await inView).toBe(false);
    expect(b.done(id(), { focused: false, visible: true, title: 'Pitch - Bogen' })).toBe(true);
    expect(await asked).toEqual({ taken: true, focused: false, visible: true, title: 'Pitch - Bogen' });
  });

  it('without one that shows it, the window in view that had focus last', async () => {
    const { b, id } = broker(2);
    const asked = b.request('#/file/abc');
    const older = b.claim(id(), 1, 100);
    const newer = b.claim(id(), 1, 200);
    expect([await older, await newer]).toEqual([false, true]);
    b.done(id(), { focused: true, visible: true });
    expect((await asked).taken).toBe(true);
  });

  it('a chosen window that never says it took it is no window', async () => {
    const { b, id } = broker(1);
    const asked = b.request('');
    expect(await b.claim(id(), 1, 1)).toBe(true);
    expect(await asked).toEqual({ taken: false });
    expect(b.done(id(), { focused: true, visible: true })).toBe(false);
  });

  it('raises the window by its title on Hyprland, or the only Bogen web app window', () => {
    const clients = [
      { address: '0x1', title: 'Pitch - Bogen', class: 'chrome-127.0.0.1__-Default' },
      { address: '0x2', title: 'Home - Bogen - Chromium', class: 'chromium' },
      { address: '0x3', title: 'kitty', class: 'kitty' },
    ];
    expect(pickWindow(clients, 'Pitch - Bogen')?.address).toBe('0x1');
    expect(pickWindow(clients, 'Home - Bogen')?.address).toBe('0x2');
    expect(pickWindow(clients, 'Nothing')?.address).toBe('0x1');
    expect(pickWindow([...clients, { address: '0x4', title: 'Pitch - Bogen', class: 'chrome-127.0.0.1__-Default' }], 'Pitch - Bogen')).toBeNull();
  });
});
