import { describe, expect, it } from 'vitest';
import { CallBrain, contextText, routeByRules, ruleLine, type BrainSinks, type CallContext, type Persona, type PersonaRequest } from '../src/call-brain.ts';

/**
 * A real call of 17 November 2026: "So what were the last changes?" got "I do not see any recent changes"
 * although runs had happened, "You're done with what?" got "Yes, I can hear you. What should I change?", and
 * "So, what's up?" a bare "I am done and waiting for you."; German said with a pause came out as two broken halves.
 */
const SCREEN: CallContext = { file: 'Sprechstunde · Praxis-Website', page: 'Produkt, Porträts' };
const RESULT = 'I redid all seven screens on "Produkt, Porträts": one large founder portrait on the home page, a clearer price summary in the booking, and the founder inbox as cards.';

describe('the call of 17 November', () => {
  it('takes "what were the last changes" and "done with what" as questions about the last result', () => {
    for (const said of ['So what were the last changes?', "You're done with what?", 'Womit bist du fertig?', 'Was waren die letzten Änderungen?', 'What did the agent change?']) {
      expect(routeByRules(said, { ...SCREEN, lastResult: RESULT }, 'en'), said).toMatchObject({ action: 'answer', recap: true });
    }
  });

  it('without a result in this call, lets the talking layer answer from the run history instead of saying nothing happened', () => {
    const r = routeByRules('So what were the last changes?', SCREEN, 'en');
    expect(r).toMatchObject({ action: 'answer', word: true, soft: true });
    expect(r.say).not.toMatch(/not done anything/);
  });

  it('answers "what\'s up?" when idle with what it finished, not a bare "done and waiting"', () => {
    expect(routeByRules("So, what's up?", { ...SCREEN, lastResult: RESULT }, 'en')).toMatchObject({ recap: true });
    expect(routeByRules("So, what's up?", SCREEN, 'en').say).not.toMatch(/done and waiting/);
  });

  it('says "I can hear you" only to a check of the line', () => {
    expect(ruleLine('chat', 'en', 'Hello?')).toMatch(/hear you/);
    expect(ruleLine('chat', 'de', 'Hallo?')).toMatch(/höre dich/);
    expect(ruleLine('chat', 'en', 'Can you hear me?')).toMatch(/hear you/);
    expect(ruleLine('chat', 'en', "You're done with what?")).not.toMatch(/hear you/);
    expect(ruleLine('chat', 'de', 'Er arbeitet da gern schon.')).toMatch(/nicht ganz verstanden/);
  });

  it('gives the talking layer the file\'s runs, also one still running', () => {
    const text = contextText({ ...SCREEN, recentRuns: [
      { minutesAgo: 0, status: 'running', asked: 'Redo the whole thing and make it a lot better.' },
      { minutesAgo: 880, status: 'done', asked: '3D.', result: 'I gave the design real depth on all seven screens.' },
    ] });
    expect(text).toContain('STILL RUNNING: asked "Redo the whole thing');
    expect(text).toContain('15 h ago, done: asked "3D."; it said: """I gave the design real depth');
  });

  it('a stretch heard again with the turn\'s earlier piece stands for both', async () => {
    let clock = 0;
    const heard: string[] = [];
    const sinks: BrainSinks = { say: () => {}, send: () => {}, command: () => {}, stopVoice: () => {}, duck: () => {}, earcon: () => {}, heard: (t) => heard.push(t) };
    const brain = new CallBrain({ language: 'de', now: () => clock, persona: null, sinks });
    brain.speechStart(); clock += 900; brain.speechEnd(); brain.segment('Aberte der', 900);
    expect(brain.openParts).toBe(1);
    brain.speechStart(); clock += 900; brain.speechEnd(); brain.segment('Arbeitet der Agent gerade noch?', 900, { replaces: 1 });
    for (let i = 0; i < 10; i++) { clock += 500; brain.tick(); await new Promise((r) => setTimeout(r, 0)); }
    expect(heard).toEqual(['Arbeitet der Agent gerade noch?']);
    // Words thrown away as noise never replace what was said.
    brain.speechStart(); clock += 900; brain.speechEnd(); brain.segment('Mach die', 900);
    brain.speechStart(); clock += 900; brain.speechEnd(); brain.segment('', 900, { replaces: 1 });
    expect(brain.openParts).toBe(1);
  });

  it('replays the call: after the run, "you\'re done with what?" retells what the agent did', async () => {
    let clock = 0;
    const said: { text: string; kind: string }[] = [];
    const asked: PersonaRequest[] = [];
    const persona: Persona = async (req) => { asked.push(req as PersonaRequest); return req.kind === 'result' ? 'I redid all seven screens, with one big portrait on the home page.' : null; };
    const sinks: BrainSinks = { say: (text, kind) => said.push({ text, kind }), send: () => brain.agentStart(), command: () => {}, stopVoice: () => {}, duck: () => {}, earcon: () => {}, screen: () => SCREEN };
    const brain: CallBrain = new CallBrain({ language: 'en', now: () => clock, persona, sinks });
    const turn = async (text: string) => {
      brain.speechStart(); clock += 900; brain.speechEnd(); brain.segment(text, 900);
      for (let i = 0; i < 24; i++) { clock += 500; brain.tick(); await new Promise((r) => setTimeout(r, 0)); }
    };
    await turn('Okay, can you let him redo the whole thing and make it a lot better?');
    expect(brain.agentRunning).toBe(true);
    await turn('Is the agent working?');
    expect(said.at(-1)!.text).toMatch(/still|working/i);
    await brain.agentFinish(RESULT, true);
    const before = said.length;
    await turn("You're done with what?");
    const answer = said.slice(before).find((l) => l.kind === 'reply');
    expect(answer?.text).toMatch(/redid all seven screens/);
    expect(asked.at(-1)).toMatchObject({ kind: 'result', agent: RESULT });
  });
});
