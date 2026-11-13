import { describe, expect, it } from 'vitest';
import { heldLine, keptMentions, pickerQuery, proposalVariation, raceVariation, splitHint } from '../src/panels/chat-extras-state.ts';

describe('the / and @ menu', () => {
  it('opens for the word at the caret, after a space or at the start', () => {
    expect(pickerQuery('/web', 4)).toEqual({ trigger: '/', query: 'web', start: 0 });
    expect(pickerQuery('Make @her', 9)).toEqual({ trigger: '@', query: 'her', start: 5 });
    expect(pickerQuery('Make @', 6)).toEqual({ trigger: '@', query: '', start: 5 });
    // Not in the middle of a word, an address or a path, and not once the word is done.
    expect(pickerQuery('mail me@example', 15)).toBeNull();
    expect(pickerQuery('src/app', 7)).toBeNull();
    expect(pickerQuery('@Hero title ', 12)).toBeNull();
    expect(pickerQuery('/web and more', 4)).toEqual({ trigger: '/', query: 'web', start: 0 });
  });

  it('keeps only the mentions still in the message', () => {
    const list = [{ kind: 'layer' as const, id: 'a', name: 'Hero title' }, { kind: 'token' as const, id: 'accent', name: '--accent' }];
    expect(keptMentions('Make @Hero title bigger', list)).toEqual([list[0]]);
    expect(keptMentions('Use @--accent', list)).toEqual([list[1]]);
  });
});

describe('the range and aspects', () => {
  it('sends nothing for Propose as it starts, and what was set otherwise', () => {
    expect(proposalVariation({ count: 1, range: 'explore', vary: [], split: false })).toBeUndefined();
    expect(proposalVariation({ count: 3, range: 'refine', vary: ['layout'], split: false })).toEqual({ count: 3, range: 'refine', vary: ['layout'] });
    expect(raceVariation({ count: 1, range: 'explore', vary: [], split: false })).toEqual({});
    expect(raceVariation({ count: 1, range: 'reimagine', vary: [], split: true })).toEqual({ range: 'reimagine', split: true });
  });

  it('says what is held, and which sections each run takes', () => {
    expect(heldLine(['layout'])).toBe('Varies: Layout. Holds: Colour, Type, and Copy.');
    expect(heldLine([])).toMatch(/^Varies anything/);
    expect(splitHint(['Hero', 'Features', 'Pricing', 'Footer'], 3)).toBe('Run 1: Hero, Features. Run 2: Pricing. Run 3: Footer.');
    expect(splitHint(['Hero'], 2)).toMatch(/at least 2 sections/);
  });
});
