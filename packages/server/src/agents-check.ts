import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHtml, newId, type BogenDoc, type BogenNode, type NewNode } from '@bogen/core';
import type { RunnerId } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import { errorMessage } from './util.ts';

/**
 * A real smoke test of the agents: the person's own `claude` and `codex` on a throwaway file, in a throwaway
 * server with its own data folder, so nothing reaches their files, their devices or their run history. Three
 * cases per runner, each the kind of request that went wrong before:
 *
 * - polite: "kannst du die Überschrift größer machen?" must change the heading, not agree that it should.
 * - question: asking for the button's label must answer it, and change nothing.
 * - memory: a second message that says "ihn" must change the layer the first message was about.
 *
 * Each run is a real run on the person's plan, so the file is tiny and the model is the cheap one comments use.
 */

export type CaseName = 'polite' | 'question' | 'memory';
export interface CheckCase { name: CaseName; ok: boolean; changed?: boolean; answered?: boolean; remembered?: boolean; nudged?: boolean; reply?: string; detail: string; seconds: number; error?: string }
export interface CheckRunner { runner: RunnerId; model?: string; effort?: string; available: boolean; version?: string; cases: CheckCase[]; error?: string }
export interface AgentsCheck { id: string; status: 'running' | 'done' | 'failed'; startedAt: number; endedAt?: number; runners: CheckRunner[]; error?: string }

export interface CheckOptions {
  runners?: RunnerId[];
  /** A model for every runner. Otherwise `choose`, else the cheap one comments use. */
  model?: string;
  choose?: (runner: RunnerId) => Promise<{ model?: string; effort?: string }>;
  /** Called on every step, for the Agents tab and the command line. */
  progress?: (check: AgentsCheck) => void;
  timeoutMs?: number;
}

/** What the agents get. The texts are unique enough to find again, whatever the agent does with the layers. */
export const CHECK_PAGE = `<h1 style="font-size: 32px; font-weight: 700; margin: 0; color: #111111">Sommerfest 2026</h1>
<p style="font-size: 18px; font-weight: 400; margin: 0; color: #333333">Tickets ab Freitag.</p>
<button style="padding: 12px 20px; font-size: 16px; font-weight: 500; border: none; border-radius: 6px; background: #1f2937; color: #ffffff">Jetzt buchen</button>`;

export const CASES = {
  polite: 'kannst du die Überschrift größer machen?',
  question: 'Wie lautet der Text auf dem Button? Antworte nur mit dem Text, und ändere nichts.',
  memory: ["Ändere den Text des Absatzes zu 'Tickets ab Samstag.'", 'Mach ihn jetzt fett.'] as const,
};

const RUN_TIMEOUT_MS = 240_000;

function textOf(node: BogenNode): string {
  return (node.text ?? '').replace(/\s+/g, ' ').trim();
}

/** The three layers, found by what they say or what they are, since an agent may write them anew. */
export function findLayers(doc: BogenDoc, boardId: string): { heading?: BogenNode; paragraph?: BogenNode; button?: BogenNode } {
  const all = doc.descendants(boardId);
  const heading = all.find((n) => n.tag === 'h1') ?? all.find((n) => /sommerfest/i.test(textOf(n)));
  const paragraph = all.find((n) => n.tag === 'p' && /tickets/i.test(textOf(n))) ?? all.find((n) => /tickets ab/i.test(textOf(n)));
  const button = all.find((n) => n.tag === 'button') ?? all.find((n) => /jetzt buchen/i.test(textOf(n)));
  return { ...(heading ? { heading } : {}), ...(paragraph ? { paragraph } : {}), ...(button ? { button } : {}) };
}

/** Pixels of a CSS length as stored: px, rem and em at 16, a token that holds one. Null for anything else. */
export function px(value: string | undefined, doc: BogenDoc): number | null {
  if (!value) return null;
  const token = /^var\(--([\w-]+)\)$/.exec(value.trim());
  if (token) return px(doc.getTokens().find((t) => t.name === token[1] || t.name === `--${token[1]}`)?.value, doc);
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1);
}

/** Whether text reads as bold: the layer's weight, or spans that cover most of it. */
export function isBold(node: BogenNode, computed?: string): boolean {
  const heavy = (w: string | undefined) => Boolean(w && (/^(bold|bolder)$/i.test(w) || Number(w) >= 600));
  if (heavy(computed) || heavy(node.style.fontWeight)) return true;
  const spans = (node.spans ?? []).filter((s) => heavy(s.style?.fontWeight));
  const covered = spans.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  return covered > 0 && covered >= textOf(node).length * 0.6;
}

/** Each layer of the board as JSON, to tell what a run changed. */
function snapshot(doc: BogenDoc, boardId: string): Map<string, string> {
  return new Map(doc.descendants(boardId).map((n) => [n.id, JSON.stringify(n)]));
}

function changedIds(before: Map<string, string>, after: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [id, json] of after) if (before.get(id) !== json) out.add(id);
  for (const id of before.keys()) if (!after.has(id)) out.add(id);
  return [...out];
}

function oneLine(text: string | undefined, max = 300): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Runs the check in a throwaway server, and tells `progress` about every step. */
export async function runAgentsCheck(options: CheckOptions = {}): Promise<AgentsCheck> {
  const check: AgentsCheck = { id: newId(), status: 'running', startedAt: Date.now(), runners: [] };
  const tell = () => options.progress?.(structuredClone(check));
  const home = await mkdtemp(join(tmpdir(), 'bogen-check-'));
  const { BogenServer } = await import('./http/server.ts');
  const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports') });
  // The check asks whether a runner does what it is told, not whether a throwaway page passes design review. The
  // completion check would fail a runner that did exactly what was asked, and its repair turns would spend the
  // person's plan up to three times per case.
  server.runs.beforeFinish = undefined;
  try {
    await server.listen();
    const infos = await server.runs.runners();
    const wanted = options.runners?.length ? options.runners : (['claude', 'codex'] as RunnerId[]);
    for (const runner of wanted) {
      const info = infos.find((i) => i.id === runner);
      check.runners.push({ runner, available: Boolean(info?.available), ...(info?.version ? { version: info.version } : {}), cases: [], ...(info?.available ? {} : { error: `${runner} is not installed here, or not on the PATH.` }) });
    }
    tell();
    await Promise.all(check.runners.filter((r) => r.available).map((r) => checkRunner(server, r, options, tell)));
    check.status = 'done';
  } catch (e) {
    check.status = 'failed';
    check.error = errorMessage(e);
  } finally {
    check.endedAt = Date.now();
    await server.close().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
  tell();
  return check;
}

async function checkRunner(server: BogenServer, result: CheckRunner, options: CheckOptions, tell: () => void): Promise<void> {
  const { runner } = result;
  try {
    const choice = options.model ? { model: options.model } : options.choose ? await options.choose(runner) : await server.runSettings.resolve(runner, 'comment', {});
    if (choice.model) result.model = choice.model;
    if ('effort' in choice && choice.effort) result.effort = choice.effort;
    const entry = server.storage.create(`Agents check: ${runner}`);
    const room = await server.rooms.get(entry.id);
    const { doc } = room;
    const pageId = doc.getPages()[0]!.id;
    const boardId = doc.insert(pageId, { type: 'frame', tag: 'main', name: 'Event', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '480px', height: '280px', display: 'flex', flexDirection: 'column', gap: '16px', padding: '32px', backgroundColor: '#ffffff', alignItems: 'flex-start' } }, undefined, 'person:Check');
    doc.invalidate();
    doc.insertMany(boardId, importHtml(CHECK_PAGE).nodes as NewNode[], undefined, 'person:Check');
    doc.invalidate();

    const ask = async (prompt: string, conversationId: string): Promise<{ reply: string; nudged: boolean; changed: string[]; seconds: number; status: string; error?: string }> => {
      const before = snapshot(doc, boardId);
      const startedAt = Date.now();
      const runId = await server.runs.start({ fileId: entry.id, fileName: entry.name, pageId, nodeIds: [], prompt, runner, conversationId, ...choice });
      const deadline = startedAt + (options.timeoutMs ?? RUN_TIMEOUT_MS);
      while (server.runs.isActive(runId)) {
        if (Date.now() > deadline) server.runs.stop(runId);
        await new Promise((r) => setTimeout(r, 250));
      }
      const record = await server.history.get(entry.id, runId);
      const timedOut = Date.now() > deadline;
      return {
        reply: record?.result ?? '', nudged: Boolean(record?.nudged), changed: changedIds(before, snapshot(doc, boardId)), seconds: Math.round((Date.now() - startedAt) / 100) / 10,
        status: record?.status ?? 'failed', ...(timedOut ? { error: `No answer within ${Math.round((options.timeoutMs ?? RUN_TIMEOUT_MS) / 1000)} s.` } : record?.error ? { error: oneLine(record.error, 500) } : {}),
      };
    };
    const computed = async (ids: string[]) => {
      try {
        return await server.renderer.computed(doc, ids, ['font-size', 'font-weight']);
      } catch {
        return {} as Record<string, { style: Record<string, string> }>;
      }
    };

    // 1. A polite request phrased as a question.
    {
      const start = findLayers(doc, boardId).heading!;
      const sizeBefore = Number.parseFloat((await computed([start.id]))[start.id]?.style['font-size'] ?? '') || px(start.style.fontSize, doc) || 32;
      const run = await ask(CASES.polite, newId());
      const heading = findLayers(doc, boardId).heading;
      const sizeAfter = heading ? Number.parseFloat((await computed([heading.id]))[heading.id]?.style['font-size'] ?? '') || px(heading.style.fontSize, doc) : null;
      const grew = sizeAfter !== null && sizeAfter > sizeBefore;
      result.cases.push({
        name: 'polite', ok: grew && run.status === 'done', changed: run.changed.length > 0, answered: Boolean(run.reply.trim()), nudged: run.nudged, reply: oneLine(run.reply), seconds: run.seconds,
        detail: grew ? `The heading went from ${sizeBefore}px to ${sizeAfter}px${run.nudged ? ', after Bogen asked it once more' : ''}.` : run.changed.length ? `It changed ${run.changed.length} layer(s), but the heading is not bigger (${sizeBefore}px to ${sizeAfter ?? 'gone'}).` : `It changed nothing${run.nudged ? ', even after Bogen asked it once more' : ''}.`,
        ...(run.error ? { error: run.error } : {}),
      });
      tell();
    }

    // 2. A pure question: an answer, and no change.
    {
      const run = await ask(CASES.question, newId());
      const answered = /jetzt\s+buchen/i.test(run.reply);
      result.cases.push({
        name: 'question', ok: answered && !run.changed.length && run.status === 'done', changed: run.changed.length > 0, answered, nudged: run.nudged, reply: oneLine(run.reply), seconds: run.seconds,
        detail: `${answered ? 'It named the label' : 'It did not name the label "Jetzt buchen"'}, and ${run.changed.length ? `changed ${run.changed.length} layer(s), which a question should not` : 'changed nothing'}.`,
        ...(run.error ? { error: run.error } : {}),
      });
      tell();
    }

    // 3. Two turns: the second only makes sense with the first.
    {
      const conversation = newId();
      const first = await ask(CASES.memory[0], conversation);
      const paragraph = findLayers(doc, boardId).paragraph;
      const renamed = Boolean(paragraph && /samstag/i.test(textOf(paragraph)));
      const second = await ask(CASES.memory[1], conversation);
      const after = findLayers(doc, boardId);
      const weight = after.paragraph ? (await computed([after.paragraph.id]))[after.paragraph.id]?.style['font-weight'] : undefined;
      const bold = Boolean(after.paragraph && isBold(after.paragraph, weight));
      const strayed = [after.heading?.id, after.button?.id].filter((id) => id && second.changed.includes(id)).length > 0;
      const remembered = bold && !strayed;
      result.cases.push({
        name: 'memory', ok: renamed && remembered && second.status === 'done', changed: first.changed.length > 0 && second.changed.length > 0, answered: Boolean(second.reply.trim()), remembered, nudged: first.nudged || second.nudged,
        reply: oneLine(second.reply), seconds: Math.round((first.seconds + second.seconds) * 10) / 10,
        detail: `Turn 1 ${renamed ? 'changed the paragraph to Samstag' : 'did not change the paragraph text'}; turn 2 ${bold ? 'made the paragraph bold' : 'did not make the paragraph bold'}${strayed ? ' and also changed the heading or the button' : ''}.`,
        ...(first.error || second.error ? { error: [first.error, second.error].filter(Boolean).join(' ') } : {}),
      });
      tell();
    }
  } catch (e) {
    result.error = errorMessage(e);
    tell();
  }
}

/** The check as text, for the command line. */
export function checkReport(check: AgentsCheck): string {
  const lines: string[] = [];
  const mark = (ok: boolean | undefined) => (ok ? 'yes' : 'no');
  for (const r of check.runners) {
    lines.push(`${r.runner}${r.version ? ` (${r.version})` : ''}${r.model ? `, model ${r.model}${r.effort ? `, effort ${r.effort}` : ''}` : ''}`);
    if (r.error) lines.push(`  ${r.error}`);
    for (const c of r.cases) {
      const what = c.name === 'polite' ? `changed something: ${mark(c.changed)}` : c.name === 'question' ? `answered correctly: ${mark(c.answered)}, left it alone: ${mark(!c.changed)}` : `remembered: ${mark(c.remembered)}`;
      lines.push(`  ${c.ok ? 'pass' : 'FAIL'}  ${c.name.padEnd(8)} ${what}${c.nudged ? ', nudged once' : ''}, ${c.seconds} s`);
      lines.push(`        ${c.detail}`);
      if (c.reply) lines.push(`        Reply: ${c.reply}`);
      if (c.error) lines.push(`        Error: ${c.error}`);
    }
  }
  if (check.error) lines.push(`The check failed: ${check.error}`);
  const all = check.runners.flatMap((r) => r.cases);
  lines.push('', `${all.filter((c) => c.ok).length} of ${all.length} cases passed in ${Math.round(((check.endedAt ?? Date.now()) - check.startedAt) / 1000)} s.`);
  return lines.join('\n');
}
