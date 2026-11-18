import { describe, expect, it } from 'vitest';
import { asksForChange, needsNudge, NUDGE } from '../src/run-guard.ts';

// From a real voice call: questions and review requests were nudged into changes nobody asked for.
const notChanges = [
  'Could you check the current design? How do you like it?',
  'No witch design are we talking about.',
  'which design are we talking about',
  'what do you think of the hero',
  'Check the design.',
  'Review this page please',
  'Take a look at the pricing section',
  'give me your feedback on the header',
  'Schau dir das Design an.',
  'Wie findest du die Startseite?',
  'welches Design meinst du',
  'Kannst du das Design prüfen?',
  'was hältst du davon',
  'Nein, über welche Seite reden wir',
];

const changes = [
  'make the headline bigger',
  'change something.',
  'Could you make the heading bigger?',
  'Kannst du das größer machen?',
  'Mach die Überschrift größer.',
  'check the header and fix the spacing',
  'Could you check the cards and make them equal height',
  'Schau dir das an und mach die Abstände gleich.',
  'the hero feels heavy',
  'No, make it bigger',
  'Fix it so that we are aligned with the grid',
];

describe('questions and reviews ask for no change', () => {
  for (const m of notChanges) it(`no change: ${m}`, () => expect(asksForChange(m)).toBe(false));
  for (const m of changes) it(`change: ${m}`, () => expect(asksForChange(m)).toBe(true));

  it('a run that answered a question is never nudged', () => {
    for (const request of notChanges) expect(needsNudge({ request, changed: false, nudged: false })).toBe(false);
  });

  it('a run asked for a change that changed nothing is still nudged once', () => {
    expect(needsNudge({ request: 'make the headline bigger', changed: false, nudged: false })).toBe(true);
    expect(needsNudge({ request: 'make the headline bigger', changed: false, nudged: true })).toBe(false);
  });

  it('the nudge itself tells a run not to change anything for a question or review', () => {
    expect(NUDGE).toMatch(/question/);
    expect(NUDGE).toMatch(/review or opinion, change nothing/);
  });
});
