import { z } from 'zod';
import { DISCIPLINE_IDS, KNOWLEDGE_ACTIONS } from '../design-knowledge/index.ts';
import { KnowledgeChange } from '../design-knowledge/library.ts';
import { KEPT_MIN_REASON, RUBRIC_IDS, RUBRIC_MIN_EVIDENCE } from '../design-knowledge/rubric.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

export function registerDesignKnowledgeTools(define: ToolDefiner): void {
  define('design_knowledge', {
    description: 'Bogen-authored design playbooks for websites, mobile and desktop apps, forms, commerce, dashboards, decks, social, email, docs, brands, motion, localization, OS themes and widgets. Start with catalog, then action skill for ONE discipline: one Markdown text with what strong work in that medium holds, its decisions, states, review and the scored rubric. playbook returns the same as structured data; rubric the quality bar and the eight criteria; style the habits to replace, narrowed by id or query; rules searches the decisions; recipes offers alternate compositions; original returns the shipped version of a skill. A customized skill governs style over the shipped text; the current brief governs both. Use design_knowledge_update for durable user preferences. Read-only; no browsing needed.', readOnly: true,
  }, {
    action: z.enum(KNOWLEDGE_ACTIONS).default('catalog'),
    discipline: z.enum(DISCIPLINE_IDS).optional(),
    query: z.string().max(300).optional(), id: z.string().max(100).optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(10),
  }, (args, ctx) => ctx.app.knowledge.read(args));

  define('design_knowledge_update', { description: 'Customize ONE discipline’s personal SKILL.md on this Bogen host, across its designs; not automatically synced. Read design_knowledge action skill first and pass its exact revision. Save either complete markdown or targeted edits, each matching exactly once. Follow explicit enduring preferences or repeated user corrections; do not turn a one-off brief exception or your own taste into a global rule. Record the user-grounded reason and tell them what changed. Current user instructions always win. Restore removes the custom override and returns the latest shipped original; previous contents are backed up under the skill history folder. This changes guidance, never tool permissions, human-only approval or server checks.' }, KnowledgeChange.shape, (args, ctx) => ctx.app.knowledge.change(args, ctx.agent));

  define('design_verify', {
    description: 'Measure and review one affected artboard with its discipline’s criteria. Runs real contrast lint, and for interactive/responsive disciplines accessibility and 320/768/1440 layout probes; fixed-format decks/social/storyboards are not resized into websites. Measurements never change the design. It also runs the craft checks for the habits that make work look generated or unfinished. Inspect canvas_screenshot AFTER the last edit, then submit observations for priority, content and context with specific visual evidence (at least 24 characters each), and rubric: a score from 1 to 5 with evidence for each of hierarchy, type, spacing, colour, content, craft, originality and fit. The rubric counts as scored only when all eight are there, none is 2 or lower, no hard finding stands (an objective defect: overflow, unreadable text, placeholder copy), and none is above 3 while measured findings stand against that criterion. Advisory findings (choices that often read as default) come with why; they never block or cap, and kept records your reason when you keep one; under 32 of 40 the result asks for another pass or a second direction. These are explicitly agent self-assessments, not a human approval or a beauty score. Changing the design invalidates the previous report. Errors in affected layers, an incomplete review and a rubric that is not scored prevent a built-in agent run from completing: Bogen requests at most two repair turns, then reports unresolved work. Large scopes or render failures stay unverified; never turn off the browser sandbox. Only the person accepts proposals or resolves threads.', readOnly: true,
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
    kept: z.array(z.object({
      check: z.string().min(1).max(60).describe('The check of a finding you keep on purpose, such as caps-label or one-hue.'),
      reason: z.string().trim().min(KEPT_MIN_REASON).max(400).describe('Why, from your direction or the brief. Recorded with the result.'),
    })).max(12).default([]).describe('Advisory findings you keep, with the reason, recorded in the result. A hard finding is kept only when the brief asks for it, and still caps its criterion.'),
    file_id: fileIdArg,
  }, async ({ node_id, discipline, observations, rubric, kept, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (!room.doc.getNode(node_id)?.artboard) throw new Error('Choose an artboard; layer_tree lists the artboards. A review is scoped so large files are not rendered in full.');
    return ctx.app.designQuality.review(room.id, node_id, discipline, observations, ctx.session.runId, rubric, kept);
  });
}
