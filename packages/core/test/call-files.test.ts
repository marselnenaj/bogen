import { describe, expect, it } from 'vitest';
import { CallBrain, pickName, routeByRules, switchTarget, type BrainSinks, type SwitchResult } from '../src/call-brain.ts';

const FILES = ['Trauermusik Wien · Website', 'Trauermusik Wien · Logo'];

function rig(resolve: (target: string) => SwitchResult) {
  let clock = 0;
  const said: { text: string; kind: string }[] = [];
  const sent: string[] = [];
  const asked: string[] = [];
  let focus = 'Sprechstunde';
  const sinks: BrainSinks = {
    say: (text, kind) => said.push({ text, kind }),
    send: (text) => { sent.push(`${focus}: ${text}`); brain.agentStart(); },
    steer: (text) => sent.push(`steer ${focus}: ${text}`),
    command: () => {}, stopVoice: () => {}, duck: () => {}, earcon: () => {},
    switchTo: async (target) => {
      asked.push(target);
      const r = resolve(target);
      if (r.kind === 'switched') { const from = focus; focus = r.name; brain.refocus(r.name, from); }
      return r;
    },
  };
  const brain: CallBrain = new CallBrain({ language: 'de', now: () => clock, persona: null, sinks });
  const turn = async (text: string) => {
    brain.speechStart(); clock += 900; brain.speechEnd(); brain.segment(text, 900);
    for (let i = 0; i < 24; i++) { clock += 500; brain.tick(); await new Promise((r) => setTimeout(r, 0)); }
  };
  return { brain, said, sent, asked, turn, focus: () => focus };
}

describe('switching files in a call', () => {
  it('takes "lass uns an X weitermachen", "mach die Datei vom X auf" and "switch to X" as a switch, not as work', () => {
    expect(switchTarget('Lass uns an der Trauermusik-Website weitermachen.')).toBe('trauermusik website');
    expect(switchTarget('Mach die Datei vom Logo auf.')).toBe('logo');
    expect(switchTarget("Let's work on the logo.")).toBe('logo');
    expect(switchTarget('Lass uns an dieser Datei hier weitermachen.')).toBe('here');
    expect(switchTarget('Mach die Überschrift größer.')).toBeNull();
    expect(switchTarget('Öffne das Menü.')).toBeNull();
    expect(routeByRules('Wechsel zu Trauermusik.', {}, 'de')).toMatchObject({ action: 'switch', target: 'trauermusik' });
  });

  it('asks which of two, and the next words pick one; the next request goes to that file', async () => {
    const r = rig((t) => (t === 'trauermusik' ? { kind: 'ambiguous', names: FILES } : FILES.includes(t) ? { kind: 'switched', name: t } : { kind: 'none' }));
    await r.turn('Lass uns an der Trauermusik weitermachen.');
    expect(r.said.at(-1)!.text).toBe('Meinst du „Trauermusik Wien · Website“ oder „Trauermusik Wien · Logo“?');
    await r.turn('Die Website.');
    expect(r.asked.at(-1)).toBe('Trauermusik Wien · Website');
    expect(r.said.at(-1)!.text).toBe('Okay, wir sind jetzt bei Trauermusik Wien Website.');
    expect(r.sent).toEqual([]);
    await r.turn('Mach die Überschrift auf der Startseite größer.');
    expect(r.sent.length).toBe(1);
    expect(r.sent[0]).toMatch(/^Trauermusik Wien · Website: /);
  });

  it('says it cannot find an unknown name, and starts nothing', async () => {
    const r = rig(() => ({ kind: 'none' }));
    await r.turn('Lass uns an den Hochzeitsfotos weitermachen.');
    expect(r.said.at(-1)!.text).toBe('Eine Datei „hochzeitsfotos“ finde ich nicht.');
    expect(r.sent).toEqual([]);
    expect(r.focus()).toBe('Sprechstunde');
  });

  it('a switch while the agent works leaves that run alone, queues the new request, and names the old file at the end', async () => {
    const r = rig((t) => (t === 'logo' ? { kind: 'switched', name: 'Trauermusik Wien · Logo' } : { kind: 'none' }));
    await r.turn('Mach die Überschrift größer.');
    expect(r.brain.agentRunning).toBe(true);
    await r.turn('Mach die Datei vom Logo auf.');
    expect(r.said.at(-1)!.text).toBe('Okay, jetzt Trauermusik Wien Logo. Sprechstunde läuft noch fertig.');
    await r.turn('Mach das Zeichen etwas dunkler.');
    // Not a change to the run in Sprechstunde: it waits for that run.
    expect(r.sent.filter((s) => s.startsWith('steer'))).toEqual([]);
    expect(r.said.at(-1)!.text).toBe('Erst läuft noch „Sprechstunde“, das kommt danach.');
    await r.brain.agentFinish('Die Überschrift ist jetzt 64 px groß.', true);
    expect(r.said.some((l) => l.text === 'Zu Sprechstunde:')).toBe(true);
    // Then the queued request goes, in the file the call is in now.
    await r.turn('');
    expect(r.sent.at(-1)).toMatch(/^Trauermusik Wien · Logo: /);
  });

  it('back in the file the run works in, a change goes to that run again instead of waiting for it', async () => {
    const r = rig((t) => (t === 'logo' ? { kind: 'switched', name: 'Trauermusik Wien · Logo' } : t === 'sprechstunde' ? { kind: 'switched', name: 'Sprechstunde' } : { kind: 'none' }));
    await r.turn('Mach die Überschrift größer.');
    expect(r.brain.agentRunning).toBe(true);
    await r.turn('Mach die Datei vom Logo auf.');
    await r.turn('Lass uns an der Sprechstunde weitermachen.');
    expect(r.focus()).toBe('Sprechstunde');
    await r.turn('Mach die Überschrift noch etwas größer.');
    expect(r.said.some((l) => /Erst läuft noch/.test(l.text) && l.text.includes('Sprechstunde'))).toBe(false);
    expect(r.sent.filter((s) => s.startsWith('steer Sprechstunde: ')).length).toBe(1);
    // One request, one run: the change went to the run going on, and nothing new was started for it.
    expect(r.sent.filter((s) => !s.startsWith('steer')).length).toBe(1);
  });

  it('picks by order or by a word only one name has', () => {
    expect(pickName('die erste', FILES)).toBe(FILES[0]);
    expect(pickName('the second one', FILES)).toBe(FILES[1]);
    expect(pickName('Logo', FILES)).toBe(FILES[1]);
    expect(pickName('Trauermusik', FILES)).toBeNull();
  });
});
