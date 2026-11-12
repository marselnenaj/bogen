import { describe, expect, it } from 'vitest';
import { BogenDoc, createDesignBranch, switchDesignBranch, Y } from '@bogen/core';
import { chooseAll, hasBranches, keepChoices, resolvePayload, unresolved, type BranchConflict } from '../src/lib/design-branches-api.ts';
import { clearUndoOnCheckout, localBranch, onBranchRecords } from '../src/doc/branch-watch.ts';

const conflict = (key: string): BranchConflict => ({ key, kind: 'token', label: key, primary: 'changed', branch: 'changed' });

describe('the answers to a merge', () => {
  const conflicts = [conflict('token:--bg'), conflict('node:a'), conflict('meta:theme')];

  it('send nothing without conflicts', () => {
    expect(resolvePayload([], {})).toBeUndefined();
  });

  it('wait while a conflict has no answer', () => {
    expect(resolvePayload(conflicts, { 'token:--bg': 'branch' })).toBeNull();
    expect(unresolved(conflicts, { 'token:--bg': 'branch' }).map((c) => c.key)).toEqual(['node:a', 'meta:theme']);
  });

  it('send one side when every answer is that side', () => {
    expect(resolvePayload(conflicts, chooseAll(conflicts, 'branch'))).toBe('branch');
    expect(resolvePayload(conflicts, chooseAll(conflicts, 'primary'))).toBe('primary');
  });

  it('send the answer per conflict when they differ, and only for conflicts that are there', () => {
    const choices = { ...chooseAll(conflicts, 'primary'), 'node:a': 'branch' as const, 'gone:x': 'branch' as const };
    expect(resolvePayload(conflicts, choices)).toEqual({ 'token:--bg': 'primary', 'node:a': 'branch', 'meta:theme': 'primary' });
  });

  it('keep the answers that still apply when the conflicts change', () => {
    const next = [conflict('node:a'), conflict('token:--fg')];
    const kept = keepChoices(next, { 'token:--bg': 'branch', 'node:a': 'primary' });
    expect(kept).toEqual({ 'node:a': 'primary' });
    expect(resolvePayload(next, kept)).toBeNull();
  });

  it('show a branch by name only when there is one besides main', () => {
    const main = { id: 'main', name: 'Main', parent: null, status: 'open' as const, current: true, changed: false, by: 'person', at: null };
    expect(hasBranches(null)).toBe(false);
    expect(hasBranches({ current: 'main', branches: [main], decided: [] })).toBe(false);
    expect(hasBranches({ current: 'main', branches: [main, { ...main, id: 'b1', name: 'Warmer', parent: 'main', current: false }], decided: [] })).toBe(true);
  });
});

describe('the local undo stack and the checkout', () => {
  const LOCAL = 'bogen-editor';

  function setup() {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const undo = new Y.UndoManager([doc.nodes, doc.pages, doc.tokens, doc.meta], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    const stop = clearUndoOnCheckout(doc.y, undo);
    const edit = () => doc.transact(() => doc.meta.set('note', Math.random()), LOCAL);
    return { doc, undo, stop, edit };
  }

  it('empties when another branch is checked out, from anywhere', () => {
    const { doc, undo, edit } = setup();
    edit();
    expect(undo.canUndo()).toBe(true);
    // As the server does it: not this editor's origin.
    createDesignBranch(doc, { name: 'Warmer night', by: 'agent', checkout: true }, 'remote');
    expect(undo.canUndo()).toBe(false);
    expect(localBranch(doc.y)).toMatchObject({ name: 'Warmer night', open: 1 });
    edit();
    expect(undo.canUndo()).toBe(true);
    switchDesignBranch(doc, 'main', 'remote');
    expect(undo.canUndo()).toBe(false);
    expect(localBranch(doc.y)).toMatchObject({ current: 'main', name: null, open: 1 });
  });

  it('empties when a replica from elsewhere moves the checkout', () => {
    const { doc, undo, edit } = setup();
    const other = new BogenDoc();
    other.ensureFirstPage();
    Y.applyUpdate(other.y, Y.encodeStateAsUpdate(doc.y));
    edit();
    createDesignBranch(other, { name: 'Elsewhere', by: 'peer', checkout: true });
    Y.applyUpdate(doc.y, Y.encodeStateAsUpdate(other.y, Y.encodeStateVector(doc.y)), 'sync');
    expect(undo.canUndo()).toBe(false);
  });

  it('stays for edits that do not move the checkout, and stops watching when told', () => {
    const { doc, undo, stop, edit } = setup();
    edit();
    doc.transact(() => doc.meta.set('other', 1), 'remote');
    expect(undo.canUndo()).toBe(true);
    stop();
    createDesignBranch(doc, { name: 'Later', by: 'agent', checkout: true }, 'remote');
    expect(undo.canUndo()).toBe(true);
  });

  it('tells about branch records, not about anything else', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    let n = 0;
    const off = onBranchRecords(doc.y, () => n++);
    doc.meta.set('x', 1);
    expect(n).toBe(0);
    createDesignBranch(doc, { name: 'One', by: 'agent', checkout: false });
    expect(n).toBeGreaterThan(0);
    off();
  });

  it('reads a file without branches as main', () => {
    expect(localBranch(new Y.Doc())).toEqual({ current: 'main', name: null, open: 0, decided: 0 });
  });
});
