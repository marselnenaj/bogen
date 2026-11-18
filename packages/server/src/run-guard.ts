import { asksForChange } from '@bogen/core';
import type { RunReview } from './agents.ts';

export { asksForChange };

/**
 * A run asked to change something that ends having changed nothing usually agreed instead of working: "You're
 * right, that should be bigger." The guard notices, and continues the run once with a short nudge. It needs to
 * know whether the person asked for a change at all, which is what `asksForChange` guesses, in English and German.
 */

/** Said to a run that replied without changing anything. */
export const NUDGE = 'You replied without changing anything. If the person clearly asked for a change, make that change now and nothing beyond it. If they asked a question, or only asked for your review or opinion, change nothing and say so in one sentence.';

/** Tools that write to the document without changing the design: talking in a thread is not doing the work. */
export const TALK_TOOLS = new Set(['comment_add', 'comment_reply']);

/** Whether a run that has just ended should be continued once with the nudge. Never a critique, never twice. */
export function needsNudge(run: { request: string; review?: RunReview; live?: boolean; changed: boolean; nudged: boolean }): boolean {
  if (run.nudged || run.changed || run.live || run.review === 'critique') return false;
  return asksForChange(run.request);
}

/** What the continuation is told: everything the run was told, what it said, and the nudge. */
export function nudgePrompt(prompt: string, reply: string): string {
  const said = reply.trim() ? reply.trim().slice(-3000) : '(nothing)';
  return `${prompt}\n\n---\nYou already answered this request once. Your reply was:\n${said}\n\n${NUDGE}`;
}
