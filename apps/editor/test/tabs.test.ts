import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The tab list lives in the address and in localStorage; both are stand-ins here.
const storage = new Map<string, string>();
const loc = { hash: '#/' };
vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
vi.stubGlobal('location', loc);
vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} });

let tabs: typeof import('../src/tabs/tabs-state.ts');
let keys: typeof import('../src/tabs/tab-keys.ts');
let cache: typeof import('../src/doc/session-cache.ts');

/** The list as the module read it at start, from a list an older build stored with two spellings of one file. */
let startList: unknown;

beforeAll(async () => {
  storage.set('bogen-tabs', JSON.stringify([{ id: 'abc123', name: 'A' }, { id: 'ABC123', name: 'A' }, { id: 'def456', name: 'B', folder: 'Themes', kept: true }, { id: 'bad id', name: 'C' }]));
  tabs = await import('../src/tabs/tabs-state.ts');
  startList = tabs.useTabs.getState().tabs;
  keys = await import('../src/tabs/tab-keys.ts');
  cache = await import('../src/doc/session-cache.ts');
});

/** What the hash listener does in the app: the address says which tab is open. */
function visit(hash: string): void {
  loc.hash = hash;
  const id = tabs.fileOfHash(hash);
  if (id) tabs.ensureTab(id);
  tabs.useTabs.setState({ active: id });
}

const ids = () => tabs.useTabs.getState().tabs.map((t) => t.id);

beforeEach(() => {
  storage.clear();
  tabs.useTabs.setState({ tabs: [], active: null, marks: {} });
  loc.hash = '#/';
});

describe('file tabs', () => {
  it('opening a file adds its tab after the open one, once, and the list is kept', () => {
    visit('#/file/aaa');
    visit('#/file/bbb');
    visit('#/file/aaa');
    visit('#/file/ccc');
    expect(ids()).toEqual(['aaa', 'ccc', 'bbb']);
    expect(JSON.parse(storage.get('bogen-tabs')!).map((t: { id: string }) => t.id)).toEqual(['aaa', 'ccc', 'bbb']);
    // A full-screen preview is not a tab, and a stored list with junk in it is cleaned on reading.
    expect(tabs.fileOfHash('#/file/aaa/preview/x')).toBeNull();
    expect(tabs.fileOfHash('#/file/aaa?select=n1')).toBe('aaa');
  });

  it('every route into a file is one tab: query, thread, slash, capitals', () => {
    for (const h of ['#/file/abc123', '#/file/abc123?page=p1', '#/file/abc123?select=n1&page=p1', '#/file/abc123/thread/t1', '#/file/abc123/', '#/file/ABC123', '#/file/Abc123?layer=Title']) visit(h);
    expect(ids()).toEqual(['abc123']);
    expect(tabs.fileOfHash('#/file/abc123/preview')).toBeNull();
    expect(tabs.fileOfHash('#/file/abc.123')).toBeNull();
    expect(tabs.canonicalHash('#/file/ABC123?layer=Title')).toBe('#/file/abc123?layer=Title');
    expect(tabs.canonicalHash('#/file/abc123?layer=Title')).toBeNull();
    tabs.ensureTab('ABC123');
    expect(ids()).toEqual(['abc123']);
  });

  it('reads the stored list at start, one tab per file', () => {
    expect(startList).toEqual([{ id: 'abc123', name: 'A' }, { id: 'def456', name: 'B', folder: 'Themes', kept: true }]);
  });

  it('keeps the folder and kept copies of tabs, for names that look alike', async () => {
    tabs.setFileLookup(async () => [
      { id: 'aaa', name: 'Catppuccin', folder: 'Themes' },
      { id: 'bbb', name: 'Catppuccin', theme: { consolidatedInto: { fileId: 'aaa' } } },
    ]);
    visit('#/file/aaa');
    visit('#/file/bbb');
    await tabs.refreshTabNames();
    expect(tabs.useTabs.getState().tabs).toEqual([{ id: 'aaa', name: 'Catppuccin', folder: 'Themes' }, { id: 'bbb', name: 'Catppuccin', kept: true }]);
    tabs.setFileLookup(null);
  });

  it('closing the open tab goes right, then left, then Home', () => {
    for (const id of ['a1', 'b2', 'c3']) visit(`#/file/${id}`);
    visit('#/file/b2');
    tabs.closeTab('b2');
    expect(loc.hash).toBe('#/file/c3');
    visit(loc.hash);
    tabs.closeTab('c3');
    expect(loc.hash).toBe('#/file/a1');
    visit(loc.hash);
    tabs.closeTab('a1');
    expect(loc.hash).toBe('#/');
    expect(ids()).toEqual([]);
  });

  it('cycles round with Home first, picks by place, and moves the open tab', () => {
    for (const id of ['a1', 'b2', 'c3']) visit(`#/file/${id}`);
    visit('#/file/c3');
    tabs.cycleTab(1);
    expect(loc.hash).toBe('#/');
    visit('#/');
    tabs.cycleTab(-1);
    expect(loc.hash).toBe('#/file/c3');
    tabs.tabAt(1);
    expect(loc.hash).toBe('#/');
    tabs.tabAt(2);
    expect(loc.hash).toBe('#/file/a1');
    tabs.tabAt(9);
    expect(loc.hash).toBe('#/file/c3');
    visit('#/file/a1');
    tabs.nudgeActive(1);
    expect(ids()).toEqual(['b2', 'a1', 'c3']);
    tabs.moveTab('c3', 0);
    expect(ids()).toEqual(['c3', 'b2', 'a1']);
  });

  it('maps the tab keys, and leaves other keys to the editor', () => {
    visit('#/file/a1');
    const k = (key: string, more: Partial<KeyboardEvent> = {}) => keys.tabAction({ key, code: '', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...more });
    expect(k('Tab')).toBeTypeOf('function');
    expect(k('PageDown', { shiftKey: true })).toBeTypeOf('function');
    expect(k('3', { code: 'Digit3' })).toBeTypeOf('function');
    expect(k('w', { code: 'KeyW' })).toBeTypeOf('function');
    expect(k('z', { code: 'KeyZ' })).toBeNull();
    expect(k('0', { code: 'Digit0' })).toBeNull();
    expect(keys.tabAction({ key: 'Tab', code: 'Tab', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
    // On a Mac, Cmd+Tab is the app switcher: switching tabs is Ctrl+Tab there too, while Cmd+2 still picks a tab.
    expect(keys.tabAction({ key: 'Tab', code: 'Tab', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBeNull();
    expect(keys.tabAction({ key: 'PageDown', code: 'PageDown', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBeNull();
    expect(keys.tabAction({ key: '2', code: 'Digit2', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBeTypeOf('function');
    visit('#/');
    expect(k('w', { code: 'KeyW' })).toBeNull();
  });

  it('keeps a left tab awake for a while and puts the oldest to sleep first', () => {
    const made: { fileId: string; destroyed: boolean }[] = [];
    const fake = (fileId: string) => {
      const s = { fileId, destroyed: false, destroy() { this.destroyed = true; }, provider: { awareness: { setLocalState: () => {} } } };
      made.push(s);
      return s as unknown as import('../src/doc/session.ts').Session;
    };
    cache.sleepPolicy.keep = 2;
    const a = fake('a');
    const b = fake('b');
    const c = fake('c');
    cache.releaseSession(a, true);
    cache.releaseSession(b, true);
    expect(cache.parkedFiles().sort()).toEqual(['a', 'b']);
    cache.releaseSession(c, true);
    expect(cache.parkedFiles().sort()).toEqual(['b', 'c']);
    expect((a as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(cache.acquireSession('b')).toBe(b);
    expect(cache.parkedFiles()).toEqual(['c']);
    // A closed tab lets its session go at once.
    const d = fake('d');
    cache.releaseSession(d, false);
    expect((d as unknown as { destroyed: boolean }).destroyed).toBe(true);
    cache.sleepAll();
    expect(cache.parkedFiles()).toEqual([]);
    expect((c as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('names a tab that is opened after the names were fetched', async () => {
    const files = [{ id: 'aaa', name: 'Home page' }];
    tabs.setFileLookup(async () => files);
    visit('#/file/aaa');
    await tabs.refreshTabNames();
    // The call moves to a file the window has not seen yet: its tab must not stay "Untitled file".
    files.push({ id: 'ccc', name: 'Sprechstunde' });
    visit('#/file/ccc');
    await new Promise((r) => setTimeout(r, 80));
    expect(tabs.useTabs.getState().tabs).toEqual([{ id: 'aaa', name: 'Home page' }, { id: 'ccc', name: 'Sprechstunde' }]);
    tabs.setFileLookup(null);
  });
});
