import { describe, expect, it } from 'vitest';
import { briefSaid, CallBrain, firstChunk, headerBrief, parseTurn, restAfter, similarity, spokenName, type BrainSinks, type Persona, type PersonaRequest, type SwitchResult } from '../src/call-brain.ts';
import { isEcho } from '../src/call-noise.ts';
import { callPreference } from '../src/call-memory.ts';

/**
 * The call after the review of 17 November 2026: a news budget (nothing said twice, quiet while the agent works),
 * echo told from the person by when a stretch began, the talking layer acting on its action line as it streams (work
 * sent at once with the brief from that line, a stop that stops, a move with its own words), half sentences left
 * alone, and a line talked over marked as not heard.
 */
function rig(answer: (req: PersonaRequest) => string | null, opts: { running?: boolean; instantAck?: boolean } = {}) {
  let clock = 0;
  const log = { say: [] as { text: string; kind: string }[], send: [] as { said: string; text: string; at: number }[], steer: [] as string[], commands: [] as { c: string; quiet?: boolean }[], asks: [] as PersonaRequest[], stops: 0 };
  // Streams like the real one: the text written so far, a few characters at a time.
  const persona: Persona = async (req, _signal, onFirst, onText) => {
    log.asks.push(req);
    const text = answer(req);
    if (text && onText) for (let i = 4; i <= text.length + 3; i += 4) { onText(text.slice(0, i)); await Promise.resolve(); }
    if (text && onFirst) { const f = firstChunk(text); if (f) onFirst(f); }
    return text;
  };
  const sinks: BrainSinks = {
    say: (text, kind) => log.say.push({ text, kind }),
    send: (text) => log.send.push({ said: briefSaid(text), text, at: clock }),
    steer: (text) => log.steer.push(briefSaid(text)),
    command: (c, _l, o) => log.commands.push({ c, ...(o?.quiet ? { quiet: true } : {}) }),
    stopVoice() { log.stops++; }, duck() {}, earcon() {},
    screen: () => ({ file: 'Lindenhof · Bakery orders and pickup', page: 'Produkt', boards: ['Start', 'Profil'] }),
    switchTo: async (target): Promise<SwitchResult> => (/tirava/i.test(target) ? { kind: 'switched', name: 'Tirava · Website' } : { kind: 'none' }),
  };
  const brain = new CallBrain({ language: 'en', now: () => clock, persona, sinks, turnModel: true, ...(opts.instantAck ? { instantAck: true } : {}), timing: { turnTimeoutMs: 400 } });
  if (opts.running) brain.agentStart();
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const turn = async (text: string, during = false) => {
    if (during) brain.voiceStart();
    brain.speechStart(); clock += 900; brain.speechEnd();
    brain.segment(text, 900, { speechMs: 800 });
    for (let i = 0; i < 150; i++) { clock += 20; brain.tick(); if (i % 5 === 0) await flush(); }
    await flush();
  };
  const advance = (ms: number) => { for (let i = 0; i < ms / 20; i++) { clock += 20; brain.tick(); } };
  return { brain, log, turn, advance, now: () => clock };
}

describe('speaking early', () => {
  it('speaks the first sentence, or a clause before a comma once three words stand before it', () => {
    expect(firstChunk('Yes, it is still going, about a minute in.')).toBe('Yes, it is still going,');
    expect(firstChunk('Yes, still at it.')).toBe('Yes, still at it.');
    expect(firstChunk('Hi there. How are')).toBe('Hi there.');
    expect(firstChunk('It left those alone')).toBeNull();
  });

  it('finds the rest after a first piece, apostrophes and all', () => {
    expect(restAfter("We're in Tirava Website, on the start page.", "We're in Tirava Website,")).toBe('on the start page.');
    expect(restAfter('Something else entirely.', "We're in")).toBe('');
  });

  it('names a long file by its first part and a short one whole', () => {
    expect(spokenName('Lindenhof · Bakery orders and pickup')).toBe('Lindenhof');
    expect(spokenName('Tirava · Website')).toBe('Tirava Website');
  });
});

describe('the voice heard back', () => {
  const recent = [{ text: 'Yes, the agent is still working on your request.', at: 0 }];
  it('is never a stretch that began while the voice was quiet, nor a question', () => {
    expect(isEcho('Yes, the agent is still working on your request.', recent, 1000, { duringVoice: false })).toBe(false);
    expect(isEcho('Is the agent working?', recent, 1000)).toBe(false);
  });
  it('is most of a line in its order, not a few of its words', () => {
    expect(isEcho('Yes, the agent is still working on your request.', recent, 1000, { duringVoice: true })).toBe(true);
    expect(isEcho('the agent is working', recent, 1000, { duringVoice: true })).toBe(false);
  });

  it('keeps the person who asks right after the voice, and drops the voice coming back while it plays', async () => {
    const r = rig((req) => (/working/.test(req.said) ? '@answer\nYes, still at it.' : '@listen'), { running: true });
    r.brain.agentActivity('tool:html_write');
    // The voice says its line; the person asks once it has ended.
    await r.turn('Is the agent working?');
    r.brain.voiceStart(); r.brain.voiceEnd();
    const asked = r.log.asks.length;
    await r.turn('Yes, still at it.', true);
    expect(r.log.asks.length).toBe(asked);
  });
});

describe('the news budget', () => {
  it('lets short remarks pass in silence while the agent works, without asking the talking layer', async () => {
    const r = rig(() => '@answer\nThanks, that is kind.', { running: true });
    for (const line of ['Alright.', 'Got it, thanks.', "You're amazing."]) await r.turn(line);
    expect(r.log.asks.filter((a) => a.kind === 'turn')).toHaveLength(0);
    expect(r.log.say).toHaveLength(0);
  });

  it('still answers a doubt or a check of the line while the agent works', async () => {
    const r = rig(() => '@answer\nSorry, what looks wrong?', { running: true });
    await r.turn('That is not correct.');
    await r.turn('Hello.');
    expect(r.log.asks.filter((a) => a.kind === 'turn')).toHaveLength(2);
  });

  it('holds back a line that says again what it just said, unless it answers a question', async () => {
    let n = 0;
    const r = rig(() => (n++ === 0 ? '@answer\nThe agent is still working on the booking card.' : '@answer\nThe agent is still working on the booking card now.'), { running: true });
    await r.turn('What is it doing?');
    await r.turn('Okay so what is happening with the booking card now');
    expect(r.log.say.map((l) => l.text)).toEqual(['The agent is still working on the booking card.']);
  });

  it('tells the talking layer what it already said during the run', async () => {
    const r = rig(() => '@answer\nIt is on the booking card, about a minute in.', { running: true });
    await r.turn('What is it doing?');
    await r.turn('And now?');
    expect(r.log.asks.at(-1)!.context?.toldThisRun?.join(' ')).toMatch(/booking card/);
  });

  it('keeps quiet on thanks for good once the person asks for it', async () => {
    expect(callPreference("You don't need to reply to every thanks.")).toMatchObject({ kind: 'quiet' });
    const r = rig(() => '@answer\nYou are welcome.');
    r.brain.setQuiet(true);
    await r.turn('Thanks.');
    await r.turn('Thank you so much.');
    expect(r.log.say).toHaveLength(0);
  });
});

describe('acting on the action line', () => {
  it('sends clear work with the brief from the action line, without a second call, and quickly', async () => {
    const r = rig(() => '@agent goal: Make the start page headline bigger. | keep: the brand font\nSure, a bigger headline.', { instantAck: true });
    await r.turn('Make the headline on the start page a lot bigger please.');
    expect(r.log.asks.map((a) => a.kind)).toEqual(['turn']);
    expect(r.log.send).toHaveLength(1);
    expect(r.log.send[0]!.text).toMatch(/Goal: Make the start page headline bigger\./);
    expect(r.log.send[0]!.text).toMatch(/- the brand font/);
    // The turn ended at 900 ms; the request went once the person had been quiet for 1.2 s.
    expect(r.log.send[0]!.at).toBeLessThanOrEqual(900 + 1300);
    // The instant "Okay." first, then the talking layer's words without their own "Sure,".
    expect(r.log.say.map((l) => l.text)).toEqual(['Okay.', 'A bigger headline.']);
  });

  it('reads the brief on an action line', () => {
    expect(headerBrief('goal: Redo the file as a magazine | keep: the portraits; the colours')).toEqual({ goal: 'Redo the file as a magazine', constraints: ['the portraits', 'the colours'] });
    expect(parseTurn('@steer goal: Use the brand rules.\nGot it.')).toMatchObject({ action: 'steer', brief: { goal: 'Use the brand rules.', constraints: [] } });
    expect(headerBrief('Tirava · Website')).toBeNull();
  });

  it('stops at once, says its own words, and does not tell the stopped run as a result', async () => {
    const r = rig((req) => (req.kind === 'turn' ? '@stop\nOkay, stopping it.' : 'It changed two screens.'), { running: true });
    await r.turn('Wait, no, stop that, I changed my mind.');
    expect(r.log.commands).toEqual([{ c: 'stop', quiet: true }]);
    await r.brain.agentFinish('Stopped.', true);
    expect(r.log.say.map((l) => l.text)).toEqual(['Okay, stopping it.']);
  });

  it('says its own words once a move to another file worked, and the rules\' line when it did not', async () => {
    const r = rig((req) => (/rave/i.test(req.said) ? '@switch Tirava · Website\nSure, over to Tirava.' : '@switch Nowhere\nSure, over there.'));
    await r.turn("Let's continue with the to rave a website.");
    expect(r.log.say.at(-1)!.text).toBe('Sure, over to Tirava.');
    await r.turn("Let's continue with nowhere.");
    expect(r.log.say.at(-1)!.text).toMatch(/cannot find a file/);
  });

  it('asks one question at a time', async () => {
    const r = rig(() => '@clarify\nThe whole file or one screen? And in what direction?');
    await r.turn('Redo the whole thing.');
    expect(r.log.say.map((l) => l.text).join(' ')).toBe('The whole file or one screen?');
  });
});

describe('half sentences and talking over the voice', () => {
  it('lets a half sentence hang without asking the talking layer, with at most one "Mm?" a minute', async () => {
    const r = rig(() => '@clarify\nCould I what?');
    await r.turn('Could you...');
    await r.turn('What a...');
    expect(r.log.asks).toHaveLength(0);
    expect(r.log.say.map((l) => l.text)).toEqual(['Mm?']);
  });

  it('marks a line the person talked over as cut off', async () => {
    const r = rig(() => '@answer\nIt is on the booking card right now, about a minute in.', { running: true });
    await r.turn('What is it doing?');
    r.brain.voiceStart();
    r.brain.speechStart();
    r.advance(800);
    const context = r.brain.context();
    expect(r.log.stops).toBeGreaterThan(0);
    expect(context.history?.filter((h) => h.who === 'voice').at(-1)?.text).toMatch(/\(cut off\)$/);
  });
});

describe('similarity', () => {
  it('sees the same news in other words, and not in a different answer', () => {
    expect(similarity('The agent is still working on the booking card.', 'Still working on the booking card.')).toBeGreaterThanOrEqual(0.6);
    expect(similarity('Still at it.', 'It changed the headline and the button.')).toBeLessThan(0.6);
  });
});
