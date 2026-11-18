import { describe, expect, it } from 'vitest';
import { asksForWork, briefMessage, briefSaid, CallBrain, isCorrection, needsReadBack, parseBrief, sayTag, stripSayTags, type BrainSinks, type Persona, type SendMeta } from '../src/call-brain.ts';

/**
 * The call as host: what the person says becomes a brief for the agent, never a raw transcript; remarks and thanks
 * never reach the agent; changes said while it works go together, once the person is quiet.
 */
function rig(persona: Persona | null = null, language: 'de' | 'en' = 'en') {
  let clock = 0;
  const log = { say: [] as { text: string; kind: string }[], send: [] as { text: string; meta?: SendMeta }[], steer: [] as { text: string; at: number }[] };
  const sinks: BrainSinks = {
    say: (text, kind) => log.say.push({ text, kind }),
    send: (text, _l, meta) => log.send.push({ text, ...(meta ? { meta } : {}) }),
    steer: (text) => log.steer.push({ text, at: clock }),
    command: () => undefined, stopVoice: () => undefined, duck: () => undefined, earcon: () => undefined,
    screen: () => ({ file: 'Sprechstunde', page: 'Produkt, Porträts' }),
  };
  const brain = new CallBrain({ language, now: () => clock, persona, sinks });
  const at = (ms: number) => { while (clock < ms) { clock = Math.min(ms, clock + 20); brain.tick(); } };
  const say = async (text: string, after = 4000) => {
    brain.speechStart(); at(clock + 1200); brain.speechEnd(); brain.segment(text, 1200, { speechMs: 1000 });
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 0)); at(clock + after / 8); }
  };
  return { brain, log, at, say, get clock() { return clock; } };
}

describe('the brief', () => {
  it('marks the person\'s words as speech recognition and puts the goal first', () => {
    const msg = briefMessage({ said: ['make it way more class and', 'more modern, like full screen'], corrections: [], aside: ['keep updating me'] }, { goal: 'Make the page more modern and full screen.', constraints: ['ask Fable on design choices'] }, 'en');
    expect(msg.split('\n')[0]).toMatch(/^\[Voice call/);
    expect(msg).toMatch(/Goal: Make the page more modern and full screen\./);
    expect(msg).toMatch(/- ask Fable on design choices/);
    expect(msg).toMatch(/speech recognition, may contain errors/);
    expect(msg).toMatch(/Said to the voice since your last turn:\n"keep updating me"/);
    expect(briefSaid(msg)).toBe('make it way more class and more modern, like full screen');
  });

  it('reads the talking layer\'s brief and refuses one without a goal', () => {
    expect(parseBrief('```json\n{"goal":"Make it modern.","constraints":["full screen"]}\n```')).toEqual({ goal: 'Make it modern.', constraints: ['full screen'] });
    expect(parseBrief('{"action":"agent","say":"ok"}')).toBeNull();
    expect(parseBrief('no json')).toBeNull();
  });

  it('knows corrections, work and what to read back', () => {
    expect(isCorrection('No, I said I\'m not happy.')).toBe(true);
    expect(isCorrection('Nein, ich meinte die Überschrift.')).toBe(true);
    expect(isCorrection('Not classy but modern.')).toBe(true);
    expect(isCorrection('Make it bigger.')).toBe(false);
    for (const t of ['Make the headline bigger.', 'Could you check the design? How do you like it?', 'You can also use Fable as an advisor.', 'Mach die Überschrift größer.']) expect(asksForWork(t)).toBe(true);
    for (const t of ['Thank you.', 'What\'s up?', 'Is the agent still working?', 'Alright, alright.', 'Yeah, yeah, yeah.', 'This is not working as it should, it seems, right?']) expect(asksForWork(t)).toBe(false);
    expect(needsReadBack({ said: ['Redo it from scratch.'], corrections: [], aside: [] })).toBe(true);
    expect(needsReadBack({ said: ['Make it red.'], corrections: [], aside: [] })).toBe(false);
    expect(needsReadBack({ said: ['Make it red.', 'and bold'], corrections: [], aside: [] })).toBe(true);
  });

  it('takes the agent\'s <say> block for the voice and leaves its words in the chat', () => {
    const text = 'I changed the hero.\n\n<say>The hero is full screen now. Want motion too?</say>';
    expect(sayTag(text)).toBe('The hero is full screen now. Want motion too?');
    expect(stripSayTags(text)).not.toMatch(/<\/?say>/);
    expect(sayTag('no block')).toBeNull();
  });
});

describe('the call as host', () => {
  it('sends a brief, not the transcript, once the person is quiet', async () => {
    const persona: Persona = async (req) => (req.kind === 'brief' ? '{"goal":"Check the current design and give an opinion.","constraints":[]}' : req.kind === 'route' ? '{"action":"agent","say":"Sure, I will look at it."}' : null);
    const r = rig(persona);
    await r.say('Can you check the current design? How do you like it?');
    expect(r.log.send).toHaveLength(1);
    expect(r.log.send[0]!.text).toMatch(/Goal: Check the current design/);
    expect(r.log.send[0]!.meta).toMatchObject({ title: 'Check the current design and give an opinion.' });
  });

  it('collects a request said in two turns, reads it back, and sends it on yes', async () => {
    const r = rig();
    await r.say('Make the design way more classy.', 1000);
    await r.say('More modern, like full screen.', 4000);
    expect(r.log.send).toHaveLength(0);
    expect(r.log.say.at(-1)).toMatchObject({ kind: 'confirm' });
    await r.say('Yes.');
    expect(r.log.send).toHaveLength(1);
    expect(briefSaid(r.log.send[0]!.text)).toBe('Make the design way more classy. More modern, like full screen.');
  });

  it('starts a read-back request on its own when the person does not say no', async () => {
    const r = rig();
    await r.say('Redo the hero from scratch.', 4000);
    expect(r.log.say.at(-1)).toMatchObject({ kind: 'confirm' });
    expect(r.log.send).toHaveLength(0);
    r.at(r.clock + 6500);
    await new Promise((x) => setTimeout(x, 0));
    expect(r.log.send).toHaveLength(1);
  });

  it('puts a correction into the brief instead of queueing it', async () => {
    const r = rig();
    await r.say('I\'m happy with the overall concept, redo the hero from scratch.', 4000);
    expect(r.log.say.at(-1)).toMatchObject({ kind: 'confirm' });
    await r.say('No, I said I\'m not happy.');
    expect(r.log.send).toHaveLength(0);
    await r.say('Yes, go.');
    expect(r.log.send[0]!.text).toMatch(/Corrections \(they replace what they correct\):\n"No, I said I'm not happy\."/);
  });

  it('says nothing to thanks, and never sends them', async () => {
    const r = rig();
    await r.say('Thank you.');
    await r.say('Thank you.');
    expect(r.log.say).toHaveLength(0);
    expect(r.log.send).toHaveLength(0);
  });

  it('never stops a run for remarks or questions, and answers questions from what it knows', async () => {
    const r = rig();
    await r.say('Redo the hero.');
    r.brain.agentStart();
    for (const t of ['What\'s up?', 'Is the agent still working?', 'Dude.', 'This is not working as it should, it seems, right?']) await r.say(t);
    expect(r.log.steer).toHaveLength(0);
    expect(r.log.say.filter((s) => s.kind === 'reply').length).toBeGreaterThanOrEqual(2);
  });

  it('sends changes said while it works together, after about 3 s of quiet', async () => {
    const r = rig();
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    await r.say('Not just classy, more modern, like full screen.', 1000);
    await r.say('3D animations like a VC funded company.', 1000);
    expect(r.log.steer).toHaveLength(0);
    r.at(r.clock + 3500);
    await new Promise((x) => setTimeout(x, 0));
    expect(r.log.steer).toHaveLength(1);
    expect(briefSaid(r.log.steer[0]!.text)).toBe('Not just classy, more modern, like full screen. 3D animations like a VC funded company.');
    expect(r.log.steer[0]!.text).toMatch(/you were interrupted for it/);
  });

  it('keeps tasks for after as a list, each sent on its own', async () => {
    const r = rig(null, 'en');
    await r.say('Make the headline bigger.');
    r.brain.agentStart();
    await r.say('After that, make a mobile version too.');
    await r.say('Next, add a footer with the address.');
    await r.brain.agentFinish('Done.', true);
    await new Promise((x) => setTimeout(x, 0));
    expect(briefSaid(r.log.send.at(-1)!.text)).toBe('After that, make a mobile version too.');
    r.brain.agentStart();
    await r.brain.agentFinish('Done.', true);
    await new Promise((x) => setTimeout(x, 0));
    expect(briefSaid(r.log.send.at(-1)!.text)).toBe('Next, add a footer with the address.');
  });

  it('speaks the agent\'s <say> block at the end of a run', async () => {
    const r = rig(async () => 'Something else.');
    r.brain.agentStart();
    await r.brain.agentFinish('Long details for the chat.\n<say>The hero is full screen now.</say>', true);
    expect(r.log.say.at(-1)).toMatchObject({ kind: 'result', text: 'The hero is full screen now.' });
  });

  it('does not wait past the ceiling for a turn that sounds unfinished', () => {
    const r = rig();
    for (let i = 0; i < 6; i++) { r.brain.speechStart(); r.at(r.clock + 1500); r.brain.speechEnd(); r.brain.segment('make the hero bigger and', 1500, { speechMs: 1200 }); r.at(r.clock + 600); }
    r.at(r.clock + 3000);
    expect(r.brain.drafting?.said.length ?? r.log.send.length).toBeGreaterThan(0);
  });
});
