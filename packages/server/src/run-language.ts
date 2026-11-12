// The design content language of a run: what every run gets, whatever started it (the prompt bar, a comment, the
// phone, a race, a paired device that asked). It passes here before the intent check, since adding a language
// version decides where the run works (run-intent.ts).

import { brandLanguages, contentLanguageOf, resolveContentLanguage, type ContentLanguage } from '@bogen/core';
import type { RunRequest } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import { HttpError } from './util.ts';

/**
 * Runs that cannot hold a language version: it is a branch of the whole design, and these work in copies of their own
 * (race, proposal, directions), only comment (critique), rebuild an image, or work on a project folder.
 */
export function cannotAddVersion(req: RunRequest): string | null {
  if (req.live) return 'A run on a project folder';
  if (req.rebuildOf) return 'Rebuilding an image as layers';
  if (req.race || req.review === 'directions') return 'A race of directions';
  if (req.review === 'proposal') return 'A proposal';
  if (req.review === 'critique') return 'A critique';
  return null;
}

/**
 * The brand's languages, only where the brand sets them: its primary, a soft default for the design language, and all
 * of them, so that a run is told whether the brand speaks the language it writes in.
 */
async function brandSpeaks(app: BogenServer, req: RunRequest): Promise<{ primary: string; all: string[] } | null> {
  const room = await app.rooms.get(req.fileId).catch(() => null);
  if (!room) return null;
  const found = await app.brands.forRoom(room).catch(() => null);
  if (!found?.data) return null;
  const langs = brandLanguages(found.data);
  return langs.primary && !langs.inferred ? { primary: langs.primary, all: langs.all } : null;
}

export async function prepareRunLanguage(app: BogenServer, req: RunRequest): Promise<RunRequest> {
  const asked = req.language?.mode;
  // Asked for explicitly, Add is refused where it cannot be held, before anything else: never quietly dropped.
  if (asked === 'add') {
    const which = cannotAddVersion(req);
    if (which) throw new HttpError(400, `${which} cannot add a language version: that is a branch of the whole design, made by Change it. Nothing was started. Choose Translate to translate in place, or Change it to add the version.`);
  }
  // A project folder is code, not a design: its language is the project's business.
  if (req.live) return req;
  const room = await app.rooms.get(req.fileId).catch(() => null);
  if (!room) return req;
  const speaks = await brandSpeaks(app, req);
  const voice = speaks?.primary ?? null;
  const lang = resolveContentLanguage({ run: req.language ?? null, file: contentLanguageOf(room.doc), brand: voice });
  // A translation or a version with no language to go to is not an ordinary edit: say so, and start nothing.
  if (!lang && asked && asked !== 'write') throw new HttpError(400, `There is no design language to ${asked === 'add' ? 'add a version in' : 'translate into'}: this request names none, and the file and its brand set none. Nothing was started. Choose a language for the request, or set the file's.`);
  if (!lang) return req;
  if (lang.mode === 'add') {
    const which = cannotAddVersion(req);
    // Never quietly turned into a translation of the original: the person asked to keep it.
    if (which) throw new HttpError(400, `${which} cannot add a language version: that is a branch of the whole design, made by Change it. Nothing was started. Choose Translate to translate in place, or Change it to add the version.`);
  }
  return { ...req, contentLanguage: lang, ...(speaks ? { brandVoice: speaks.primary, brandLanguages: speaks.all } : {}) };
}

/** The name of the branch a language version lives in, such as "German (de)". The same language finds the same branch. */
export function languageBranchName(lang: ContentLanguage): string {
  return `${lang.name} (${lang.tag})`;
}
