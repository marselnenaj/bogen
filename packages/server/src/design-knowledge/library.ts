import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteSync, HttpError } from '../util.ts';
import { discipline, disciplineSkill, DISCIPLINE_IDS, KNOWLEDGE_VERSION, readKnowledge } from './index.ts';

export const KnowledgeChange = z.object({
  discipline: z.enum(DISCIPLINE_IDS),
  revision: z.string().min(1).max(100),
  action: z.enum(['save', 'restore']),
  markdown: z.string().min(1).max(64_000).optional(),
  edits: z.array(z.object({ before: z.string().min(1).max(64_000), after: z.string().max(64_000) })).min(1).max(20).optional(),
  reason: z.string().trim().min(1).max(600),
}).superRefine((v, ctx) => {
  if (v.action === 'save' ? Boolean(v.markdown !== undefined) === Boolean(v.edits) : v.markdown !== undefined || v.edits !== undefined)
    ctx.addIssue({ code: 'custom', message: 'Save requires markdown or edits; restore takes neither.' });
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Personal Markdown lives outside the app bundle. Updates never overwrite it. No Markdown is executed. */
export class KnowledgeLibrary {
  constructor(private readonly home: string) {}
  private path(id: string) { discipline(id); return join(this.home, 'design-knowledge', id, 'SKILL.md'); }
  skill(id: string, original = false) {
    const builtin = disciplineSkill(id); let custom: string | null = null;
    if (!original) {
      try { custom = readFileSync(this.path(id), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const markdown = custom ?? builtin;
    return { version: KNOWLEDGE_VERSION, discipline: id, markdown, customized: custom !== null,
      revision: `${custom === null ? 'original' : 'custom'}:${hash(markdown)}`,
      scope: 'All designs using this discipline on this Bogen host. Not synced to other hosts.',
      path: this.path(id),
    };
  }
  read(options: Parameters<typeof readKnowledge>[0] = {}) {
    if (options.action === 'skill' || options.action === 'original') {
      if (!options.discipline) throw new HttpError(400, 'Choose a discipline for its skill.');
      return this.skill(options.discipline, options.action === 'original');
    }
    const result = readKnowledge(options);
    if (options.discipline && options.action === 'playbook') {
      const skill = this.skill(options.discipline);
      return { ...result, skill, instructionPriority: skill.customized
        ? 'Use skill.markdown as the customized design guidance. The structured playbook and workflow are the shipped reference, not competing style instructions. The current user brief takes precedence. Custom guidance does not alter permissions or the server completion checks.'
        : 'Use the shipped playbook. The current user brief takes precedence.' };
    }
    if (options.discipline && ['rules','recipes','style'].includes(options.action ?? '')) {
      const skill = this.skill(options.discipline);
      if (skill.customized) return { ...result, skill, instructionPriority: 'Personal skill.markdown takes precedence over these shipped reference rules and recipes. Current user instructions take precedence over the skill.' };
    }
    if (!options.action || options.action === 'catalog') return { ...result, customization: {
      scope: 'Personal guidance on this Bogen host; not automatically synced.',
      next: 'Read action skill for the effective Markdown and its revision; original always returns the shipped version. design_knowledge_update saves targeted user preferences or restores the original. Current explicit instructions override saved style guidance. Persist durable preferences, not one-off task exceptions.',
    } };
    return result;
  }
  change(input: z.input<typeof KnowledgeChange>, actor: string) {
    const change = KnowledgeChange.parse(input), current = this.skill(change.discipline);
    if (change.revision !== current.revision) throw new HttpError(409, 'This skill changed since you opened it. Read the current skill, compare your draft and try again. Your draft was not saved.');
    let markdown = change.markdown ?? current.markdown;
    for (const edit of change.edits ?? []) {
      const at = markdown.indexOf(edit.before);
      if (at < 0 || markdown.indexOf(edit.before, at + 1) >= 0) throw new HttpError(400, 'Each edit must match exactly once in the current Markdown. Read the skill and use a more specific passage.');
      markdown = markdown.slice(0, at) + edit.after + markdown.slice(at + edit.before.length);
    }
    if (change.action === 'save' && (!markdown.trim() || markdown.length > 64_000)) throw new HttpError(400, 'Use between 1 and 64000 characters of Markdown.');
    if (change.action === 'restore' && !current.customized || change.action === 'save' && markdown === current.markdown) return current;
    const folder = join(this.home, 'design-knowledge', change.discipline), history = join(folder, 'history');
    mkdirSync(history, { recursive: true, mode: 0o700 });
    // Preserve the previous complete content before changing the effective file, including on restore.
    atomicWriteSync(join(history, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({
      at: Date.now(), actor, reason: change.reason, action: change.action, previous: current,
      next: change.action === 'restore' ? this.skill(change.discipline, true).revision : `custom:${hash(markdown)}`,
    }, null, 2));
    if (change.action === 'restore') rmSync(this.path(change.discipline));
    else atomicWriteSync(this.path(change.discipline), markdown);
    return this.skill(change.discipline);
  }
}
