import { describe, expect, it } from 'vitest';
import { CallBrain, contextText, personaPrompt, type BrainSinks, type Persona, type PersonaRequest } from '../src/call-brain.ts';
import { brandTarget, callPreference, cleanSummary, mergePreference, preferenceLine, wordsFor, type CallPreference } from '../src/call-memory.ts';
import type { CallLanguage } from '../src/speech.ts';

function rig(opts: { persona?: Persona | null; brands?: Record<string, { kind: 'found'; id: string; name: string } | { kind: 'ambiguous'; names: string[] }>; languages?: string[]; spoken?: CallLanguage[]; language?: CallLanguage } = {}) {
  let clock = 0;
  const said: { text: string; kind: string; language: string }[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const kept: CallPreference[] = [];
  const looked: string[] = [];
  const sinks: BrainSinks = {
    say: (text, kind, language) => said.push({ text, kind, language }),
    send: (text) => { sent.push(text); brain.agentStart(); },
    command: () => {}, stopVoice: () => {}, duck: () => {}, earcon: () => {},
    summary: (text) => notes.push(text),
    remember: (p) => kept.push(p),
    findBrand: async (name) => { looked.push(name); return opts.brands?.[name] ?? { kind: 'none' }; },
    setLanguage: (l) => (opts.languages ?? ['de', 'en']).includes(l),
    ...(opts.spoken ? { languages: () => opts.spoken! } : {}),
  };
  const brain: CallBrain = new CallBrain({ language: opts.language ?? 'de', now: () => clock, persona: opts.persona ?? null, sinks });
  const turn = async (text: string) => {
    brain.speechStart(); clock += 900; brain.speechEnd(); brain.segment(text, 900);
    for (let i = 0; i < 24; i++) { clock += 500; brain.tick(); await new Promise((r) => setTimeout(r, 0)); }
  };
  return { brain, said, sent, notes, kept, looked, turn };
}

describe('wishes about how the call talks', () => {
  it('reads length, name, language and wishes for later, and leaves requests for the design alone', () => {
    expect(callPreference('Sprich bitte kürzer.')).toMatchObject({ kind: 'length', value: 'short' });
    expect(callPreference('Fass dich kurz.')).toMatchObject({ kind: 'length', value: 'short' });
    expect(callPreference('Keep it short please')).toMatchObject({ kind: 'length', value: 'short' });
    expect(callPreference('Could you answer in more detail')).toMatchObject({ kind: 'length', value: 'long' });
    expect(callPreference('Nenn mich Sam.')).toMatchObject({ kind: 'name', value: 'Sam' });
    expect(callPreference('Call me Sam')).toMatchObject({ kind: 'name', value: 'Sam' });
    expect(callPreference('Call me when it is done')).toBeNull();
    expect(callPreference('Sprich ab jetzt Englisch mit mir.')).toMatchObject({ kind: 'language', value: 'en' });
    expect(callPreference('Speak German')).toMatchObject({ kind: 'language', value: 'de' });
    expect(callPreference('Sag nicht jedes Mal okay, ab jetzt.')).toMatchObject({ kind: 'other' });
    expect(callPreference('From now on never repeat what I said.')).toMatchObject({ kind: 'other' });
    // The examples the call's settings give.
    expect(callPreference('Keep it short.')).toMatchObject({ kind: 'length', value: 'short' });
    expect(callPreference('From now on, always ask before you start.')).toMatchObject({ kind: 'other' });
    expect(callPreference('Frag ab jetzt immer, bevor du loslegst.')).toMatchObject({ kind: 'other' });
    // The design, or the agent: not a wish about the voice.
    expect(callPreference('Ab jetzt immer blaue Buttons.')).toBeNull();
    expect(callPreference('Mach die Überschrift kürzer.')).toBeNull();
    expect(callPreference('Sag dem Agenten, er soll ab jetzt immer Fable fragen.')).toBeNull();
    expect(callPreference('Mach die Überschrift größer.')).toBeNull();
  });

  it('keeps one length, name and language, and each other wish once', () => {
    let list: CallPreference[] = [];
    list = mergePreference(list, { kind: 'length', value: 'short', text: 'kürzer' });
    list = mergePreference(list, { kind: 'length', value: 'long', text: 'länger' });
    list = mergePreference(list, { kind: 'other', value: '', text: 'Sag nicht okay' });
    list = mergePreference(list, { kind: 'other', value: '', text: 'sag nicht okay!' });
    expect(list.map((p) => p.value || p.text)).toEqual(['long', 'sag nicht okay!']);
    expect(wordsFor(list, 25)).toBe(34);
    expect(wordsFor([], 25)).toBe(25);
    expect(preferenceLine({ kind: 'name', value: 'Sam', text: '' })).toContain('"Sam"');
  });

  it('says "Okay, kürzer", keeps the wish, holds later lines shorter, and sends nothing to the agent', async () => {
    const r = rig();
    await r.turn('Sprich bitte kürzer.');
    expect(r.said.at(-1)!.text).toBe('Okay, kürzer.');
    expect(r.kept).toEqual([{ kind: 'length', value: 'short', text: 'Sprich bitte kürzer.' }]);
    expect(r.sent).toEqual([]);
    await r.turn('Nenn mich Sam.');
    expect(r.said.at(-1)!.text).toBe('Okay, Sam, merke ich mir.');
  });

  it('moves the call to English at once, keeps it only with "ab jetzt", and says when that voice is missing', async () => {
    const r = rig();
    await r.turn('Sprich Englisch mit mir.');
    expect(r.brain.language).toBe('en');
    expect(r.said.at(-1)).toMatchObject({ text: 'Sure, English from here on.', language: 'en' });
    expect(r.kept).toEqual([]);
    const s = rig({ languages: ['de'] });
    await s.turn('Sprich ab jetzt immer Englisch.');
    expect(s.brain.language).toBe('de');
    expect(s.said.at(-1)!.text).toBe('Die englische Stimme ist hier noch nicht geladen.');
    expect(s.kept).toEqual([]);
  });

  it('answers a wish for German in English while the call speaks English only', async () => {
    const r = rig({ spoken: ['en'], language: 'en' });
    await r.turn('Ab jetzt Deutsch bitte.');
    expect(r.brain.language).toBe('en');
    expect(r.said.at(-1)).toMatchObject({ text: 'German is coming soon. Until then I speak English.', language: 'en' });
    expect(r.kept).toEqual([]);
  });

  it('puts the wishes into the talking layer\'s instructions', () => {
    const text = contextText({ preferences: ['Keep every answer very short: one sentence, about ten words.'] });
    expect(text).toContain('How the person wants you to talk');
    expect(text).toContain('very short');
  });
});

describe('brands named in a call', () => {
  it('finds the brand in "nimm die Marke X", "in der Marke X" and "use the X brand"', () => {
    expect(brandTarget('Nimm die Marke Sprechstunde.')).toBe('sprechstunde');
    expect(brandTarget('Mach die Startseite in der Marke Sprechstunde neu.')).toBe('sprechstunde');
    expect(brandTarget('Use the Tomacco brand for this.')).toBe('tomacco');
    expect(brandTarget('Wende die Marke Trauermusik Wien an.')).toBe('trauermusik wien');
    expect(brandTarget('Mach die Marke größer.')).toBeNull();
    expect(brandTarget('Make the logo bigger.')).toBeNull();
  });

  it('sends the request with the brand\'s id, asks which of two, and says when there is none', async () => {
    const r = rig({ brands: { sprechstunde: { kind: 'found', id: 'b1b1b1b1b1', name: 'Sprechstunde' }, trauermusik: { kind: 'ambiguous', names: ['Trauermusik', 'Trauermusik dunkel'] }, 'Trauermusik dunkel': { kind: 'found', id: 'b2b2b2b2b2', name: 'Trauermusik dunkel' } } });
    await r.turn('Nimm die Marke Sprechstunde.');
    expect(r.said.at(-1)!.text).toBe('Okay, mit der Marke „Sprechstunde“.');
    expect(r.sent.length).toBe(1);
    expect(r.sent[0]).toContain('Bogen brand b1b1b1b1b1');
    await r.brain.agentFinish('Done.', true);

    await r.turn('Nimm die Marke Trauermusik.');
    expect(r.said.at(-1)!.text).toBe('Meinst du die Marke „Trauermusik“ oder „Trauermusik dunkel“?');
    expect(r.sent.length).toBe(1);
    await r.turn('Die zweite.');
    expect(r.sent.length).toBe(2);
    expect(r.sent[1]).toContain('Bogen brand b2b2b2b2b2');
    await r.brain.agentFinish('Done.', true);

    await r.turn('Nimm die Marke Hochzeit.');
    expect(r.said.at(-1)!.text).toBe('Eine Marke „hochzeit“ finde ich nicht.');
    expect(r.sent.length).toBe(2);
  });
});

describe('the call\'s notes on itself', () => {
  it('holds notes to two sentences and drops labels and JSON', () => {
    expect(cleanSummary('Notes: "The person wants the header 32 px higher on all pages. Done in Trauermusik. Next the footer."')).toBe('The person wants the header 32 px higher on all pages. Done in Trauermusik.');
    expect(cleanSummary('{"action":"answer"}')).toBe('');
  });

  it('writes notes every few turns while the call is quiet, sends them on, and then only the newest lines go along', async () => {
    const asked: PersonaRequest[] = [];
    const persona: Persona = async (req) => {
      asked.push(req);
      if (req.kind === 'summary') return 'The person tunes the header of Trauermusik Wien. Open: the footer.';
      if (req.kind === 'brief') return null;
      return 'Okay.';
    };
    const r = rig({ persona });
    for (const line of ['Hallo, hörst du mich?', 'Wie heißt die Datei?', 'Was ist auf der Seite?', 'Und was hast du zuletzt gemacht?', 'Wie heißt die Seite?']) await r.turn(line);
    expect(asked.filter((q) => q.kind === 'summary').length).toBe(1);
    expect(r.notes).toEqual(['The person tunes the header of Trauermusik Wien. Open: the footer.']);
    expect(r.brain.notes).toBe(r.notes[0]);
    const ctx = r.brain.context();
    expect(ctx.callSummary).toBe(r.notes[0]);
    expect(ctx.history!.length).toBeLessThanOrEqual(6);
    expect(contextText(ctx)).toContain('Notes on this call so far: The person tunes the header');
    const prompt = personaPrompt({ kind: 'summary', language: 'de', said: '', context: { ...ctx, preferences: ['x'], otherFiles: [{ name: 'Logo' }] } });
    expect(prompt.system).toContain('At most two sentences');
    expect(prompt.user).toContain('Notes so far:');
    expect(prompt.user).not.toContain('Other files');
  });

  it('is busy while a request is being said, so the call does not move away under it', async () => {
    const r = rig();
    r.brain.speechStart();
    expect(r.brain.busy).toBe(true);
    r.brain.speechEnd();
    r.brain.segment('Mach die Überschrift größer', 900);
    expect(r.brain.busy).toBe(true);
  });
});
