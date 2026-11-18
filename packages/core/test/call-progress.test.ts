import { describe, expect, it } from 'vitest';
import { CallBrain, headerBrief, parseBrief, parseTurn, type BrainSinks, type Persona, type PersonaRequest, type SendMeta } from '../src/call-brain.ts';

/**
 * A long run in a call: the voice says one short line about every 90 seconds from the agent's latest steps, held to
 * the news budget, and nothing after "be quiet". The brief carries how big the request is, for the run's model.
 */
function rig(persona: Persona | null) {
  let clock = 0;
  const said: { text: string; kind: string }[] = [];
  const sent: { text: string; meta?: SendMeta }[] = [];
  const sinks: BrainSinks = {
    say: (text, kind) => said.push({ text, kind }),
    send: (text, _l, meta) => sent.push({ text, ...(meta ? { meta } : {}) }),
    command() {}, stopVoice() {}, duck() {}, earcon() {},
  };
  const brain = new CallBrain({ language: 'en', now: () => clock, persona, sinks });
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const advance = async (ms: number) => { for (let i = 0; i < ms / 100; i++) { clock += 100; brain.tick(); if (i % 10 === 0) await flush(); } await flush(); };
  const turn = async (text: string) => {
    brain.speechStart(); clock += 900; brain.speechEnd();
    brain.segment(text, 900, { speechMs: 800 });
    await advance(6000);
  };
  return { brain, said, sent, advance, turn };
}

describe('signs of life during a long run', () => {
  it('says one short line about every 90 s from the latest steps, and never the same news twice', async () => {
    const asks: PersonaRequest[] = [];
    let n = 0;
    const lines = ['It is drawing the pricing table now.', 'It is drawing the pricing table now.', 'Now it is checking the layout.'];
    const r = rig(async (req) => { asks.push(req); return req.kind === 'progress' ? lines[n++] ?? null : null; });
    r.brain.agentStart();
    r.brain.agentActivity('tool:mcp__bogen__html_write');
    r.brain.agentActivity('I am adding the pricing table with the three plans.');
    await r.advance(85_000);
    expect(r.said.filter((l) => l.kind === 'progress')).toEqual([]);
    await r.advance(6_000);
    expect(r.said.filter((l) => l.kind === 'progress').map((l) => l.text)).toEqual(['It is drawing the pricing table now.']);
    const ask = asks.find((a) => a.kind === 'progress')!;
    // Made from what it did, not read out: its steps and its latest words.
    expect(ask.agent).toContain('pricing table');
    // The second line would say the same: the news budget holds it.
    await r.advance(91_000);
    expect(r.said.filter((l) => l.kind === 'progress')).toHaveLength(1);
    r.brain.agentActivity('tool:mcp__bogen__design_lint');
    await r.advance(91_000);
    expect(r.said.filter((l) => l.kind === 'progress').map((l) => l.text)).toEqual(['It is drawing the pricing table now.', 'Now it is checking the layout.']);
  });

  it('stays quiet after "be quiet", and starts nothing when no run goes', async () => {
    const idle = rig(null);
    await idle.advance(200_000);
    expect(idle.said.filter((l) => l.kind === 'progress')).toEqual([]);

    const r = rig(null);
    r.brain.agentStart();
    r.brain.agentActivity('tool:mcp__bogen__html_write');
    await r.turn('Be quiet while it works.');
    await r.advance(300_000);
    expect(r.said.filter((l) => l.kind === 'progress')).toEqual([]);
  });

  it('speaks from the rules without a talking layer', async () => {
    const r = rig(null);
    r.brain.agentStart();
    r.brain.agentActivity('tool:mcp__bogen__html_write');
    await r.advance(92_000);
    expect(r.said.filter((l) => l.kind === 'progress')).toHaveLength(1);
  });
});

describe('the size of a request in its brief', () => {
  it('is read from the brief JSON and from the action line, and left out when unknown', () => {
    expect(parseBrief('{"goal": "Make the headline bigger", "constraints": [], "size": "small"}')).toEqual({ goal: 'Make the headline bigger', constraints: [], size: 'small' });
    expect(parseBrief('{"goal": "Make the headline bigger", "constraints": [], "size": "huge"}')).toEqual({ goal: 'Make the headline bigger', constraints: [] });
    expect(headerBrief('goal: Make the headline bigger. | size: small')).toEqual({ goal: 'Make the headline bigger.', constraints: [], size: 'small' });
    expect(headerBrief('goal: Redo the file as a magazine. | keep: the portraits; the logo | size: large')).toEqual({ goal: 'Redo the file as a magazine.', constraints: ['the portraits', 'the logo'], size: 'large' });
    expect(headerBrief('goal: Redo the file as a magazine. | keep: the portraits')).toEqual({ goal: 'Redo the file as a magazine.', constraints: ['the portraits'] });
    expect(parseTurn('@agent goal: Tell me what you think. | size: answer\nSure, a look.')?.brief?.size).toBe('answer');
  });

  it('goes with the request to the agent', async () => {
    const r = rig(async (req) => (req.kind === 'brief' ? '{"goal": "Make the headline on the start page bigger", "constraints": [], "size": "small"}' : null));
    await r.turn('Make the headline on the start page bigger.');
    await r.advance(10_000);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.meta?.size).toBe('small');
  });
});
