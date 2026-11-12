import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../src/lib/api.ts';
import { askTargets, phoneFiles } from '../src/phone/phone-files.ts';

const theme = (into?: string) => ({ name: 'Tokyo Night Custom', target: 'desktop', ...(into ? { consolidatedInto: { fileId: into, branchId: `b-${into}`, at: 1, changed: false } } : {}) }) as unknown as FileEntry['theme'];
const at = (h: number) => new Date(Date.UTC(2026, 10, 6, h)).toISOString();

// One canonical theme project, three source copies kept inside it, a file of its own, and a draft whose project is gone.
const project: FileEntry = { id: 'project', name: 'Tokyo Night Custom', updatedAt: at(9), theme: theme() };
const sourceA: FileEntry = { id: 'source-a', name: 'Tokyo Night Custom · Omarchy theme', updatedAt: at(8), theme: theme('project') };
const sourceB: FileEntry = { id: 'source-b', name: 'Tokyo Night Custom · Omarchy theme', updatedAt: at(7), theme: theme('project') };
const sourceC: FileEntry = { id: 'source-c', name: 'Tokyo Night Custom · Omarchy theme', updatedAt: at(6), theme: theme('project') };
const ordinary: FileEntry = { id: 'ordinary', name: 'Pricing page', updatedAt: at(10) };
const draft: FileEntry = { id: 'draft', name: 'Ember mobile', updatedAt: at(5), theme: theme('deleted-project') };
const list = [sourceA, ordinary, sourceB, project, draft, sourceC];

const ids = (files: readonly FileEntry[]) => files.map((f) => f.id);

describe('the files the phone lists, after theme copies were brought together', () => {
  it('lists the canonical project once, not its kept sources, with files and drafts of their own, newest first', () => {
    const shown = phoneFiles(list, new Map());
    expect(ids(shown)).toEqual(['ordinary', 'project', 'draft']);
    // The project knows its copies, as on Home.
    expect(ids((shown.find((f) => f.id === 'project') as FileEntry).keptCopies ?? [])).toEqual(['source-a', 'source-b', 'source-c']);
  });

  it('keeps a source copy listed while this phone keeps it offline or has edits of it waiting', () => {
    const stored = new Map([
      ['source-a', { kept: true, queued: 0 }],
      ['source-b', { kept: false, queued: 3 }],
      // Opened once and not kept, nothing waiting: it goes with its project.
      ['source-c', { kept: false, queued: 0 }],
      ['ordinary', { kept: true }],
    ]);
    expect(ids(phoneFiles(list, stored))).toEqual(['ordinary', 'project', 'source-a', 'source-b', 'draft']);
  });

  it('offline, from the list kept on the phone: the same rule, nothing that is only here is hidden', () => {
    const cached = JSON.parse(JSON.stringify(list)) as FileEntry[];
    expect(ids(phoneFiles(cached, new Map([['source-c', { kept: true, queued: 1 }]])))).toEqual(['ordinary', 'project', 'source-c', 'draft']);
  });

  it('a list without the project (not synced yet) shows its copies as files, as Home does', () => {
    expect(ids(phoneFiles([sourceA, sourceB, ordinary], new Map()))).toEqual(['ordinary', 'source-a', 'source-b']);
  });
});

describe('the files an agent can be asked about from the phone', () => {
  it('offers the canonical project and other files, never a kept source as a new target', () => {
    expect(ids(askTargets(list, null))).toEqual(['ordinary', 'project', 'draft']);
    expect(askTargets(list, null)[0]?.id).toBe('ordinary');
  });

  it('keeps the file already asked about in the picker, even a kept source', () => {
    expect(ids(askTargets(list, 'source-b'))).toEqual(['ordinary', 'project', 'source-b', 'draft']);
    expect(ids(askTargets(list, 'project'))).toEqual(['ordinary', 'project', 'draft']);
    expect(ids(askTargets(list, 'no-such-file'))).toEqual(['ordinary', 'project', 'draft']);
  });
});
