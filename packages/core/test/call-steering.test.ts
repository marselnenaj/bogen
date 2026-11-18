import { describe, expect, it } from 'vitest';
import { briefSaid, CallBrain, gist, progressLine, routeByRules, ruleLine, steerMessage, type BrainSinks, type CallLogLine, type Persona } from '../src/call-brain.ts';
import { isEcho, isMadeUpLine, noiseVerdict, spokenPart } from '../src/call-noise.ts';

function rig(persona: Persona | null = null, language: 'de' | 'en' = 'en', withSteer = true, personaRoutes = false) {
  let clock = 0;
  const log: { say: { text: string; kind: string; at: number }[]; send: string[]; steer: { text: string; at: number }[]; lines: CallLogLine[]; earcons: number } = { say: [], send: [], steer: [], lines: [], earcons: 0 };
  const sinks: BrainSinks = {
    say: (text, kind) => log.say.push({ text, kind, at: clock }),
    send: (text) => log.send.push(briefSaid(text)),
    ...(withSteer ? { steer: (text: string) => { log.steer.push({ text: briefSaid(text), at: clock }); } } : {}),
    command: () => undefined,
    stopVoice: () => undefined,
    duck: () => undefined,
    earcon: () => { log.earcons++; },
    log: (l) => log.lines.push(l),
  };
  const brain = new CallBrain({ language, now: () => clock, persona, sinks, personaRoutes });
  const at = (ms: number) => { while (clock < ms) { clock = Math.min(ms, clock + 20); brain.tick(); } };
  const say = async (text: string, ms = 1500, meta: Parameters<CallBrain['segment']>[2] = { speechMs: 1200 }) => {
    brain.speechStart(); at(clock + ms); brain.speechEnd();
    brain.segment(text, ms, meta);
    // The decision, then the quiet time a request or a change is collected in, then the brief that sends it.
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 0)); at(clock + 500); }
  };
  return { brain, log, at, say, get clock() { return clock; } };
}

/** A real call of 16 Nov 2026, in order, while a run was going. */
const LIVE = [
  'Not just classy, more modern, like full screen. 3D animations like a VC funded company.',
  'Great, so just work in the file and I\'m gonna look at you. You can also use Fable as an advisor for design choices.',
  'Keep updating me here and there.',
];

describe('steering a running agent', () => {
  it('passes refinements to the running agent at once, with a different line each time', async () => {
    const r = rig();
    await r.say('Make the design more classy.');
    expect(r.log.send).toHaveLength(1);
    r.brain.agentStart();
    const before = r.log.say.length;
    for (const line of LIVE.slice(0, 2)) await r.say(line);
    expect(r.log.steer.map((s) => s.text)).toEqual(LIVE.slice(0, 2));
    const spoken = r.log.say.slice(before).map((s) => s.text);
    expect(spoken).not.toContain('Noted, I will do that next.');
    expect(spoken[0]).not.toBe(spoken[1]);
    // The person's words are not read back to them (in a call of 17 Nov that turned "what's up?" into a task, out loud).
    expect(spoken[0]!.toLowerCase()).not.toContain('more modern');
  });

  it('reaches the agent once the person has been quiet for about 3 s', async () => {
    const r = rig();
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    const ended = r.clock + 1500;
    await r.say(LIVE[0]!);
    expect(r.log.steer[0]!.at - ended).toBeLessThanOrEqual(3600);
  });

  it('says nothing for the run it stopped to take the change, and speaks the next run\'s result', async () => {
    const r = rig();
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    await r.say(LIVE[0]!);
    const n = r.log.say.length;
    await r.brain.agentFinish('Stopped.', true);
    expect(r.log.say.length).toBe(n);
    r.brain.agentStart();
    await r.brain.agentFinish('I made it full screen and added a 3D hero.', true);
    expect(r.log.say.at(-1)!.kind).toBe('result');
  });

  it('keeps a task meant for after, and sends it when the run ends', async () => {
    const r = rig();
    await r.say('Make the headline bigger.');
    r.brain.agentStart();
    await r.say('After that, make a mobile version too.');
    expect(r.log.steer).toHaveLength(0);
    expect(r.log.say.at(-1)!.kind).toBe('queued');
    expect(r.log.say.at(-1)!.text.toLowerCase()).not.toContain('mobile version');
    await r.brain.agentFinish('Done, the headline is 96 px now.', true);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.log.send.at(-1)).toBe('After that, make a mobile version too.');
    expect(r.log.say.at(-1)!.text).toMatch(/^(Now the next thing you asked for|On to what you asked for earlier)\./);
  });

  it('queues instead when the call cannot steer', async () => {
    const r = rig(null, 'en', false);
    await r.say('Make the headline bigger.');
    r.brain.agentStart();
    await r.say('Make it red too.');
    expect(r.log.say.at(-1)!.kind).toBe('queued');
  });

  it('sends a request made when idle as a new run, not as steering', async () => {
    const r = rig();
    await r.say('Make the headline bigger.');
    expect(r.log.send).toEqual(['Make the headline bigger.']);
    expect(r.log.steer).toHaveLength(0);
  });

  it('steers by the rules by default, whatever the talking layer would decide', async () => {
    const persona: Persona = async (req) => (req.kind === 'route' ? JSON.stringify({ action: 'answer', say: 'Nice!' }) : null);
    const r = rig(persona);
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    await r.say(LIVE[0]!);
    r.at(r.clock + 4000);
    expect(r.log.steer.length).toBeGreaterThanOrEqual(1);
    expect(r.log.steer.map((s) => s.text).join(' ')).toMatch(/full screen/);
  });

  it('with routing by the talking layer on, uses its steer line and decision', async () => {
    const persona: Persona = async (req) => (req.kind !== 'route' ? null : req.context?.working
      ? JSON.stringify({ action: 'steer', say: 'Got it, I will tell it: more modern, full screen, with 3D motion.' })
      : JSON.stringify({ action: 'agent', say: 'Okay, making it more classy.' }));
    const r = rig(persona, 'en', true, true);
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    await r.say(LIVE[0]!);
    expect(r.log.say.at(-1)).toMatchObject({ kind: 'steer', text: 'Got it, I will tell it: more modern, full screen, with 3D motion.' });
    expect(r.log.steer).toHaveLength(1);
  });

  it('never says the same acknowledgement twice in a row, even when the talking layer repeats itself', async () => {
    const persona: Persona = async (req) => (req.kind === 'route' ? JSON.stringify({ action: 'steer', say: 'Okay, passing it on.' }) : null);
    const r = rig(persona, 'en', true, true);
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    for (const line of ['More modern please.', 'Full screen hero.', 'Add 3D motion.']) await r.say(line);
    const lines = r.log.say.filter((s) => s.kind === 'steer').map((s) => s.text);
    for (let i = 1; i < lines.length; i++) expect(lines[i]).not.toBe(lines[i - 1]);
  });
});

describe('the voice itself: keep me updated, be quiet', () => {
  it('turns on progress updates and gives one about every 50 s from the agent\'s activity', async () => {
    const r = rig();
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    await r.say(LIVE[2]!);
    expect(r.brain.updatesOn).toBe(true);
    expect(r.log.steer).toHaveLength(0);
    expect(r.log.say.at(-1)!.kind).toBe('voice');
    r.brain.agentActivity('tool:html_write');
    r.at(r.clock + 49_000);
    expect(r.log.say.filter((s) => s.kind === 'progress')).toHaveLength(0);
    r.at(r.clock + 2_000);
    await new Promise((res) => setTimeout(res, 0));
    const updates = r.log.say.filter((s) => s.kind === 'progress');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.text).toBe('Still on it, it is building the layers now.');
    // No earcon instead of words while updates are on.
    expect(r.log.earcons).toBe(0);
  });

  it('stops the updates when asked', async () => {
    const r = rig();
    r.brain.agentStart();
    await r.say('Keep me updated.');
    await r.say('Be quiet now.');
    expect(r.brain.updatesOn).toBe(false);
    r.brain.agentActivity('tool:design_lint');
    r.at(r.clock + 120_000);
    expect(r.log.say.filter((s) => s.kind === 'progress')).toHaveLength(0);
  });

  it('hears it in German too', () => {
    expect(routeByRules('Halt mich auf dem Laufenden.', { working: true }, 'de')).toMatchObject({ action: 'voice', updates: true });
    expect(routeByRules('Sei mal still.', { working: true }, 'de')).toMatchObject({ action: 'voice', updates: false });
    expect(routeByRules('Danach bitte noch eine mobile Version.', { working: true }, 'de').action).toBe('queue');
    expect(routeByRules('Nimm Fable als Berater.', { working: true }, 'de').action).toBe('steer');
  });

  it('routes the live exchanges as the person meant them', () => {
    expect(routeByRules(LIVE[0]!, { working: true }, 'en').action).toBe('steer');
    expect(routeByRules(LIVE[1]!, { working: true }, 'en').action).toBe('steer');
    expect(routeByRules(LIVE[2]!, { working: true }, 'en')).toMatchObject({ action: 'voice', updates: true });
  });
});

describe('words for steering', () => {
  it('takes the gist of what was said', () => {
    expect(gist('Great, so just use Fable as an advisor for design choices. Thanks.')).toBe('just use Fable as an advisor for design choices');
    expect(gist("Great, so just work in the file and I'm gonna look at you. You can also use Fable as an advisor for design choices.")).toBe('you can also use Fable as an advisor for design choices');
    expect(gist('Okay, more modern, like full screen, with lots of 3D animations everywhere please')).toBe('more modern, like full screen, with lots of 3D animations everywhere please');
    // The rules' acknowledgements never quote the person: the talking layer names what it understood in its own words.
    expect(ruleLine('steer', 'en', 'Make it more modern.', 0)).toBe('Got it, I will pass that on.');
    expect(ruleLine('queued', 'de', 'Danach eine mobile Version.', 1)).toBe('Okay, das mache ich als Nächstes.');
  });

  it('says what a tool means', () => {
    expect(progressLine('tool:canvas_screenshot', 'en')).toBe('Still on it, it is looking at the result now.');
    expect(progressLine('tool:design_review', 'de')).toBe('Ich bin noch dran, gerade prüft es das Design.');
    expect(progressLine('I am adding a hero', 'en')).toBe('Still on it.');
  });

  it('tells the agent to go on from where the file is', () => {
    expect(steerMessage('more modern, full screen', 'en')).toContain('carry on from where the file is now');
    expect(steerMessage('moderner', 'de')).toContain('mach dort weiter');
  });
});

describe('noise is not a turn', () => {
  it('knows Whisper\'s made-up lines and markup for non-speech', () => {
    for (const t of ['Thank you.', 'Thanks for watching!', 'Untertitel im Auftrag des ZDF, 2020', 'Vielen Dank.', 'you', 'Bye.', '...', '*Fighting* *Fighting*', '[Music]', '♪', 'Thank you. Thank you.']) expect(isMadeUpLine(t)).toBe(true);
    for (const t of ['Thank you, now make it blue.', 'Make the headline bigger.']) expect(isMadeUpLine(t)).toBe(false);
    expect(spokenPart('*Fighting* *Fighting*')).toBe('');
  });

  it('drops a stretch with no speech, and a made-up line with little speech behind it, but keeps a real thank you', () => {
    expect(noiseVerdict('Thank you.', { ms: 2000, speechMs: 0 })).toBe('no-speech');
    expect(noiseVerdict('Thank you.', { ms: 700 })).toBe('made-up');
    expect(noiseVerdict('Thank you.', { ms: 1600, speechMs: 1100 })).toBeNull();
    expect(noiseVerdict('Make it bigger.', { ms: 1200, speechMs: 900 })).toBeNull();
  });

  it('knows the voice heard back', () => {
    const recent = [{ text: 'Got it, passing that on: make it more modern.', at: 0 }];
    expect(isEcho('passing that on, make it more modern', recent, 3000)).toBe(true);
    expect(isEcho('No, not more modern, more classic.', recent, 3000)).toBe(false);
    expect(isEcho('passing that on, make it more modern', recent, 60_000)).toBe(false);
  });

  it('does not answer noise, and keeps it in the record as noise', async () => {
    const r = rig();
    await r.say('Thank you.', 2000, { speechMs: 0, engine: 'whisper-gpu' });
    await r.say('Thank you.', 600, {});
    expect(r.log.say).toHaveLength(0);
    expect(r.log.lines.filter((l) => l.kind === 'noise').map((l) => l.reason)).toEqual(['no-speech', 'made-up']);
    expect(r.log.lines[0]!.engine).toBe('whisper-gpu');
  });

  it('does not take its own voice for the person', async () => {
    const r = rig();
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    await r.say('More modern, full screen.');
    const said = r.log.say.at(-1)!.text;
    const steers = r.log.steer.length;
    // The voice comes back while it plays.
    r.brain.voiceStart();
    await r.say(said, 2000, { speechMs: 1500 });
    expect(r.log.steer.length).toBe(steers);
    expect(r.log.lines.at(-1)).toMatchObject({ kind: 'noise', reason: 'echo' });
  });

  it('logs which engine heard a real turn', async () => {
    const r = rig();
    await r.say('Make the headline bigger.', 1500, { speechMs: 1200, engine: 'whisper-gpu' });
    expect(r.log.lines.find((l) => l.who === 'person')).toMatchObject({ engine: 'whisper-gpu' });
  });
});

describe('call settings said while the agent works', () => {
  it('"Keep narrating what the agent is doing" turns updates on and never stops the run', async () => {
    const r = rig();
    await r.say('Make the design more classy.');
    r.brain.agentStart();
    await r.say('Keep narrating what the agent is doing.');
    r.at(r.clock + 4000);
    expect(r.log.steer).toHaveLength(0);
    expect(routeByRules('Keep narrating what the agent is doing.', { working: true }, 'en').action).toBe('voice');
    expect(routeByRules('Keep me updated and make the hero full screen.', { working: true }, 'en').action).not.toBe('voice');
  });
});
