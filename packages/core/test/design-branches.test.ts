import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BogenDoc, BranchConflictError, applyContent, branchChanged, branchContent, createComponent, createDesignBranch, currentBranchId, discardDesignBranch, docToContent, findMain,
  getDesignBranch, listDesignBranches, MAIN_BRANCH, mergeDesignBranch, previewMerge, restoreDesignBranch, switchDesignBranch, undoMerge, MAX_OPEN_BRANCHES,
  branchAssetNames, checkoutEpoch, checkoutSeenBy, divertStaleEdits, lostRemoteSets, markBranchArchived, MAX_DECIDED_KEPT,
} from '../src/index.ts';

/** A small theme-like file: palette tokens, a theme record in meta, an artboard with a component main. */
function themeDoc() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  doc.setToken('omarchy-accent', 'color', '#7aa2f7');
  doc.setToken('omarchy-background', 'color', '#1a1b26');
  doc.meta.set('omarchyTheme', { name: 'Tokyo Night Custom', format: 2, target: 'desktop', from: 'tokyo-night' });
  const board = doc.insert(page, { type: 'frame', tag: 'main', name: 'Background 1', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '400px', height: '200px' } });
  const wall = doc.insert(board, { type: 'frame', tag: 'div', name: 'Wallpaper', style: { width: '100%', height: '100%', backgroundColor: 'var(--omarchy-background)' }, children: [{ type: 'text', tag: 'span', name: 'Title', text: 'Night', style: {} }] });
  createComponent(doc, wall, { name: 'Wallpaper' });
  return { doc, page, board, wall };
}

const token = (doc: BogenDoc, name: string) => doc.getTokens().find((t) => t.name === name)?.value;
const theme = (doc: BogenDoc) => doc.meta.get('omarchyTheme') as { name: string };
const titleOf = (doc: BogenDoc, wall: string) => doc.getChildren(wall)[0]?.text;

describe('branches inside one file', () => {
  it('a branch holds its own tokens, theme record and components, and main stays as it was', () => {
    const { doc, wall } = themeDoc();
    const before = docToContent(doc);
    const { branch } = createDesignBranch(doc, { name: 'Warmer night', by: 'claude', checkout: true });
    expect(currentBranchId(doc)).toBe(branch.id);
    expect(branchChanged(doc, branch.id)).toBe(false);

    doc.setToken('omarchy-accent', 'color', '#ff9e64');
    doc.meta.set('omarchyTheme', { ...theme(doc), name: 'Tokyo Ember' });
    doc.updateFields(doc.getChildren(wall)[0]!.id, { text: 'Ember' });
    expect(branchChanged(doc, branch.id)).toBe(true);

    // Main, read while the branch is checked out, is exactly what it was.
    expect(branchContent(doc, MAIN_BRANCH)).toEqual(before);
    switchDesignBranch(doc, MAIN_BRANCH);
    expect(token(doc, 'omarchy-accent')).toBe('#7aa2f7');
    expect(theme(doc).name).toBe('Tokyo Night Custom');
    expect(titleOf(doc, wall)).toBe('Night');
    expect(findMain(doc.source, 'Wallpaper')?.id).toBe(wall);

    switchDesignBranch(doc, branch.id);
    expect(token(doc, 'omarchy-accent')).toBe('#ff9e64');
    expect(theme(doc).name).toBe('Tokyo Ember');
    expect(titleOf(doc, wall)).toBe('Ember');
  });

  it('two branches do not see each other, and none is a page or a file of its own', () => {
    const { doc, wall } = themeDoc();
    const pages = doc.getPages().length;
    const a = createDesignBranch(doc, { name: 'A', by: 'claude', checkout: true }).branch;
    doc.setToken('omarchy-accent', 'color', '#aaaaaa');
    const b = createDesignBranch(doc, { name: 'B', by: 'codex', from: MAIN_BRANCH, checkout: true }).branch;
    expect(token(doc, 'omarchy-accent')).toBe('#7aa2f7');
    doc.updateFields(doc.getChildren(wall)[0]!.id, { text: 'B title' });
    switchDesignBranch(doc, a.id);
    expect(token(doc, 'omarchy-accent')).toBe('#aaaaaa');
    expect(titleOf(doc, wall)).toBe('Night');
    expect(doc.getPages().length).toBe(pages);
    expect(listDesignBranches(doc).map((x) => x.name)).toEqual(['Main', 'A', 'B']);
    expect(getDesignBranch(doc, b.id).parent).toBe(MAIN_BRANCH);
  });

  it('asking for the same branch again returns it, without another one', () => {
    const { doc } = themeDoc();
    const first = createDesignBranch(doc, { name: 'Warmer night', by: 'claude' });
    const again = createDesignBranch(doc, { name: '  warmer   NIGHT ', by: 'codex' });
    expect(again.reused).toBe(true);
    expect(again.branch.id).toBe(first.branch.id);
    expect(listDesignBranches(doc)).toHaveLength(2);
  });

  it('caps open branches', () => {
    const { doc } = themeDoc();
    for (let i = 0; i < MAX_OPEN_BRANCHES; i++) createDesignBranch(doc, { name: `B${i}`, by: 'x' });
    expect(() => createDesignBranch(doc, { name: 'one more', by: 'x' })).toThrow(/open branches already/);
  });

  it('survives a reload and travels to another replica', () => {
    const { doc } = themeDoc();
    const { branch } = createDesignBranch(doc, { name: 'Warmer night', by: 'claude', checkout: true });
    doc.setToken('omarchy-accent', 'color', '#ff9e64');
    switchDesignBranch(doc, MAIN_BRANCH);
    const copy = new BogenDoc(new Y.Doc());
    Y.applyUpdate(copy.y, Y.encodeStateAsUpdate(doc.y));
    expect(listDesignBranches(copy).map((b) => b.name)).toEqual(['Main', 'Warmer night']);
    expect(token(copy, 'omarchy-accent')).toBe('#7aa2f7');
    switchDesignBranch(copy, branch.id);
    expect(token(copy, 'omarchy-accent')).toBe('#ff9e64');
  });

  it('a version of the file never carries the branches, and restoring one leaves them alone', () => {
    const { doc } = themeDoc();
    const snapshot = docToContent(doc);
    createDesignBranch(doc, { name: 'Warmer night', by: 'claude', checkout: true });
    doc.setToken('omarchy-accent', 'color', '#ff9e64');
    expect(JSON.stringify(docToContent(doc))).not.toContain('designBranches');
    applyContent(doc, snapshot);
    expect(listDesignBranches(doc)).toHaveLength(2);
  });
});

describe('merging is the person\'s choice', () => {
  it('takes what only the branch changed and keeps what only main changed', () => {
    const { doc, wall } = themeDoc();
    const { branch } = createDesignBranch(doc, { name: 'Warmer', by: 'claude', checkout: true });
    doc.setToken('omarchy-accent', 'color', '#ff9e64');
    switchDesignBranch(doc, MAIN_BRANCH);
    doc.updateFields(doc.getChildren(wall)[0]!.id, { text: 'Main title' });
    const preview = previewMerge(doc, branch.id);
    expect(preview.conflicts).toEqual([]);
    expect(preview.parentChanged).toBe(true);
    mergeDesignBranch(doc, branch.id, { by: 'person' });
    expect(currentBranchId(doc)).toBe(MAIN_BRANCH);
    expect(token(doc, 'omarchy-accent')).toBe('#ff9e64');
    expect(titleOf(doc, wall)).toBe('Main title');
    expect(getDesignBranch(doc, branch.id).status).toBe('merged');
  });

  it('stops on a conflict until the person picks a side, then can be taken back', () => {
    const { doc } = themeDoc();
    const { branch } = createDesignBranch(doc, { name: 'Warmer', by: 'claude', checkout: true });
    doc.setToken('omarchy-accent', 'color', '#ff9e64');
    doc.meta.set('omarchyTheme', { ...theme(doc), name: 'Tokyo Ember' });
    switchDesignBranch(doc, MAIN_BRANCH);
    doc.setToken('omarchy-accent', 'color', '#00ff00');
    const before = docToContent(doc);
    let error: unknown;
    try {
      mergeDesignBranch(doc, branch.id, { by: 'person' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BranchConflictError);
    expect((error as BranchConflictError).conflicts.map((c) => c.key)).toEqual(['token:omarchy-accent']);
    expect(docToContent(doc)).toEqual(before);

    mergeDesignBranch(doc, branch.id, { by: 'person', resolve: { 'token:omarchy-accent': 'branch' } });
    expect(token(doc, 'omarchy-accent')).toBe('#ff9e64');
    expect(theme(doc).name).toBe('Tokyo Ember');

    undoMerge(doc, branch.id);
    expect(token(doc, 'omarchy-accent')).toBe('#00ff00');
    expect(theme(doc).name).toBe('Tokyo Night Custom');
    expect(getDesignBranch(doc, branch.id).status).toBe('open');
    switchDesignBranch(doc, branch.id);
    expect(token(doc, 'omarchy-accent')).toBe('#ff9e64');
  });

  it('merges a checked-out branch and ends on its parent', () => {
    const { doc } = themeDoc();
    const { branch } = createDesignBranch(doc, { name: 'Warmer', by: 'claude', checkout: true });
    doc.setToken('omarchy-accent', 'color', '#ff9e64');
    mergeDesignBranch(doc, branch.id, { by: 'person' });
    expect(currentBranchId(doc)).toBe(MAIN_BRANCH);
    expect(token(doc, 'omarchy-accent')).toBe('#ff9e64');
  });

  it('a layer added inside something the other side removed is a conflict of its own', () => {
    const { doc, board, wall } = themeDoc();
    const { branch } = createDesignBranch(doc, { name: 'More', by: 'claude', checkout: true });
    const added = doc.insert(wall, { type: 'frame', tag: 'div', name: 'Moon', style: {} });
    switchDesignBranch(doc, MAIN_BRANCH);
    doc.delete([wall]);
    const { conflicts } = previewMerge(doc, branch.id);
    expect(conflicts.some((c) => c.key === `orphan:${added}`)).toBe(true);
    mergeDesignBranch(doc, branch.id, { by: 'person', resolve: { [`orphan:${added}`]: 'branch' } });
    expect(doc.getNode(added)?.name).toBe('Moon');
    expect(doc.getNode(wall)).toBeTruthy();
    expect(doc.pageOf(board)).toBeTruthy();
  });

  it('discarding sets a branch aside without touching main, and it can come back', () => {
    const { doc } = themeDoc();
    const { branch } = createDesignBranch(doc, { name: 'Try', by: 'claude', checkout: true });
    doc.setToken('omarchy-accent', 'color', '#123456');
    discardDesignBranch(doc, branch.id, 'person');
    expect(currentBranchId(doc)).toBe(MAIN_BRANCH);
    expect(token(doc, 'omarchy-accent')).toBe('#7aa2f7');
    restoreDesignBranch(doc, branch.id);
    switchDesignBranch(doc, branch.id);
    expect(token(doc, 'omarchy-accent')).toBe('#123456');
  });
});

describe('replicas that did not see a checkout', () => {
  /** A server copy and a phone copy of the same file, synced, as after the phone last connected. */
  function pair() {
    const made = themeDoc();
    const server = made.doc;
    const phone = new BogenDoc(new Y.Doc());
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(server.y));
    return { ...made, server, phone };
  }

  /** The server checks out Ember while the phone is away; the phone edits main meanwhile and comes back. */
  function awayWhileCheckedOut() {
    const made = pair();
    const { server, phone, wall } = made;
    const { branch } = createDesignBranch(server, { name: 'Ember', by: 'claude' });
    switchDesignBranch(server, branch.id);
    server.setToken('omarchy-accent', 'color', '#ff9e64');
    switchDesignBranch(server, MAIN_BRANCH);
    switchDesignBranch(server, branch.id);
    const ember = docToContent(server);
    phone.setToken('omarchy-accent', 'color', '#00ff00');
    phone.setToken('omarchy-shell', 'color', '#101010');
    phone.updateStyle(wall, { opacity: '0.5' });
    phone.updateFields(phone.getChildren(wall)[0]!.id, { text: 'Phone title' });
    return { ...made, ember, branch };
  }
  const comeBack = (server: BogenDoc, phone: BogenDoc) => {
    const update = Y.encodeStateAsUpdate(phone.y, Y.encodeStateVector(server.y));
    const seen = checkoutSeenBy(server, Y.decodeStateVector(Y.encodeStateVector(phone.y)));
    const before = docToContent(server);
    Y.applyUpdate(server.y, update, 'phone');
    const lost = lostRemoteSets(server, update);
    return { seen, lost, out: divertStaleEdits(server, before, docToContent(server), { known: seen.known, from: 'Phone', by: 'bogen', lost: lost.ops, unsafe: lost.unsafe }) };
  };

  it('edits made offline on main go to main, not into the branch checked out meanwhile', () => {
    const { server, phone, wall, ember, branch } = awayWhileCheckedOut();
    const { seen, lost, out } = comeBack(server, phone);
    expect(seen).toEqual({ stale: true, known: MAIN_BRANCH, latest: branch.id });
    expect(out).toMatchObject({ routed: true });
    expect(out!.branch.id).toBe(MAIN_BRANCH);
    // Live is exactly the branch the server checked out: no palette, style or text from the phone in it.
    expect(docToContent(server)).toEqual(ember);
    // Main has the phone's palette and style edits, the accent too although the checkout won that field's merge.
    const main = branchContent(server, MAIN_BRANCH);
    expect(main.tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#00ff00');
    expect(main.tokens.find((t) => t.name === 'omarchy-shell')?.value).toBe('#101010');
    expect(main.nodes.find((n) => n.id === wall)?.style.opacity).toBe('0.5');
    // Text typed while away either came through whole or is named as held back, never mixed in silently.
    const title = main.nodes.find((n) => n.parent === wall)!;
    if (lost.unsafe.includes(title.id)) expect(out!.held).toBeGreaterThan(0);
    else expect(title.text).toBe('Phone title');
    expect(listDesignBranches(server)).toHaveLength(2);
  });

  it('edits for a branch that is gone go to one recovery branch per replica, however many come', () => {
    const { server, phone, branch } = pair() as ReturnType<typeof pair> & { branch?: never };
    void branch;
    const a = createDesignBranch(server, { name: 'A', by: 'x', checkout: true }).branch;
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(server.y, Y.encodeStateVector(phone.y)));
    // The phone is on A and goes away; the server discards A.
    discardDesignBranch(server, a.id, 'person');
    createDesignBranch(server, { name: 'B', by: 'x', checkout: true });
    phone.setToken('omarchy-accent', 'color', '#111111');
    const first = comeBack(server, phone).out;
    expect(first).toMatchObject({ routed: false });
    phone.setToken('omarchy-background', 'color', '#222222');
    const second = comeBack(server, phone).out;
    expect(second?.branch.id).toBe(first!.branch.id);
    const recovered = branchContent(server, first!.branch.id);
    expect(recovered.tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#111111');
    expect(recovered.tokens.find((t) => t.name === 'omarchy-background')?.value).toBe('#222222');
    expect(listDesignBranches(server).filter((b) => b.recoveryOf)).toHaveLength(1);
  });

  it('a replica that saw the checkout is not held back', () => {
    const { server, phone } = pair();
    const { branch } = createDesignBranch(server, { name: 'Ember', by: 'claude', checkout: true });
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(server.y, Y.encodeStateVector(phone.y)));
    expect(checkoutSeenBy(server, Y.decodeStateVector(Y.encodeStateVector(phone.y)))).toEqual({ stale: false, known: branch.id, latest: branch.id });
  });

  it('a stamp changes on every checkout, also back to a branch seen before', () => {
    const { doc } = themeDoc();
    const first = checkoutEpoch(doc);
    const { branch } = createDesignBranch(doc, { name: 'B', by: 'x', checkout: true });
    const second = checkoutEpoch(doc);
    switchDesignBranch(doc, MAIN_BRANCH);
    switchDesignBranch(doc, branch.id);
    expect(new Set([first, second, checkoutEpoch(doc)]).size).toBe(3);
  });
});

describe('nothing unique is let go', () => {
  it('old decided branches keep their content unless History holds it', () => {
    const { doc } = themeDoc();
    const ids: string[] = [];
    for (let i = 0; i < MAX_DECIDED_KEPT + 3; i++) {
      const { branch } = createDesignBranch(doc, { name: `T${i}`, by: 'x', checkout: true });
      doc.setToken('omarchy-accent', 'color', `#0000${String(i).padStart(2, '0')}`);
      discardDesignBranch(doc, branch.id, 'person');
      ids.push(branch.id);
    }
    expect(ids.every((id) => !getDesignBranch(doc, id).pruned)).toBe(true);
    for (const id of ids) markBranchArchived(doc, id, `commit-${id}`);
    createDesignBranch(doc, { name: 'last', by: 'x', checkout: true });
    discardDesignBranch(doc, listDesignBranches(doc).at(-1)!.id, 'person');
    const pruned = ids.filter((id) => getDesignBranch(doc, id).pruned);
    expect(pruned.length).toBeGreaterThan(0);
    expect(pruned.every((id) => getDesignBranch(doc, id).archivedAs === `commit-${id}`)).toBe(true);
  });

  it('names the assets only an inactive branch uses', () => {
    const { doc, board } = themeDoc();
    const { branch } = createDesignBranch(doc, { name: 'Picture', by: 'x', checkout: true });
    const asset = `${'a'.repeat(64)}.png`;
    doc.insert(board, { type: 'image', tag: 'img', name: 'Moon', src: `bogen-asset:${asset}`, style: {} });
    switchDesignBranch(doc, MAIN_BRANCH);
    expect(branchAssetNames(doc)).toContain(asset);
    expect(getDesignBranch(doc, branch.id).status).toBe('open');
  });
});
