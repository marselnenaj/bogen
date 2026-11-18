import { describe, expect, it } from 'vitest';
import { briefSaid, CallBrain, type BrainSinks, type Persona, type PersonaRequest } from '../src/call-brain.ts';
import { resultPoints, resultSay, resultText, tells } from '../src/call-result.ts';
import { noiseVerdict, spokenPart } from '../src/call-noise.ts';
import { asksForChange } from '../src/asks-for-change.ts';

/**
 * The end of a run in a call, as it went wrong in the call of 2026-11-18: a review was nudged, the nudge's "That was a
 * review, so I left the design as it was" was spoken instead of the review, and "what about the rest?" was sent to the
 * agent again because the voice had only the start of the answer.
 */
const REVIEW = [
  "I'll look at the 13 screens first.",
  '',
  'Review of the v3 value page:',
  '- The app looks strong overall: clear structure and a calm palette.',
  '- Top fix: the scenario screen shows tap buttons while your hands are busy pushing on the cushion.',
  '- The facts contradict across screens: 30 compressions on one, 15 on another.',
  '- The call practice screen hides the emergency number below the fold.',
  '- The kit check list has no progress state, so a half done check looks finished.',
  '',
  '<say>It looks strong overall. The top fix: the scenario screen asks for taps while your hands are busy on the cushion, and the facts contradict across screens.</say>',
  '',
  'Bogen: nothing was changed, so it was asked once more to do what you asked.',
  '',
  'You only asked for a review and asked a few questions, so I left the design as it was.',
  '',
  '<say>That was a review, so I left the design as it was. First Minute is an iPhone app for keeping first aid skills fresh.</say>',
].join('\n');

function rig(persona: Persona | null = null) {
  let clock = 0;
  const said: { text: string; kind: string }[] = [];
  const sent: string[] = [];
  const sinks: BrainSinks = {
    say: (text, kind) => said.push({ text, kind }),
    send: (text) => sent.push(briefSaid(text)),
    command() {}, stopVoice() {}, duck() {}, earcon() {},
  };
  const brain = new CallBrain({ language: 'en', now: () => clock, persona, sinks });
  const at = (ms: number) => { while (clock < ms) { clock = Math.min(ms, clock + 20); brain.tick(); } };
  const settle = async (ms = 3000) => { for (let i = 0; i < 4; i++) { at(clock + ms / 4); await new Promise((r) => setTimeout(r, 0)); } };
  const hear = async (text: string) => {
    brain.speechStart(); at(clock + 1200); brain.speechEnd();
    brain.segment(text, 1200, { speechMs: 1100 });
    await settle();
  };
  return { brain, said, sent, hear, settle };
}

describe('the result of a run', () => {
  it('takes the say block with news, not the one about what was left alone', () => {
    const pick = resultSay(REVIEW)!;
    expect(pick.line).toMatch(/strong overall/);
    expect(pick.line).not.toMatch(/left the design/);
    // Without a nudge: the meta sentence goes, the rest stays, and it is marked as having led with it.
    const plain = resultSay('Done.\n<say>That was a review, so I left the design as it was. The hero reads well, the footer is cramped.</say>')!;
    expect(plain).toEqual({ line: 'The hero reads well, the footer is cramped.', metaLed: true });
    expect(resultSay('<say>I changed nothing.</say>')).toBeNull();
  });

  it('keeps the whole answer as points, without the say blocks, the server note or the meta lines', () => {
    const text = resultText(REVIEW);
    expect(text).not.toMatch(/<say>|Bogen: nothing was changed/);
    expect(text).toContain('kit check');
    const points = resultPoints(REVIEW);
    expect(points).toHaveLength(5);
    expect(points[0]).toMatch(/^The app looks strong overall/);
    expect(points.some((p) => /left the design/.test(p))).toBe(false);
    expect(tells('Its top fix: the scenario screen shows tap buttons while your hands are busy pushing on the cushion.', points[1]!)).toBe(true);
    expect(tells('Its top fix: the scenario screen shows tap buttons.', points[4]!)).toBe(false);
  });

  it('speaks a review run\'s finish as the gist and top points, then offers the rest', async () => {
    const r = rig();
    r.brain.agentStart();
    await r.brain.agentFinish(REVIEW, true);
    const lines = r.said.map((s) => s.text);
    expect(lines[0]).toMatch(/strong overall/);
    expect(lines[0]).toMatch(/scenario screen/);
    expect(lines.join(' ')).not.toMatch(/left the design|that was it|details are in the chat/i);
    expect(lines.at(-1)).toBe('It said more. Want the rest?');
    const ctx = r.brain.context();
    expect(ctx.lastResult).toContain('kit check');
    expect(ctx.resultLeft?.map((p) => p.slice(0, 20))).toEqual(['The call practice sc', 'The kit check list h']);
  });

  it('a change run says what changed and offers nothing', async () => {
    const r = rig();
    r.brain.agentStart();
    await r.brain.agentFinish('I made the headline 96 px and broke it after Borrow.\n<say>The headline is bigger now, on two lines.</say>', true);
    expect(r.said.map((s) => s.text)).toEqual(['The headline is bigger now, on two lines.']);
  });

  it('hands the talking layer the whole answer when the agent led with what it left alone', async () => {
    const asked: PersonaRequest[] = [];
    const persona: Persona = async (req) => { asked.push(req); return req.kind === 'result' ? 'It likes it overall. Top fix: the scenario screen needs hands-free steps, and the facts disagree.' : null; };
    const r = rig(persona);
    r.brain.agentStart();
    await r.brain.agentFinish('Review:\n- One.\n- The kit check list has no progress state.\n<say>That was a review, so I left the design as it was. Looks good.</say>', true);
    const result = asked.find((q) => q.kind === 'result')!;
    expect(result.agent).toContain('kit check list');
    expect(r.said[0]!.text).toMatch(/^It likes it overall/);
  });

  it('tells the rest from what it kept, a few points at a time, without asking the agent again or repeating', async () => {
    const r = rig();
    r.brain.agentStart();
    await r.brain.agentFinish(REVIEW, true);
    const before = r.said.length;
    await r.hear('What about the rest that it said?');
    expect(r.sent).toEqual([]);
    const rest = r.said.slice(before).map((s) => s.text).join(' ');
    expect(rest).toMatch(/call practice/);
    expect(rest).toMatch(/kit check/);
    expect(rest).not.toMatch(/scenario screen|asking it/i);
    const after = r.said.length;
    await r.hear('And the rest?');
    expect(r.sent).toEqual([]);
    expect(r.said.slice(after).map((s) => s.text)).toEqual(['That was everything it said.']);
  });

  it('takes a yes to its offer as wanting the rest, and gives the talking layer only the points not told', async () => {
    const asked: PersonaRequest[] = [];
    const persona: Persona = async (req) => { asked.push(req); return req.kind === 'more' ? 'It also says the emergency number sits too low, and the kit check has no progress.' : null; };
    const r = rig(persona);
    r.brain.agentStart();
    await r.brain.agentFinish(REVIEW, true);
    await r.hear('Yes.');
    expect(r.sent).toEqual([]);
    const more = asked.find((q) => q.kind === 'more')!;
    expect(more.agent).toMatch(/call practice/);
    expect(more.agent).not.toMatch(/scenario screen|strong overall/);
    expect(r.said.at(-1)!.text).toMatch(/emergency number/);
  });

  it('"do the rest" is work, not a question about the answer', async () => {
    const r = rig();
    r.brain.agentStart();
    await r.brain.agentFinish(REVIEW, true);
    await r.hear('Fix the rest of the points too.');
    await r.settle(8000);
    expect(r.sent.join(' ')).toMatch(/Fix the rest/);
  });
});

describe('noise before the brain', () => {
  it('drops sound descriptions, filler, subtitle timings, lone addresses and number marks', () => {
    for (const t of ['*pfff*', '*clap*', '*Sigh*', '*Gasps*', '[Music]', '(laughs)', '♪', '...', '…!', '07 ·', '00:01:02,000 --> 00:01:04,500', 'www.zdf.de', 'https://youtube.com/watch?v=1', '— 3 —']) {
      expect(spokenPart(t), t).toBe('');
      expect(noiseVerdict(t, { ms: 2000 }), t).toBe('empty');
    }
  });

  it('keeps speech around them, times in a sentence, numbers and named sites', () => {
    expect(spokenPart('*Sigh* okay, go on')).toBe('okay, go on');
    for (const t of ['Make it 12:30 on the poster.', '7', 'The meeting is at 3:15.', 'Use bogen.dev as the link', 'So what do you say?']) {
      expect(spokenPart(t), t).toBe(t);
      expect(noiseVerdict(t, { ms: 2000, speechMs: 1500 }), t).toBeNull();
    }
  });

  it('never makes a turn of them', async () => {
    const r = rig();
    for (const t of ['*pfff*', '[Music]', '07 ·']) await r.hear(t);
    expect(r.said).toEqual([]);
    expect(r.sent).toEqual([]);
  });
});

describe('asking for no change', () => {
  it('"without changing anything" is a review, not a change, so it is not nudged', () => {
    expect(asksForChange('Review the v3 value page and suggest what could be improved, without changing anything.')).toBe(false);
    expect(asksForChange('Prüfe die Seite und sag, was besser ginge, ohne etwas zu ändern.')).toBe(false);
    expect(asksForChange('Fix the header without changing the layout.')).toBe(true);
  });
});
