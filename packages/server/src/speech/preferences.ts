import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mergePreference, type CallPreference, type CallPreferenceKind, type StoredCallPreference } from '@bogen/core';
import { atomicWrite, errorMessage } from '../util.ts';

/**
 * What the person asked of the call's voice for good ("sprich kürzer", "nenn mich Sam", "ab jetzt auf Englisch"),
 * in `$BOGEN_HOME/call-preferences.json`, readable only by this user. Every later call reads it; the person sees and
 * deletes the entries in the call's settings. Nothing else is kept here: no audio and no other words of the call.
 */
export class CallPreferences {
  private items: StoredCallPreference[] | null = null;
  private write: Promise<void> = Promise.resolve();
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, 'call-preferences.json');
  }

  async list(): Promise<StoredCallPreference[]> {
    if (this.items) return this.items;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { items?: unknown };
      this.items = Array.isArray(parsed.items) ? parsed.items.flatMap((x) => clean(x)) : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: the call preferences were unreadable: ${errorMessage(e)}`);
      this.items = [];
    }
    return this.items;
  }

  /** Keeps a preference; a new length, name or language replaces the old one of its kind. */
  async add(p: CallPreference): Promise<StoredCallPreference[]> {
    const next: StoredCallPreference = { id: randomBytes(5).toString('hex'), at: Date.now(), kind: p.kind, value: p.value.slice(0, 60), text: p.text.slice(0, 200) };
    this.items = mergePreference(await this.list(), next);
    await this.save();
    return this.items;
  }

  /** Forgets one, or all when no id is given. */
  async remove(id?: string): Promise<StoredCallPreference[]> {
    this.items = id ? (await this.list()).filter((p) => p.id !== id) : [];
    await this.save();
    return this.items;
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ items: this.items ?? [] }, null, 2);
    this.write = this.write.catch(() => undefined).then(() => atomicWrite(this.path, body, 0o600));
    return this.write;
  }
}

const KINDS: CallPreferenceKind[] = ['length', 'name', 'language', 'quiet', 'other'];

/** One preference as sent or as read back from the file, held to its kinds and sizes; anything else is dropped. */
export function clean(raw: unknown): StoredCallPreference[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const kind = KINDS.find((k) => k === o.kind);
  const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const value = typeof o.value === 'string' ? o.value.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (!kind || !text) return [];
  if (kind === 'length' && value !== 'short' && value !== 'long') return [];
  if (kind === 'language' && value !== 'de' && value !== 'en') return [];
  if (kind === 'name' && !/^[\p{L}][\p{L}' -]{0,39}$/u.test(value)) return [];
  return [{ id: typeof o.id === 'string' && /^[0-9a-f]{6,20}$/.test(o.id) ? o.id : randomBytes(5).toString('hex'), at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now(), kind, value: kind === 'other' || kind === 'quiet' ? '' : value, text }];
}
