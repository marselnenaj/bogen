import { describe, expect, it } from 'vitest';
import { briefSaid, CallBrain, endOfTurn, isBackchannel, ruleLine, shapeSpoken, verbatimRun, wordCount, type BrainSinks, type Persona } from '../src/call-brain.ts';

function rig(persona: Persona | null = null, language: 'de' | 'en' = 'de') {
  let clock = 0;
  const log: { say: { text: string; kind: string; at: number }[]; send: string[]; commands: string[]; stops: number; ducks: boolean[]; earcons: number } = { say: [], send: [], commands: [], stops: 0, ducks: [], earcons: 0 };
  const sinks: BrainSinks = {
    say: (text, kind) => log.say.push({ text, kind, at: clock }),
    send: (text) => log.send.push(briefSaid(text)),
    command: (c) => log.commands.push(c),
    stopVoice: () => { log.stops++; },
    duck: (on) => log.ducks.push(on),
    earcon: () => { log.earcons++; },
  };
  const brain = new CallBrain({ language, now: () => clock, persona, sinks });
  const at = (ms: number) => { while (clock < ms) { clock = Math.min(ms, clock + 20); brain.tick(); } };
  /** Lets the request collected so far go: the quiet time after it, and the promises that send it. */
  const settle = async (ms = 3000) => { for (let i = 0; i < 4; i++) { at(clock + ms / 4); await new Promise((r) => setTimeout(r, 0)); } };
  return { brain, log, at, settle, get clock() { return clock; } };
}

describe('words', () => {
  it('knows a listening sound from a turn', () => {
    for (const t of ['Mhm.', 'ja', 'Okay!', 'Genau', 'uh-huh', 'Yeah, right']) expect(isBackchannel(t)).toBe(true);
    for (const t of ['Ja, mach das größer', 'Okay, make it blue', 'Nein']) expect(isBackchannel(t)).toBe(false);
  });

  it('hears an unfinished turn', () => {
    expect(endOfTurn('Mach die Überschrift größer und', 'de')).toBe('unfinished');
    expect(endOfTurn('Mach die Überschrift größer und.', 'de')).toBe('unfinished');
    expect(endOfTurn('Die Karten auf der Preisseite,', 'de')).toBe('unfinished');
    expect(endOfTurn('Make the headline bigger and', 'en')).toBe('unfinished');
    expect(endOfTurn('Überschrift.', 'de')).toBe('unfinished');
    expect(endOfTurn('Mach die Überschrift größer.', 'de')).toBe('complete');
    expect(endOfTurn('Stopp.', 'de')).toBe('complete');
    expect(endOfTurn('Hallo, hörst du mich?', 'de')).toBe('complete');
  });

  it('shapes text to be heard: no ids, paths, code or colours, units in words, two sentences at most', () => {
    const s = shapeSpoken('**Done.** I set `h7d2k9q4zt` to 96px (was 72px) and saved exports/logo.svg in #2C3EB5 with var(--stamp). It looks great. Also more.', 'de');
    expect(s).not.toMatch(/h7d2k9q4zt|exports|#2C3EB5|--stamp|`|\*/);
    expect(s).toContain('96 Pixel');
    expect(s.split(/[.!?]/).filter((x) => x.trim()).length).toBeLessThanOrEqual(2);
    expect(wordCount(shapeSpoken('word '.repeat(80), 'en'))).toBeLessThanOrEqual(25);
  });

  it('measures how much is copied', () => {
    expect(verbatimRun('The headline is bigger now.', 'I made the headline bigger now and checked it.')).toBe(2);
    expect(verbatimRun('The headline is bigger now.', 'Look: the headline is bigger now, on two lines.')).toBe(5);
  });
});

describe('CallBrain', () => {
  it('acknowledges at once and sends the request once the person is quiet', async () => {
    const r = rig();
    r.brain.speechStart(); r.at(1000); r.brain.speechEnd();
    r.brain.segment('Mach den Button blau.', 1000);
    expect(r.log.send).toEqual([]);
    expect(r.log.say[0]).toMatchObject({ kind: 'ack' });
    await r.settle();
    expect(r.log.send).toEqual(['Mach den Button blau.']);
    expect(wordCount(r.log.say[0]!.text)).toBeLessThanOrEqual(4);
  });

  it('waits through a pause mid-thought and sends one whole turn', async () => {
    const r = rig();
    r.brain.speechStart(); r.at(900); r.brain.speechEnd();
    r.at(1000); r.brain.segment('Mach die Überschrift größer und', 900);
    r.at(1800);
    expect(r.log.send).toEqual([]);
    r.brain.speechStart(); r.at(2800); r.brain.speechEnd();
    r.at(3700); r.brain.segment('setz sie in zwei Zeilen.', 1000);
    await r.settle();
    expect(r.log.send).toEqual(['Mach die Überschrift größer und setz sie in zwei Zeilen.']);
  });

  it('does not end the turn while words are still being written down', async () => {
    const r = rig();
    r.brain.speechStart(); r.at(800); r.brain.speechEnd();
    r.brain.speechStart(); r.at(2000);
    r.brain.segment('Mach die Überschrift', 800);
    r.brain.speechEnd();
    r.at(2500);
    expect(r.log.send).toEqual([]);
    r.brain.segment('größer.', 600);
    await r.settle();
    expect(r.log.send).toEqual(['Mach die Überschrift größer.']);
  });

  it('a "mhm" over the voice only lowers it for a moment', () => {
    const r = rig();
    r.brain.voiceStart();
    r.brain.speechStart(); r.at(300); r.brain.speechEnd();
    r.brain.segment('Mhm.', 300);
    expect(r.log.ducks).toEqual([true, false]);
    expect(r.log.stops).toBe(0);
    expect(r.log.send).toEqual([]);
  });

  it('real words over the voice stop it at once', async () => {
    const r = rig();
    r.brain.voiceStart();
    r.brain.speechStart(); r.at(800);
    expect(r.log.stops).toBe(1);
    r.brain.speechEnd(); r.brain.segment('Nein, warte, nicht so groß.', 1200);
    await r.settle();
    expect(r.log.send).toEqual(['Nein, warte, nicht so groß.']);
  });

  it('is quiet while the agent works, with one soft sound', () => {
    const r = rig();
    r.brain.agentStart();
    r.at(60_000);
    expect(r.log.earcons).toBe(1);
    expect(r.log.say).toEqual([]);
  });

  it('speaks the talking layer\'s short line at the end, never the agent\'s text', async () => {
    const agent = 'I set the hero headline from 72 to 96 px, line-height 1.02, and broke it after Borrow so it reads as two lines.';
    const r = rig(async () => 'Die Überschrift ist jetzt größer und zweizeilig.');
    r.brain.agentStart();
    await r.brain.agentFinish(agent, true);
    expect(r.log.say.at(-1)).toMatchObject({ kind: 'result', text: 'Die Überschrift ist jetzt größer und zweizeilig.' });
  });

  it('falls back to the rules when the talking layer copies the agent, is silent or too slow', async () => {
    const agent = 'I set the hero headline from 72 to 96 px, line-height 1.02, and broke it after Borrow so it reads as two lines.';
    const copy = rig(async () => agent);
    copy.brain.agentStart();
    await copy.brain.agentFinish(agent, true);
    expect([ruleLine('result', 'de', '', 0), ruleLine('result', 'de', '', 1)]).toContain(copy.log.say.at(-1)!.text);

    const slow = new CallBrain({ language: 'en', now: () => 0, persona: () => new Promise(() => undefined), timing: { personaTimeoutMs: 30 }, sinks: { say: (t) => said.push(t), send() {}, command() {}, stopVoice() {}, duck() {}, earcon() {} } });
    const said: string[] = [];
    slow.agentStart();
    await slow.agentFinish('Error: not found', false);
    expect(said).toEqual([ruleLine('error', 'en')]);
  });

  it('keeps a request made while the agent works and sends it after', async () => {
    const r = rig();
    r.brain.agentStart();
    r.brain.speechStart(); r.at(500); r.brain.speechEnd();
    r.brain.segment('Mach das Bild dunkler.', 500);
    expect(r.log.send).toEqual([]);
    expect(r.log.say.at(-1)).toMatchObject({ kind: 'queued' });
    await r.brain.agentFinish('Done.', true);
    await r.settle();
    expect(r.log.send).toEqual(['Mach das Bild dunkler.']);
  });

  it('passes spoken commands on', () => {
    const r = rig();
    r.brain.speechStart(); r.at(400); r.brain.speechEnd();
    r.brain.segment('Stopp.', 400);
    expect(r.log.commands).toEqual(['stop']);
    expect(r.log.send).toEqual([]);
  });
});
