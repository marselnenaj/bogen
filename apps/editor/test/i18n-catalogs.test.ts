import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCatalog } from '../../../scripts/i18n/check.ts';
import { extract, sourceCatalog } from '../../../scripts/i18n/extract.ts';
import { LANGUAGE_CODES } from '../src/i18n/registry.ts';

const x = extract();
const source = sourceCatalog(x.messages);
const total = Object.keys(source).length;
const LOCALES = join(import.meta.dirname, '../src/i18n/locales');
const codes = LANGUAGE_CODES.filter((c) => c !== 'en');
/**
 * The share of messages a catalog may leave as the English. Filipino software keeps many design terms in English
 * (layer, frame, padding, opacity), as Filipino designers say them, so its catalog legitimately keeps more.
 */
const SAME_AS_ENGLISH_LIMIT: Record<string, number> = { fil: 0.12 };

describe('the interface messages', () => {
  it('are found in the source, without contradictions', () => {
    expect(total).toBeGreaterThan(1500);
    expect(x.problems).toEqual([]);
  });

  it('match the committed English inventory (node scripts/i18n/audit.ts --write-source)', () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dirname, '../src/i18n/source.json'), 'utf8'));
    expect(committed).toEqual(source);
  });
});

describe.each(codes)('the %s catalog', (code) => {
  const path = join(LOCALES, `${code}.json`);
  const catalog = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const report = checkCatalog(code, catalog, source);

  it('exists, and keeps every rule: known keys, the same placeholders, the language\'s plural forms', () => {
    expect(catalog).not.toBeNull();
    expect(report.errors).toEqual([]);
  });

  it('translates every message', () => {
    expect(report.missing).toEqual([]);
  });

  it('is a translation, not a copy of the English', () => {
    // Names and technical terms are left out of the count already; a few short words may honestly be the same.
    expect(report.sameAsEnglish.length / total).toBeLessThan(SAME_AS_ENGLISH_LIMIT[code] ?? 0.05);
  });
});
