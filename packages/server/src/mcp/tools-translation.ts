import { z } from 'zod';
import {
  forgetTranslations, languageVersions, LOCALE_STATUSES, memorySize, rememberTranslations, setLocaleStatus, setTranslationRules, translationRules, translationStatus,
  type LocaleStatus,
} from '@bogen/core';
import { syncLanguage } from '../design-branches.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

/**
 * Continuous translation of language versions (translation-memory.ts in @bogen/core). You translate; Bogen remembers
 * what you translated, brings a version up to date with its original, and asks only for text that is new or changed.
 */

const MAX_LISTED = 200;

export function registerTranslationTools(define: ToolDefiner): void {
  define('translation_status', { description: 'The language versions of a file (branches inside it whose design language differs from the original) and, for one, the texts of the original that still need translating: only text that is new or changed since it was last translated, each once however often it appears, with where it is and the older translation as a hint. What the version already translated is learned and never asked for again. Texts the rules keep (brand words, code, addresses, numbers, layers marked translate="no") are left out. Translate the list, then call translation_apply. Reads only.', readOnly: true }, {
    language: z.string().max(40).optional().describe('A language tag such as de, or a branch id. Leave out to list the versions.'),
    file_id: fileIdArg,
  }, async ({ language, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const doc = room.doc;
    const versions = languageVersions(doc).map((v) => ({ branch_id: v.branch.id, name: v.branch.name, language: v.tag, status: v.status, remembered: memorySize(doc, v.tag) }));
    if (!language) {
      return { versions, rules: translationRules(doc), ...(versions.length ? { next: 'translation_status with language for what one version still needs.' } : { note: 'No language versions yet. A run with Add a language version makes one; this file then follows its original with translation_apply.' }) };
    }
    const s = translationStatus(doc, language);
    return {
      branch_id: s.branch.id, name: s.branch.name, language: s.tag, language_name: s.language, dir: s.dir, status: s.status, texts: s.texts, translated: s.translated,
      behind_original: s.behind, rules: s.rules,
      needed: s.needed.slice(0, MAX_LISTED), ...(s.needed.length > MAX_LISTED ? { more_needed: s.needed.length - MAX_LISTED } : {}),
      next: s.status !== 'include'
        ? `This language is ${s.status}: nothing is asked for. The person changes that in the editor, or translation_rules_set.`
        : s.needed.length
          ? `Translate each source into ${s.language} as it reads on the page (meaning, not word for word; keep the words in rules.keep, names, prices and URLs). Then translation_apply with language "${s.tag}" and the pairs.`
          : s.behind ? 'Everything is translated. translation_apply with no pairs brings the version up to date with its original.' : 'Everything is translated and up to date.',
    };
  });

  define('translation_apply', { description: 'Store your translations in the file\'s translation memory and bring the language version up to date with its original: the original\'s new and changed screens and layers come in (the version keeps its own layout fixes), and every text the memory knows is filled in, so unchanged text is never translated twice. Text still unknown shows the original\'s words; translation_status lists it. A commit is taken first, and it is one change the person can undo. Works without checking the version out.' }, {
    language: z.string().max(40).describe('A language tag such as de, or the version\'s branch id.'),
    translations: z.array(z.object({ source: z.string().min(1).max(4000), target: z.string().min(1).max(8000) })).max(2000).default([]).describe('Source text exactly as translation_status gave it, and its translation. A target equal to its source means it stays as it is.'),
    forget: z.array(z.string().max(4000)).max(500).optional().describe('Sources whose remembered translation is wrong and should be asked for again.'),
    sync: z.boolean().default(true).describe('Bring the version up to date now. false only stores the translations.'),
    file_id: fileIdArg,
  }, async ({ language, translations, forget, sync, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const doc = room.doc;
    const status = translationStatus(doc, language);
    const { forgotten, stored } = ctx.write(room, () => ({
      forgotten: forget?.length ? forgetTranslations(doc, status.tag, forget) : 0,
      stored: rememberTranslations(doc, status.tag, translations, ctx.agent),
    }));
    const synced = sync ? await syncLanguage(ctx.app, room, status.branch.id, ctx.agent, 'agent') : null;
    const after = translationStatus(doc, status.tag);
    return {
      branch_id: status.branch.id, name: status.branch.name, language: status.tag, stored, ...(forgotten ? { forgotten } : {}),
      ...(synced ? { filled: synced.filled, learned_from_version: synced.learned, structure_updated: synced.structure } : {}),
      still_needed: after.needed.length,
      next: after.needed.length ? `${after.needed.length} texts still need translating: translation_status language "${status.tag}".` : `The ${after.language} version is up to date. Check longer texts with canvas_screenshot on its branch.`,
    };
  });

  define('translation_rules_set', { description: 'What is never translated, and how a language version takes part. keep: words and phrases that stay as they are in every language, such as brand and product names (replaces the list; code, addresses and numbers are kept by themselves). status for one language: include (translated and kept up to date), untranslated (shows the original\'s words, asks nothing), hidden (left out of translation work, and the pre-publish check warns before it is published). Only when the person asked.' }, {
    keep: z.array(z.string().min(1).max(120)).max(200).optional(),
    language: z.string().max(40).optional().describe('The language whose status to set.'),
    status: z.enum(LOCALE_STATUSES as [LocaleStatus, ...LocaleStatus[]]).optional(),
    file_id: fileIdArg,
  }, async ({ keep, language, status, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (Boolean(language) !== Boolean(status)) throw new Error('Give language and status together.');
    const rules = ctx.write(room, () => {
      const out = keep ? setTranslationRules(room.doc, { keep }) : translationRules(room.doc);
      if (language && status) setLocaleStatus(room.doc, translationStatus(room.doc, language).tag, status);
      return out;
    });
    return { rules, versions: languageVersions(room.doc).map((v) => ({ branch_id: v.branch.id, language: v.tag, status: v.status })) };
  });
}
