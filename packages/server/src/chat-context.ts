import { brandLinkOf, proposalDecision, type BogenDoc, type BogenNode } from '@bogen/core';
import type { RunMention } from './agents.ts';
import { DESIGN_DISCIPLINES } from './design-knowledge/index.ts';
import type { BogenServer } from './http/server.ts';
import { DecisionMemory } from './memory.ts';
import { HttpError } from './util.ts';

/**
 * What the chat adds to a message besides its words: skills chosen with `/`, layers, components and tokens
 * mentioned with `@` (checked against the file, so a run gets ids that exist), and a draft of a skill made from the
 * decisions on a refined artboard, which the person reviews and saves themselves.
 */

const MAX_TEXT = 60;

/** The mentions that exist in the file, with what they are. Unknown ones are left out. */
export function resolveMentions(doc: BogenDoc, asked: { kind: RunMention['kind']; id: string }[]): RunMention[] {
  const out: RunMention[] = [];
  const seen = new Set<string>();
  for (const m of asked) {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.kind === 'token') {
      const name = m.id.replace(/^--/, '');
      const token = doc.getTokens().find((t) => t.name === name);
      if (token) out.push({ kind: 'token', id: token.name, name: `--${token.name}`, detail: `${token.kind} ${token.value}` });
      continue;
    }
    const node = doc.getNode(m.id);
    if (!node) continue;
    if (m.kind === 'component' && !node.component) continue;
    out.push({ kind: m.kind, id: node.id, name: node.name, detail: describe(doc, node, m.kind) });
  }
  return out;
}

function describe(doc: BogenDoc, node: BogenNode, kind: RunMention['kind']): string {
  const where = doc.pageOf(node.id);
  const page = where ? doc.getPages().find((p) => p.id === where)?.name : undefined;
  const text = node.type === 'text' && node.text ? ` "${node.text.replace(/\s+/g, ' ').slice(0, MAX_TEXT)}"` : '';
  const what = kind === 'component' ? `component${node.component?.set ? ` in the set "${node.component.set}"` : ''}` : `${node.type} <${node.tag}>${text}${node.artboard ? ', an artboard' : ''}`;
  return `${what}${page ? ` on page "${page}"` : ''}`;
}

export interface ChatSkill { id: string; name: string; purpose: string; customized: boolean }

/** The playbooks, for `/`: each with whether the person saved their own version of it. */
export function chatSkills(app: BogenServer): ChatSkill[] {
  return DESIGN_DISCIPLINES.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose, customized: app.knowledge.skill(d.id).customized }));
}

export interface SkillDraft {
  discipline: string;
  /** The revision the draft is based on, for the save. */
  revision: string;
  customized: boolean;
  /** The section the draft adds, and the whole skill with it. */
  section: string;
  markdown: string;
  facts: number;
  decisions: number;
}

const tally = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([v]) => v);
};

/** What an artboard settled on, read from its layers: the values it uses most, with tokens where it uses them. */
export function artboardFacts(doc: BogenDoc, nodeId: string): string[] {
  const nodes = [doc.getNode(nodeId)!, ...doc.descendants(nodeId)].filter(Boolean);
  const style = (k: string) => nodes.map((n) => n.style[k] ?? '').filter(Boolean);
  const lines: string[] = [];
  const fonts = tally(style('fontFamily').map((f) => f.split(',')[0]!.replace(/["']/g, '').trim()));
  if (fonts.length) lines.push(`Type families: ${fonts.slice(0, 2).join(' and ')}${fonts.length > 2 ? ` (and ${fonts.length - 2} more, which this artboard keeps to a minimum)` : ''}.`);
  const sizes = [...new Set(style('fontSize'))].sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));
  if (sizes.length) lines.push(`Type sizes, largest first: ${sizes.slice(0, 7).join(', ')}.`);
  const weights = tally(style('fontWeight'));
  if (weights.length) lines.push(`Weights used: ${weights.slice(0, 4).join(', ')}.`);
  const colours = tally([...style('color'), ...style('backgroundColor'), ...style('borderColor')]);
  if (colours.length) lines.push(`Colours, most used first: ${colours.slice(0, 6).join(', ')}.`);
  const spacing = tally([...style('gap'), ...style('padding'), ...style('rowGap'), ...style('columnGap')]);
  if (spacing.length) lines.push(`Spacing, most used first: ${spacing.slice(0, 6).join(', ')}.`);
  const radii = tally(style('borderRadius'));
  if (radii.length) lines.push(`Corner radius: ${radii.slice(0, 3).join(', ')}.`);
  const grids = nodes.filter((n) => n.style.display === 'grid').length;
  const flex = nodes.filter((n) => /flex/.test(n.style.display ?? '')).length;
  if (grids || flex) lines.push(`Layout: ${flex} flex and ${grids} grid container${grids === 1 ? '' : 's'}; heights follow the content.`);
  const vars = new Set(nodes.flatMap((n) => Object.values(n.style).flatMap((v) => [...(v ?? '').matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]!))));
  if (vars.size) lines.push(`Tokens it relies on: ${[...vars].slice(0, 10).map((v) => `--${v}`).join(', ')}.`);
  return lines;
}

/**
 * "Save these decisions as a skill": a section for one discipline's personal SKILL.md, from what an artboard settled
 * on and the proposals the person accepted on it, with what was asked for each. Nothing is saved here: the person
 * reads the draft, edits it, and saves it through the skill editor, as with any personal guidance.
 */
export async function skillDraft(app: BogenServer, input: { fileId: string; nodeId: string; discipline?: string }): Promise<SkillDraft> {
  app.requireFile(input.fileId);
  const { doc } = await app.rooms.get(input.fileId);
  const node = doc.getNode(input.nodeId);
  if (!node) throw new HttpError(404, 'No such layer. Select the artboard the decisions are on.');
  const { runDiscipline } = await import('./run-knowledge.ts');
  const discipline = input.discipline ?? runDiscipline({ fileId: input.fileId, fileName: '', prompt: '', runner: 'claude', nodeIds: [input.nodeId] }, doc, app.storage.get(input.fileId)?.kind === 'brand');
  const skill = app.knowledge.skill(discipline);
  const inside = new Set([input.nodeId, ...doc.descendants(input.nodeId).map((n) => n.id)]);
  const accepted: string[] = [];
  for (const key of doc.meta.keys()) {
    if (!key.startsWith('proposal-decision:')) continue;
    const id = key.slice('proposal-decision:'.length);
    const receipt = proposalDecision(doc, id);
    if (receipt?.decision === 'accepted' && inside.has(receipt.source)) accepted.push(id);
  }
  const memoryKey = DecisionMemory.keyOf(input.fileId, brandLinkOf(doc)?.id);
  const decisions = (await app.memory.decisionsOf(memoryKey, accepted)).sort((a, b) => a.at - b.at);
  const requests = (await app.history.list(input.fileId, 60))
    .filter((r) => r.status === 'done' && (r.nodeIds.some((id) => inside.has(id)) || r.layers.some((id) => inside.has(id))))
    .map((r) => (r.title ?? r.prompt).replace(/\s+/g, ' ').trim().slice(0, 160)).filter(Boolean);
  const facts = artboardFacts(doc, input.nodeId);
  const fileName = app.storage.get(input.fileId)?.name ?? 'a file';
  const lines = [
    `## Decisions from "${node.name}"`,
    '',
    `What the person settled on in "${node.name}" (${fileName}, ${new Date().toISOString().slice(0, 10)}). Prefer these choices for similar work unless the brief asks otherwise.`,
    '',
    ...facts.map((f) => `- ${f}`),
  ];
  const asked = decisions.length ? decisions.map((d) => `- Accepted: ${d.request ?? d.note ?? 'a proposal'}${d.note && d.request ? ` (${d.note})` : ''}.`) : [];
  const shaped = [...new Set(requests)].slice(0, 5).map((r) => `- Asked for: ${r}`);
  if (asked.length || shaped.length) lines.push('', 'Accepted changes, oldest first:', ...asked, ...shaped.filter((s) => !asked.some((a) => a.includes(s.slice(13)))));
  if (accepted.length > decisions.length) lines.push(`- ${accepted.length - decisions.length} more accepted proposal${accepted.length - decisions.length === 1 ? '' : 's'} without a recorded request.`);
  const section = lines.join('\n');
  const base = skill.markdown.trimEnd();
  return { discipline, revision: skill.revision, customized: skill.customized, section, markdown: `${base}\n\n${section}\n`, facts: facts.length, decisions: accepted.length };
}
