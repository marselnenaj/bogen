import type { BogenDoc, CallContext } from '@bogen/core';

/**
 * What is on screen, for the voice of a call: the file, the page, the artboards on it and the selected layers, by
 * name. Only names, so the talking layer can say "the file Sprechstunde, page Produkt" without the agent, and so the
 * listening model can be primed with the words the person is likely to say.
 */
export interface ScreenSource {
  fileName(fileId: string): string | undefined;
  doc(fileId: string): Promise<BogenDoc | null>;
}

export interface ScreenRequest { fileId?: string; pageId?: string; selection?: string[] }

const NAME_MAX = 80;
const BOARDS_MAX = 24;

function clean(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
}

export async function screenContext(source: ScreenSource, req: ScreenRequest): Promise<Pick<CallContext, 'file' | 'page' | 'boards' | 'selection'>> {
  if (!req.fileId) return {};
  const file = clean(source.fileName(req.fileId));
  const doc = await source.doc(req.fileId).catch(() => null);
  if (!doc) return file ? { file } : {};
  const pages = doc.getPages();
  const page = pages.find((p) => p.id === req.pageId) ?? pages[0];
  const boards = page ? doc.getChildren(page.id).map((n) => clean(n.name)).filter(Boolean).slice(0, BOARDS_MAX) : [];
  const selection = (req.selection ?? []).slice(0, 12).flatMap((id) => {
    const n = doc.getNode(id);
    const name = clean(n?.name);
    return name ? [name] : [];
  });
  return {
    ...(file ? { file } : {}),
    ...(page ? { page: clean(page.name) } : {}),
    ...(boards.length ? { boards } : {}),
    ...(selection.length ? { selection } : {}),
  };
}

/** Words the person is likely to say in this file, as a prompt for the listening model: names first, then design words. */
export function hearingPrompt(ctx: Pick<CallContext, 'file' | 'page' | 'boards' | 'selection'>, language: 'de' | 'en' | 'auto'): string {
  const names = [ctx.file, ctx.page, ...(ctx.boards ?? []), ...(ctx.selection ?? [])].filter((n): n is string => Boolean(n));
  const words = language === 'en'
    ? ['design', 'headline', 'artboard', 'layer', 'component', 'token', 'spacing', 'font', 'colour', 'button', 'mobile', 'desktop']
    : ['Design', 'Überschrift', 'Headline', 'Artboard', 'Ebene', 'Komponente', 'Token', 'Abstand', 'Schrift', 'Farbe', 'Button', 'Handy', 'Desktop'];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...names, ...words]) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  // Whisper reads at most 224 prompt tokens; a short list of terms is enough to bias spelling.
  let text = '';
  for (const w of out) {
    if ((text + w).length > 400) break;
    text += (text ? ', ' : '') + w;
  }
  return text ? `${text}.` : '';
}
