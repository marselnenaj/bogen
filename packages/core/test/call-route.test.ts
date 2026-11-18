import { describe, expect, it } from 'vitest';
import { briefSaid, CallBrain, contextText, openQuestion, parseRoute, personaPrompt, routeByRules, spokenList, type BrainSinks, type CallContext, type CallLogLine, type Persona } from '../src/call-brain.ts';

const SCREEN: CallContext = { file: 'Sprechstunde · Praxis-Website', page: 'Produkt, Porträts', boards: ['Startseite, Desktop', 'Profil Lena Hofer, Desktop', 'Buchung mit Firmenrechnung, Desktop', 'Meine Sprechstunde', 'Profil, Mobil', 'Termin angefragt, Mobil', 'Bauteile, Porträts'] };
const REVIEW = 'Here is my review. The weekdays are wrong and the mobile slots wrap badly. I haven\'t changed anything. Should I fix the dates and the mobile wrapping first?';

function rig(persona: Persona | null = null, language: 'de' | 'en' = 'en', personaRoutes = false) {
  let clock = 0;
  const out = { say: [] as { text: string; kind: string }[], send: [] as string[], log: [] as CallLogLine[] };
  const sinks: BrainSinks = {
    say: (text, kind) => out.say.push({ text, kind }),
    send: (text) => out.send.push(briefSaid(text)),
    command: () => {}, stopVoice: () => {}, duck: () => {}, earcon: () => {},
    log: (l) => out.log.push(l),
    screen: () => SCREEN,
  };
  const brain = new CallBrain({ language, now: () => clock, persona, sinks, personaRoutes });
  const turn = async (text: string) => {
    brain.speechStart(); clock += 800; brain.speechEnd(); brain.segment(text, 800);
    // The decision, the quiet time a request is collected in, and the brief that sends it.
    for (let i = 0; i < 6; i++) { clock += 600; brain.tick(); await new Promise((r) => setTimeout(r, 0)); }
  };
  return { brain, out, turn };
}

describe('routing by rules', () => {
  it('answers which design from the screen, without the agent', () => {
    const r = routeByRules('No, which design are we talking about?', SCREEN, 'en');
    expect(r.action).toBe('answer');
    expect(r.say).toContain('Sprechstunde');
    expect(routeByRules('Welche Datei ist das?', SCREEN, 'de')).toMatchObject({ action: 'answer' });
    expect(routeByRules('Which file?', {}, 'en').say).toMatch(/no file/i);
  });

  it('says what is on the page by name, a few at most', () => {
    const r = routeByRules("What's on this page?", SCREEN, 'en');
    expect(r.action).toBe('answer');
    expect(r.say).toMatch(/^7 artboards: Startseite Desktop, Profil Lena Hofer Desktop, Buchung mit Firmenrechnung Desktop and 4 more\.$/);
  });

  it('asks back on a vague request instead of starting a run', () => {
    expect(routeByRules('change something.', SCREEN, 'en')).toMatchObject({ action: 'clarify' });
    expect(routeByRules('Mach mal was.', SCREEN, 'de')).toMatchObject({ action: 'clarify' });
    expect(routeByRules('Change the headline colour.', SCREEN, 'en')).toMatchObject({ action: 'agent' });
  });

  it('a yes to the agent\'s open question goes to the agent; a no is answered here', () => {
    const ctx = { ...SCREEN, pendingQuestion: 'Should I fix the dates first?' };
    expect(routeByRules('Yes, do it.', ctx, 'en')).toMatchObject({ action: 'agent' });
    expect(routeByRules('Nein.', ctx, 'de')).toMatchObject({ action: 'answer' });
  });

  it('answers progress from whether the agent works', () => {
    expect(routeByRules('Are you done?', { working: true }, 'en').say).toMatch(/still/i);
    expect(routeByRules('Bist du fertig?', { working: false }, 'de').say).toMatch(/läuft nichts/);
    expect(routeByRules('Bist du fertig?', { working: false, lastResult: 'Ich habe die Überschrift größer gemacht.' }, 'de')).toMatchObject({ recap: true });
  });
});

describe('pieces', () => {
  it('takes a question as finished, whatever word it ends on', async () => {
    const { endOfTurn } = await import('../src/call-brain.ts');
    expect(endOfTurn('Welches Design meinst du?', 'de')).toBe('complete');
    expect(endOfTurn('Welches Design meinst du', 'de')).toBe('unfinished');
  });

  it('finds the open question or proposal at the end of an answer', () => {
    expect(openQuestion(REVIEW)).toBe('Should I fix the dates and the mobile wrapping first?');
    expect(openQuestion('Tell me which artboard you want, or say "go" and I fix those two first.')).toMatch(/^Tell me/);
    expect(openQuestion('I made the headline bigger.')).toBeNull();
  });

  it('reads the routing JSON, also inside fences or prose', () => {
    expect(parseRoute('```json\n{"action":"clarify","say":"What should change?"}\n```')).toEqual({ action: 'clarify', say: 'What should change?' });
    expect(parseRoute('Sure: {"action": "agent", "say": "On it."}')).toEqual({ action: 'agent', say: 'On it.' });
    expect(parseRoute('{"action":"dance"}')).toBeNull();
    expect(parseRoute('no json')).toBeNull();
  });

  it('lists names the way they are said', () => {
    expect(spokenList(['A'], 'de')).toBe('A');
    expect(spokenList(['A', 'B'], 'de')).toBe('A und B');
    expect(spokenList(['A', 'B', 'C', 'D'], 'en')).toBe('A, B, C and 1 more');
  });

  it('gives the talking layer the screen, the conversation and the open question, and nothing invented', () => {
    const text = contextText({ ...SCREEN, working: false, lastResult: REVIEW, pendingQuestion: 'Should I fix the dates first?', history: [{ who: 'person', text: 'How do you like it?' }] });
    expect(text).toContain('Sprechstunde');
    expect(text).toContain('Startseite, Desktop');
    expect(text).toContain('Open question from the agent');
    expect(text).toContain('Person: How do you like it?');
    const p = personaPrompt({ kind: 'question', language: 'de', said: 'How do you like it?', agent: REVIEW, context: { ...SCREEN } });
    expect(p.user).toContain(REVIEW);
    expect(p.system).toMatch(/never say something changed when the agent says it did not/i);
    expect(personaPrompt({ kind: 'route', language: 'en', said: 'x', context: SCREEN }).system).toMatch(/JSON only/);
  });
});

describe('CallBrain with routing', () => {
  it('answers "which design" itself and starts no run', async () => {
    const r = rig();
    await r.turn('No, which design are we talking about?');
    expect(r.out.send).toEqual([]);
    expect(r.out.say.at(-1)!.text).toContain('Sprechstunde');
  });

  it('asks back on "change something" and starts no run', async () => {
    const r = rig();
    await r.turn('Change something.');
    expect(r.out.send).toEqual([]);
    expect(r.out.say.at(-1)!.text).toMatch(/\?$/);
  });

  it('after the agent asks, "ja" goes to the agent', async () => {
    const r = rig(null, 'de');
    await r.turn('Schau dir das Design an.');
    r.brain.agentStart();
    await r.brain.agentFinish(REVIEW, true);
    expect(r.brain.context().pendingQuestion).toMatch(/fix the dates/);
    await r.turn('Ja.');
    expect(r.out.send).toEqual(['Schau dir das Design an.', 'Ja.']);
  });

  it('with routing by the talking layer on, takes its decision and its words for the acknowledgement', async () => {
    const persona: Persona = async (req) => (req.kind === 'route' ? '{"action":"agent","say":"Okay, I will look at the hero and tell you."}' : 'Done.');
    const r = rig(persona, 'en', true);
    await r.turn('Could you check the hero? How do you like it?');
    await new Promise((x) => setTimeout(x, 0));
    expect(r.out.send).toEqual(['Could you check the hero? How do you like it?']);
    expect(r.out.say.at(-1)).toMatchObject({ kind: 'ack', text: 'Okay, I will look at the hero and tell you.' });
  });

  it('routes by the rules by default: a talking layer that would only answer cannot keep a request from the agent', async () => {
    const asked: string[] = [];
    const persona: Persona = async (req) => { asked.push(req.kind); return req.kind === 'route' ? '{"action":"answer","say":"Sure, sounds good."}' : null; };
    const r = rig(persona);
    await r.turn('Make the headline bigger and put it on two lines.');
    await new Promise((x) => setTimeout(x, 0));
    expect(r.out.send).toEqual(['Make the headline bigger and put it on two lines.']);
    expect(asked).not.toContain('route');
  });

  it('routes a turn at once by default, without waiting for the talking layer', async () => {
    let calls = 0;
    const persona: Persona = (req) => { calls++; return req.kind === 'brief' ? Promise.resolve(null) : new Promise(() => {}); };
    const r = rig(persona);
    r.brain.speechStart(); r.brain.speechEnd(); r.brain.segment('Make the hero full screen.', 800);
    // The acknowledgement is said in the same tick the turn ends in, before any answer from the talking layer.
    for (let i = 0; i < 3; i++) { r.brain.tick(); await new Promise((x) => setTimeout(x, 0)); }
    expect(r.out.say.some((s) => s.kind === 'ack')).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the rules when the talking layer answers nonsense', async () => {
    const persona: Persona = async () => 'I think maybe';
    const r = rig(persona);
    await r.turn('Make the headline bigger.');
    await new Promise((x) => setTimeout(x, 0));
    expect(r.out.send).toEqual(['Make the headline bigger.']);
    expect(r.out.say.at(-1)!.kind).toBe('ack');
  });

  it('retells the last answer for "what did you do", through the talking layer, without a run', async () => {
    const asked: string[] = [];
    const persona: Persona = async (req) => { asked.push(req.kind); return req.kind === 'route' ? '{"action":"agent","say":"x"}' : 'I made the headline bigger.'; };
    const r = rig(persona);
    await r.turn('Make the headline bigger.');
    await new Promise((x) => setTimeout(x, 0));
    r.brain.agentStart();
    await r.brain.agentFinish('I set the headline from 64 to 88 px.', true);
    await r.turn('What did you just do?');
    await new Promise((x) => setTimeout(x, 0));
    expect(r.out.send).toEqual(['Make the headline bigger.']);
    expect(asked.at(-1)).toBe('result');
    expect(r.out.say.at(-1)).toMatchObject({ kind: 'reply', text: 'I made the headline bigger.' });
  });

  it('answers "can you hear me" with the rules\' line, never an echo', async () => {
    const r = rig(async () => 'Can you hear me?');
    await r.turn('Hey, can you hear me?');
    expect(r.out.say.at(-1)!.text).toBe('Yes, I can hear you. What should I change?');
  });

  it('keeps every heard and spoken line for the record, with the route', async () => {
    const r = rig();
    await r.turn('Which file is this?');
    expect(r.out.log.map((l) => [l.who, l.route ?? null])).toEqual([['person', null], ['voice', 'answer']]);
    expect(typeof r.out.log[1]!.ms).toBe('number');
  });
});
