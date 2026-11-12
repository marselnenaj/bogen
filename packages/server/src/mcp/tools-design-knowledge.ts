import { z } from 'zod';
import { DISCIPLINE_IDS, KNOWLEDGE_ACTIONS } from '../design-knowledge/index.ts';
import { KnowledgeChange } from '../design-knowledge/library.ts';
import { RUBRIC_IDS, RUBRIC_MIN_EVIDENCE } from '../design-knowledge/rubric.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

export function registerDesignKnowledgeTools(define: ToolDefiner): void {
  define('design_knowledge', {
    description: 'Read Bogen-authored, LLM-oriented design playbooks for websites, mobile/desktop apps, forms, commerce, dashboards, decks, social, email, docs, brands, motion, localization, OS themes and widgets. Start with catalog; load action skill for ONE relevant discipline: one Markdown text with the quality bar, the work loop, the decisions and the scored rubric. action playbook returns the same as structured data, with brief inputs, conditional decisions, required states, deliverables and a repair workflow. action rubric returns the quality bar and the eight scored criteria on their own; action style lists the habits to avoid, narrowed by id or query. Decisions state WHEN, DO, CHECK, REPAIR and EXCEPTION. action rules searches those decisions; recipes offers alternate compositions; skill returns the effective editable SKILL.md and revision; original returns the immutable shipped version. A playbook includes the effective skill; customized Markdown governs style instead of conflicting shipped reference text. Use design_knowledge_update for durable user preferences. No browsing or external reading is required. Heuristics adapt to the user brief and confirmed brand. Legacy sources are optional historical records for older clients, not prerequisites. This read-only tool grants no new permissions.', readOnly: true,
  }, {
    action: z.enum(KNOWLEDGE_ACTIONS).default('catalog'),
    discipline: z.enum(DISCIPLINE_IDS).optional(),
    query: z.string().max(300).optional(), id: z.string().max(100).optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(10),
  }, (args, ctx) => ctx.app.knowledge.read(args));

  define('design_knowledge_update', { description: 'Customize ONE discipline’s personal SKILL.md on this Bogen host, across its designs; not automatically synced. Read design_knowledge action skill first and pass its exact revision. Save either complete markdown or targeted edits, each matching exactly once. Follow explicit enduring preferences or repeated user corrections; do not turn a one-off brief exception or your own taste into a global rule. Record the user-grounded reason and tell them what changed. Current user instructions always win. Restore removes the custom override and returns the latest shipped original; previous contents are backed up under the skill history folder. This changes guidance, never tool permissions, human-only approval or server checks.' }, KnowledgeChange.shape, (args, ctx) => ctx.app.knowledge.change(args, ctx.agent));

  define('design_verify', {
    description: 'Measure and review one affected artboard with its discipline’s criteria. Runs real contrast lint, and for interactive/responsive disciplines accessibility and 320/768/1440 layout probes; fixed-format decks/social/storyboards are not resized into websites. Measurements never change the design. It also runs the craft checks for the habits that make work look generated or unfinished. Inspect canvas_screenshot AFTER the last edit, then submit observations for priority, content and context with specific visual evidence (at least 24 characters each), and rubric: a score from 1 to 5 with evidence for each of hierarchy, type, spacing, colour, content, craft, originality and fit. The rubric counts as scored only when all eight are there, none is 2 or lower, and none is above 3 while measured findings stand against that criterion; under 32 of 40 the result asks for another pass or a second direction. These are explicitly agent self-assessments, not a human approval or a beauty score. Changing the design invalidates the previous report. Errors in affected layers, an incomplete review and a rubric that is not scored prevent a built-in agent run from completing: Bogen requests at most two repair turns, then reports unresolved work. Large scopes or render failures stay unverified; never turn off the browser sandbox. Only the person accepts proposals or resolves threads.', readOnly: true,
  }, {
    node_id: z.string().describe('The affected artboard. Review each affected artboard separately.'),
    discipline: z.enum(DISCIPLINE_IDS),
    observations: z.array(z.object({
      criterion: z.enum(['priority', 'content', 'context']), verdict: z.enum(['pass', 'needs-work', 'not-applicable']),
      evidence: z.string().trim().min(24).max(1200).describe('A specific observed layer, relationship, content fact or reason this criterion does not apply. Not just looks good.'),
    })).max(3).default([]),
    rubric: z.array(z.object({
      criterion: z.enum(RUBRIC_IDS), score: z.number().int().min(1).max(5).describe('5 strong, 4 good, 3 adequate, 2 weak, 1 failing. A 2 or lower is not finished work.'),
      evidence: z.string().trim().min(RUBRIC_MIN_EVIDENCE).max(600).describe('What you see in the screenshot that earns this score: a layer, a size, a relationship. Not just looks good.'),
    })).max(RUBRIC_IDS.length).default([]).describe(`The scored self-review, all of: ${RUBRIC_IDS.join(', ')}. The result returns the questions and anchors for what is still open.`),
    file_id: fileIdArg,
  }, async ({ node_id, discipline, observations, rubric, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (!room.doc.getNode(node_id)?.artboard) throw new Error('Choose an artboard; layer_tree lists the artboards. A review is scoped so large files are not rendered in full.');
    return ctx.app.designQuality.review(room.id, node_id, discipline, observations, ctx.session.runId, rubric);
  });
}
