import { describe, expect, it } from 'vitest';
import { defaultUiScale, readSettings } from '../src/state/settings.ts';

describe('the default interface size', () => {
  it('starts at 150% on a 4K screen at scale 1', () => {
    expect(defaultUiScale(3840, 1)).toBe(1.5);
    expect(defaultUiScale(3200, 1)).toBe(1.5);
    expect(defaultUiScale(2560, 1.25)).toBe(1.5);
  });

  it('stays at 100% on smaller screens and on screens that already scale', () => {
    expect(defaultUiScale(1920, 1)).toBe(1);
    expect(defaultUiScale(2560, 1)).toBe(1);
    expect(defaultUiScale(1920, 2)).toBe(1); // 4K at scale 2
    expect(defaultUiScale(2560, 1.5)).toBe(1); // 4K at scale 1.5
    expect(defaultUiScale(390, 3)).toBe(1); // a phone
  });
});

describe('a stored interface size', () => {
  it('migrates existing preferences without losing canvas settings or inventing appearance overrides', () => {
    expect(readSettings(JSON.stringify({nudgeSmall:7,wheel:'zoom'}),1).settings).toMatchObject({nudgeSmall:7,wheel:'zoom',appearance:'system',motion:'system'});
    expect(readSettings(JSON.stringify({appearance:'dark',motion:'reduced'}),1).settings).toMatchObject({appearance:'dark',motion:'reduced'});
    expect(readSettings(JSON.stringify({appearance:'invalid',motion:42}),1).settings).toMatchObject({appearance:'system',motion:'system'});
  });
  it('follows the screen when nothing is stored', () => {
    expect(readSettings(null, 1.5)).toMatchObject({ settings: { uiScale: 1.5 }, uiScaleChosen: false });
    expect(readSettings('not json', 1.5).settings.uiScale).toBe(1.5);
  });

  it('follows the screen when other settings are stored but no size was picked', () => {
    const read = readSettings(JSON.stringify({ nudgeBig: 8 }), 1.5);
    expect(read.settings).toMatchObject({ nudgeBig: 8, uiScale: 1.5 });
    expect(read.uiScaleChosen).toBe(false);
  });

  it('keeps a size the person picked, even 100% on a large screen', () => {
    expect(readSettings(JSON.stringify({ uiScale: 1, uiScaleChosen: true }), 1.5)).toMatchObject({ settings: { uiScale: 1 }, uiScaleChosen: true });
    expect(readSettings(JSON.stringify({ uiScale: 2, uiScaleChosen: true }), 1).settings.uiScale).toBe(2);
  });

  it('reads an older save: 1 was written for everyone, anything else was picked', () => {
    expect(readSettings(JSON.stringify({ uiScale: 1, nudgeBig: 10 }), 1.5)).toMatchObject({ settings: { uiScale: 1.5 }, uiScaleChosen: false });
    expect(readSettings(JSON.stringify({ uiScale: 1.25 }), 1.5)).toMatchObject({ settings: { uiScale: 1.25 }, uiScaleChosen: true });
  });
});
