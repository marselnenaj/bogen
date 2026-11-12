import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyBrandTokens } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import { writeBoards } from './templates/index.ts';
import { bogenBrandData, WELCOME_NAME, welcomePlan } from './templates/welcome.ts';
import { atomicWrite } from './util.ts';

/** What the data folder remembers about the welcome file: that it was offered, and which file it is. */
interface WelcomeState {
  /** The file made, or null when the data folder already had files on the first start of a build that has this. */
  fileId: string | null;
  at: number;
}

const ORIGIN = 'bogen:welcome';

/**
 * The "Welcome to Bogen" file. It is made once, on the first start of a data folder with no files, and never again
 * by itself: a person who deleted it does not get it back. `bogen welcome` and Help, Welcome to Bogen, open it, and
 * make a new one only when it is gone.
 */
export class Welcome {
  private state: WelcomeState | null = null;
  private loaded = false;

  constructor(private readonly app: BogenServer) {}

  private get path(): string {
    return join(this.app.options.home, 'welcome.json');
  }

  private async load(): Promise<WelcomeState | null> {
    if (this.loaded) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<WelcomeState>;
      this.state = { fileId: typeof parsed.fileId === 'string' ? parsed.fileId : null, at: Number(parsed.at) || 0 };
    } catch {
      this.state = null;
    }
    this.loaded = true;
    return this.state;
  }

  private async save(fileId: string | null): Promise<void> {
    this.state = { fileId, at: Date.now() };
    await atomicWrite(this.path, JSON.stringify(this.state));
  }

  /** On start. A data folder that has files already, from before this build, is left as it is. */
  async firstRun(): Promise<string | null> {
    if (await this.load()) return null;
    if (this.app.storage.list().length) {
      await this.save(null);
      return null;
    }
    const id = await this.make();
    await this.save(id);
    return id;
  }

  /** The welcome file, made again only if it is not there. */
  async open(): Promise<{ id: string; created: boolean }> {
    const state = await this.load();
    if (state?.fileId && this.app.storage.get(state.fileId)) return { id: state.fileId, created: false };
    const id = await this.make();
    await this.save(id);
    return { id, created: true };
  }

  /** Draws the file from the Bogen brand, with that brand's colours and type as its tokens. It links to no brand. */
  private async make(): Promise<string> {
    const entry = this.app.createFile(WELCOME_NAME);
    const room = await this.app.rooms.get(entry.id);
    const { doc } = room;
    doc.transact(() => {
      applyBrandTokens(doc, bogenBrandData());
      const plan = welcomePlan({ tokens: new Set(doc.getTokens().map((t) => t.name)), components: new Set(), version: null, date: new Date() });
      const page = doc.getPages()[0]!;
      doc.renamePage(page.id, plan.page);
      writeBoards(doc, page.id, plan.boards);
    }, ORIGIN);
    this.app.hub.broadcast({ t: 'files' });
    return entry.id;
  }
}
