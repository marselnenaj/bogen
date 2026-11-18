import { describe, expect, it } from 'vitest';
import { acknowledgement, callCommand, guessLanguage, narrateTool, speakable, takeSentences, turn, type TurnState } from '../src/speech.ts';

describe('takeSentences', () => {
  it('splits German at sentence ends and keeps abbreviations, ordinals and numbers inside', () => {
    const { sentences } = takeSentences('Am 3. Oktober kommen z. B. 1.250 Leute. Das ist viel! Oder? Dr. Müller sagt ja.', 'de', true);
    expect(sentences).toEqual(['Am 3. Oktober kommen z. B. 1.250 Leute.', 'Das ist viel!', 'Oder?', 'Dr. Müller sagt ja.']);
  });
  it('splits English and keeps e.g. and decimals', () => {
    const { sentences } = takeSentences('Use e.g. 3.5 rem here. It reads better. Done', 'en', true);
    expect(sentences).toEqual(['Use e.g. 3.5 rem here.', 'It reads better.', 'Done']);
  });
  it('holds back an unfinished sentence while text still streams', () => {
    expect(takeSentences('Die Überschrift ist größer. Jetzt mache ich', 'de')).toEqual({ sentences: ['Die Überschrift ist größer.'], rest: ' Jetzt mache ich' });
    expect(takeSentences('Fertig.', 'de')).toEqual({ sentences: [], rest: 'Fertig.' });
  });
  it('keeps closing quotes with their sentence and breaks at blank lines', () => {
    expect(takeSentences('Er sagt „Hallo.“ Dann\n\nNeu', 'de', true).sentences).toEqual(['Er sagt „Hallo.“', 'Dann', 'Neu']);
  });
  it('cuts a very long sentence at a comma so audio starts early', () => {
    const long = `${'word '.repeat(30)}, ${'more '.repeat(40)}end.`;
    const { sentences } = takeSentences(long, 'en', true, 100);
    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.every((s) => s.length <= 110)).toBe(true);
  });
  it('skips pieces with no words', () => {
    expect(takeSentences('... !!! Ok.', 'en', true).sentences).toEqual(['Ok.']);
  });
});

describe('speakable', () => {
  it('drops code, markdown marks and links', () => {
    expect(speakable('Set **padding** to `24px`, see [docs](https://x.y).\n```css\na{}\n```')).toBe('Set padding to 24px, see docs.');
  });
});

describe('callCommand', () => {
  it('knows stop, undo and hang up in German and English', () => {
    expect(callCommand('Stopp!')).toBe('stop');
    expect(callCommand('stop please')).toBe('stop');
    expect(callCommand('Mach das rückgängig.')).toBe('undo');
    expect(callCommand('undo that')).toBe('undo');
    expect(callCommand('Leg auf')).toBe('hangup');
    expect(callCommand('Wie bitte?')).toBe('repeat');
  });
  it('leaves real requests to the agent', () => {
    expect(callCommand('Stopp, mach die Überschrift lieber blau und etwas größer')).toBeNull();
    expect(callCommand('Mach die Überschrift größer')).toBeNull();
  });
});

describe('guessLanguage', () => {
  it('tells German from English', () => {
    expect(guessLanguage('Mach die Überschrift größer', 'en')).toBe('de');
    expect(guessLanguage('Make the headline bigger please', 'de')).toBe('en');
    expect(guessLanguage('OK', 'de')).toBe('de');
  });
});

describe('turn', () => {
  const run = (events: Parameters<typeof turn>[1][], from: TurnState = 'listening') => {
    let s = from;
    const effects = [];
    for (const e of events) { const r = turn(s, e); s = r.state; effects.push(r.effect); }
    return { s, effects };
  };
  it('goes listening, hearing, thinking, speaking, listening', () => {
    const { s, effects } = run([{ t: 'speech-start' }, { t: 'speech-end' }, { t: 'transcribed', empty: false }, { t: 'voice-start' }, { t: 'voice-end', queued: false }]);
    expect(s).toBe('listening');
    expect(effects[1]).toEqual({ transcribe: true });
  });
  it('stops the voice at once when the person speaks over it', () => {
    const r = turn('speaking', { t: 'speech-start' });
    expect(r).toEqual({ state: 'interrupted', effect: { stopVoice: true } });
    expect(turn('interrupted', { t: 'speech-end' })).toEqual({ state: 'thinking', effect: { transcribe: true } });
  });
  it('does not start speaking while the person talks', () => {
    expect(turn('hearing', { t: 'voice-start' })).toEqual({ state: 'hearing', effect: { stopVoice: true } });
  });
  it('keeps speaking while sentences are queued', () => {
    expect(turn('speaking', { t: 'voice-end', queued: true }).state).toBe('speaking');
  });
  it('goes back to listening on an empty transcript, and ignores the mic when muted', () => {
    expect(turn('thinking', { t: 'transcribed', empty: true }).state).toBe('listening');
    expect(turn('muted', { t: 'speech-start' }).state).toBe('muted');
    expect(turn('muted', { t: 'mute', on: false }).state).toBe('listening');
  });
  it('ends for good on hang up', () => {
    expect(turn('speaking', { t: 'hangup' })).toEqual({ state: 'ended', effect: { stopVoice: true } });
    expect(turn('ended', { t: 'speech-start' }).state).toBe('ended');
  });
});

describe('narration', () => {
  it('names the tool in the call language', () => {
    expect(narrateTool('layer_style', 'de', 'Hero headline')).toBe('Ich ändere den Stil an „Hero headline“.');
    expect(narrateTool('layer_style', 'en')).toBe('Changing the style.');
    expect(narrateTool('layer_tree', 'en')).toBeNull();
    expect(acknowledgement('de', 1)).toBe('Alles klar.');
  });
});
