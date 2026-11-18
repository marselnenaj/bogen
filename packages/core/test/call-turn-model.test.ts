import { describe, expect, it } from 'vitest';
import { briefSaid, CallBrain, parseTurn, personaPrompt, ruleLine, type BrainSinks, type Persona, type PersonaRequest, type SwitchResult } from '../src/call-brain.ts';

/**
 * The talking layer decides every turn (`turnModel`), after the user's call of 17 November 2026 on 0.4.0: "What's
 * up?" and "if he's working again" went to the agent as tasks with "Okay, telling it now: what's up", "Is the agent
 * working?" got "Nothing is running" during a run, and a spoken move to another file became a run in the old one.
 */
function rig(answer: (req: PersonaRequest) => string | null | Promise<string | null>, opts: { running?: boolean } = {}) {
  let clock = 0;
  const log = { say: [] as string[], send: [] as string[], steer: [] as string[], commands: [] as string[], switches: [] as string[], asks: [] as PersonaRequest[] };
  const persona: Persona = async (req, _signal, onFirst) => {
    log.asks.push(req);
    const text = await answer(req);
    if (text && onFirst) { const m = /^(.+?[.!?])(\s|$)/s.exec(text); if (m) onFirst(m[1]!); }
    return text;
  };
  const sinks: BrainSinks = {
    say: (text) => log.say.push(text),
    send: (text) => log.send.push(briefSaid(text)),
    steer: (text) => log.steer.push(briefSaid(text)),
    command: (c) => log.commands.push(c),
    stopVoice() {}, duck() {}, earcon() {},
    screen: () => ({ file: 'Sprechstunde', page: 'Produkt', boards: ['Start', 'Profil'] }),
    switchTo: async (target): Promise<SwitchResult> => { log.switches.push(target); return { kind: 'switched', name: target }; },
  };
  const brain = new CallBrain({ language: 'en', now: () => clock, persona, sinks, turnModel: true, timing: { turnTimeoutMs: 200 } });
  if (opts.running) brain.agentStart();
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  const turn = async (text: string) => {
    brain.speechStart(); brain.speechEnd(); brain.segment(text, 900, { speechMs: 800 });
    for (let i = 0; i < 200; i++) { clock += 20; brain.tick(); if (i % 10 === 0) await flush(); }
    await flush();
  };
  const settle = async (ms = 4000) => { for (let i = 0; i < ms / 20; i++) { clock += 20; brain.tick(); if (i % 10 === 0) await flush(); } await flush(); };
  return { brain, log, turn, settle };
}

describe('parseTurn', () => {
  it('reads the action, its argument and the words', () => {
    expect(parseTurn('@answer\nYes, I\'m here.')).toEqual({ action: 'answer', arg: '', say: 'Yes, I\'m here.' });
    expect(parseTurn('@switch Tirava · Website')).toEqual({ action: 'switch', arg: 'Tirava · Website', say: '' });
    expect(parseTurn('@listen')).toMatchObject({ action: 'listen', say: '' });
    expect(parseTurn('```\n@agent\nSure, a bigger headline.\n```')).toMatchObject({ action: 'agent', say: 'Sure, a bigger headline.' });
    expect(parseTurn('Yes, I am here.')).toBeNull();
    expect(parseTurn('@dance\nWhee.')).toBeNull();
  });

  it('does not take a header still being written', () => {
    expect(parseTurn('@switch Sprechstunde v2.1', true)).toBeNull();
    expect(parseTurn('@answer\nYes.', true)).toMatchObject({ action: 'answer' });
  });
});

describe('the talking layer decides every turn', () => {
  it('answers small talk and never hands it to the agent', async () => {
    const r = rig(() => '@answer\nNot much, the agent is still on the booking card.', { running: true });
    await r.turn("So, what's up?");
    await r.settle();
    expect(r.log.say.join(' ')).toMatch(/still on the booking card/);
    expect(r.log.send).toEqual([]);
    expect(r.log.steer).toEqual([]);
    expect(r.log.asks[0]!.kind).toBe('turn');
  });

  it('stays quiet on a fragment', async () => {
    const r = rig(() => '@listen', { running: true });
    await r.turn('Could you... If he\'s working again?');
    await r.settle();
    expect(r.log.say).toEqual([]);
    expect(r.log.steer).toEqual([]);
  });

  it('moves to another file instead of starting a run there', async () => {
    const r = rig(() => '@switch Bogen Brand System');
    await r.turn("Let's continue with the Bogen brand system.");
    await r.settle();
    expect(r.log.switches).toEqual(['Bogen Brand System']);
    expect(r.log.send).toEqual([]);
    expect(r.log.say.join(' ')).toMatch(/Bogen Brand System/);
  });

  it('hands a request to the agent with its own acknowledgement', async () => {
    const r = rig((req) => (req.kind === 'turn' ? '@agent\nSure, a bigger headline on the start page.' : null));
    await r.turn('Make the headline on the start page bigger.');
    await r.settle();
    expect(r.log.say[0]).toBe('Sure, a bigger headline on the start page.');
    expect(r.log.send).toEqual(['Make the headline on the start page bigger.']);
  });

  it('sends the request it asked back about together with the answer', async () => {
    let n = 0;
    const r = rig((req) => (req.kind !== 'turn' ? null : n++ === 0 ? '@clarify\nThe whole file or one screen?' : '@agent\nOkay, the whole file, from scratch.'));
    await r.turn('Redo the whole thing.');
    await r.turn('Everything, all screens, go.');
    // Redoing everything is read back first, then it goes unless the person says no.
    await r.settle(12_000);
    expect(r.log.send).toEqual(['Redo the whole thing. Everything, all screens, go.']);
  });

  it('changes the running task with steer, and stops it on request', async () => {
    const r = rig((req) => (req.kind !== 'turn' ? null : /stop/i.test(req.said) ? '@stop' : '@steer\nGot it, I\'ll tell it to follow the brand rules.'), { running: true });
    await r.turn('Also make sure it follows the brand rules.');
    await r.settle();
    expect(r.log.steer).toEqual(['Also make sure it follows the brand rules.']);
    await r.turn('Wait, no, stop that, I changed my mind.');
    expect(r.log.commands).toEqual(['stop']);
  });

  it('when the talking layer is too slow, does not forward chat and says one short line to a question', async () => {
    const r = rig(() => new Promise(() => undefined), { running: true });
    await r.turn("What's up?");
    await r.settle();
    expect(r.log.steer).toEqual([]);
    expect(r.log.send).toEqual([]);
    expect(r.log.say.join(' ')).not.toMatch(/passing that on|telling it now/i);
  });

  it('tells the talking layer the state it is in', async () => {
    const r = rig(() => '@listen', { running: true });
    await r.turn('Hmm, so, what is going on with it?');
    const { user, system } = personaPrompt(r.log.asks[0]!);
    expect(user).toMatch(/The agent is working on a request right now/);
    expect(system).toMatch(/@switch/);
    expect(system).toMatch(/never tasks for the agent/);
  });
});

describe('rule lines', () => {
  it('never read the person\'s words back', () => {
    for (let n = 0; n < 3; n++) {
      expect(ruleLine('steer', 'en', "what's up", n)).not.toMatch(/what's up/);
      expect(ruleLine('queued', 'en', 'if he is working again', n)).not.toMatch(/working again/);
    }
  });
});
