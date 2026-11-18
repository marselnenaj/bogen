import { describe, expect, it } from 'vitest';
import { classifyRun, requestText } from '../src/run-size.ts';

const size = (prompt: string, more: Partial<Parameters<typeof classifyRun>[0]> = {}) => classifyRun({ prompt, ...more }).size;

describe('the size of a request', () => {
  it('takes one local change of one target as small', () => {
    for (const p of ['Make the headline bigger', 'make the headline on the start page bigger', 'Change the button colour to the brand green', 'More spacing between the cards and the title', 'Fix the empty gap between the "Ready right away" card and the tab bar', 'Fix the typo in the footer', 'Mach die Überschrift größer', 'Mehr Abstand unter dem Titel']) expect(size(p), p).toBe('small');
    expect(size('Fix these defects an independent review found:\n1. The close control moves.\n2. The price overflows.')).toBe('small');
    expect(classifyRun({ prompt: 'Make the headline bigger' }).reason).toBe('one target, a local change');
  });

  it('takes new screens, redesigns, directions and several screens as large', () => {
    for (const p of ['Design a real emergency mode for the app', 'Redo the whole thing from scratch', 'Generate better graphics for the screens on the v3 value page', 'Add better illustrations to the screens', 'Make a brand book for Lindenhof', 'Add a new page for pricing', 'Make the headlines bigger on all screens', 'Create a settings screen', 'Gestalte die Startseite neu', 'In the normal training scenarios, explain the defibrillator topic in more detail: how an AED works and where to find one.']) expect(size(p), p).toBe('large');
    expect(size('Make the headline bigger', { review: 'proposal' })).toBe('large');
    expect(size('Make the headline bigger', { images: 1 })).toBe('large');
    expect(size('Make the headline bigger', { intent: 'new_page' })).toBe('large');
    expect(size('Make these bigger', { selected: 8 })).toBe('large');
  });

  it('counts what is unclear as large', () => {
    for (const p of ['do it', 'change something.', 'Fix the v3 value page based on your review suggestions, including the buttons and the facts across screens.', 'Make it better']) expect(size(p), p).toBe('large');
  });

  it('takes a question or a look as an answer', () => {
    for (const p of ['Could you check the current design? How do you like it?', 'Review the current page and give an opinion on how the design looks.', 'What font is the headline in?', 'Tell me the points from your review of the v3 value page', 'Wie findest du die Seite?']) expect(size(p), p).toBe('answer');
    expect(size('Can you make the headline bigger?')).toBe('small');
    expect(size('Look at the hero', { review: 'critique' })).toBe('answer');
  });

  it("takes the call's hint over the words, and reads a call brief by its goal", () => {
    expect(classifyRun({ prompt: 'do it', hint: 'small' })).toEqual({ size: 'small', reason: "the call's brief says small" });
    const brief = '[Voice call. Prepared by the call\'s voice from what the person said.]\n\nGoal: Make the headline on the start page bigger.\n\nSaid verbatim (speech recognition, may contain errors):\n"make the headline bigger please"';
    expect(requestText(brief)).toBe('Make the headline on the start page bigger.');
    expect(size(brief)).toBe('small');
    expect(requestText('[Voice call.]\n\nSaid verbatim (speech recognition, may contain errors):\n"what do you think of it"')).toBe('what do you think of it');
  });
});
