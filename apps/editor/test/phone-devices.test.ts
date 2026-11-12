import { describe, expect, it } from 'vitest';
import { queueOf } from '../src/doc/offline.ts';
import { orderWords } from '../src/panels/PeerDeploy.tsx';
import { fitWithin, keepsOriginal, photoWords, PHOTO_MAX_SIDE } from '../src/phone/photo.ts';
import { agoWords, fileSyncLine, noteWords, queueLine, rowSyncWords } from '../src/phone/sync-words.ts';
import { noticeRoute, pushNotice } from '../src/pwa/sw-rules.ts';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

describe('what the phone says about sync', () => {
  it('says what waits and when it was last in sync, only when it is not', () => {
    const base = { live: false, sending: false, queued: 0, syncedAt: NOW - 12 * 60_000, host: 'omarchy' };
    expect(fileSyncLine({ ...base, live: true }, NOW)).toBeNull();
    expect(fileSyncLine({ ...base, queued: 3 }, NOW)).toBe('Offline. 3 changes wait for omarchy. Last synced 12 min ago.');
    expect(fileSyncLine({ ...base, queued: 1 }, NOW)).toBe('Offline. 1 change waits for omarchy. Last synced 12 min ago.');
    expect(fileSyncLine(base, NOW)).toBe('Offline. Edits stay on this phone until omarchy is back. Last synced 12 min ago.');
    expect(fileSyncLine({ ...base, syncedAt: null }, NOW)).toBe('Offline. Edits stay on this phone until omarchy is back. Not synced with omarchy on this phone yet.');
    expect(fileSyncLine({ ...base, sending: true, queued: 2 }, NOW)).toBe('Sending 2 changes to omarchy.');
  });

  it('puts the last sync and the queue on a row of the file list', () => {
    expect(rowSyncWords(undefined, NOW)).toBe('');
    expect(rowSyncWords({ syncedAt: NOW - 30_000 }, NOW)).toBe('synced just now');
    expect(rowSyncWords({ syncedAt: NOW - 3 * 3600_000, queued: 2 }, NOW)).toBe('2 changes waiting');
    expect(rowSyncWords({ syncedAt: NOW - 3 * 3600_000, notes: 1 }, NOW)).toBe('synced 3 h ago · 1 conflict');
    expect(agoWords(NOW - 30 * 3600_000, NOW)).toBe('yesterday');
  });

  it('counts the queue across files', () => {
    const q = queueOf([{ id: 'a', name: 'A', kept: false, openedAt: 0, assets: [], queued: 2 }, { id: 'b', name: 'B', kept: true, openedAt: 0, assets: [] }, { id: 'c', name: 'C', kept: false, openedAt: 0, assets: [], queued: 1 }]);
    expect(q).toEqual({ changes: 3, files: 2 });
    expect(queueLine(q, 'omarchy', false)).toBe('3 changes in 2 files wait for omarchy.');
    expect(queueLine(q, 'omarchy', true)).toBe('Sending 3 changes in 2 files to omarchy.');
    expect(queueLine({ changes: 0, files: 0 }, 'omarchy', false)).toBeNull();
  });

  it('tells a conflict note from the phone side', () => {
    const note = { device: 'iPhone', kept: 'ours' as const, ours: '#0000ff', theirs: '#ff0000' };
    expect(noteWords(note, 'omarchy', 'iPhone')).toEqual({ here: 'omarchy: #0000ff', there: 'This phone: #ff0000', kept: 'Kept the one from omarchy.', otherLabel: 'Use mine' });
    expect(noteWords({ ...note, kept: 'theirs' }, 'omarchy', 'iPhone')).toMatchObject({ kept: 'Kept the one from this phone.', otherLabel: "Use omarchy's" });
    expect(noteWords({ ...note, device: 'MacBook' }, 'omarchy', 'iPhone')).toMatchObject({ there: 'MacBook: #ff0000', otherLabel: "Use MacBook's" });
  });
});

describe('photos from the phone', () => {
  it('scale to 2048 on the long side, never up', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: PHOTO_MAX_SIDE, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: PHOTO_MAX_SIDE });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 10)).toEqual({ width: 2048, height: 2 });
  });

  it('go as they are only when small enough and of a kind with no camera data', () => {
    expect(keepsOriginal('image/png', 500_000, 1200, 800)).toBe(true);
    expect(keepsOriginal('image/png', 500_000, 4000, 800)).toBe(false);
    expect(keepsOriginal('image/png', 9_000_000, 1200, 800)).toBe(false);
    // A JPEG carries where it was taken: it is always drawn again, which leaves that behind.
    expect(keepsOriginal('image/jpeg', 200_000, 1200, 800)).toBe(false);
    expect(keepsOriginal('image/heic', 2_000_000, 4032, 3024)).toBe(false);
    expect(photoWords({ width: 2048, height: 1536, bytes: 655_360 })).toBe('2048 × 1536, 640 KB');
    expect(photoWords({ width: 2048, height: 1536, bytes: 2_621_440 })).toBe('2048 × 1536, 2.5 MB');
  });
});

describe('a push message on the phone', () => {
  it('shows plain words and opens a route of the app, whatever arrives', () => {
    expect(pushNotice(JSON.stringify({ title: 'Claude finished', body: 'Landing', url: '#/file/abc', tag: 'bogen-run-abc' }))).toEqual({ title: 'Claude finished', body: 'Landing', url: '#/file/abc', tag: 'bogen-run-abc' });
    expect(pushNotice('not json')).toMatchObject({ title: 'Bogen', url: '#/' });
    expect(pushNotice(null).title).toBe('Bogen');
    expect(pushNotice(JSON.stringify({ title: 'x', url: 'https://evil.example/', tag: 'a b' }))).toMatchObject({ url: '#/', tag: 'bogen' });
    expect(pushNotice(JSON.stringify({ title: 'x', url: 'javascript:alert(1)' })).url).toBe('#/');
    expect(pushNotice(JSON.stringify({ title: 'a'.repeat(500) })).title).toHaveLength(120);
    expect(noticeRoute({ url: '#/review/f1/p1' })).toBe('#/review/f1/p1');
    expect(noticeRoute({ url: '//evil.example' })).toBe('#/');
    expect(noticeRoute(null)).toBe('#/');
  });
});

describe('updating the other device', () => {
  it('says which build is newer in words', () => {
    expect(orderWords('newer', 'MacBook')).toMatch(/newer\. Updating brings MacBook up to it/);
    expect(orderWords('older', 'MacBook')).toMatch(/MacBook has the newer build/);
    expect(orderWords('unknown', 'MacBook')).toMatch(/cannot be told/);
  });
});
