import { contrastRatio, normalizeColor, readBrand, type BogenDoc, type BogenNode, type BrandData } from '@bogen/core';
import { SLIDE_ATTR, layoutViolations, type SlideMeta } from './templates/brand-presentation.ts';

/**
 * Checks for a brand presentation: what makes one read as finished and the brand's own, or as generated. Only
 * objective defects are hard (placeholder text, text without contrast); the rest is advisory and may be kept for a
 * stated reason, as the user wants agents strengthened rather than fenced in.
 */

export interface PresentationFinding { rule: string; severity: 'hard' | 'advisory'; message: string; node_ids?: string[] }

const CLICHES = ['innovative', 'seamless', 'elevate', 'unlock', 'cutting-edge', 'next-level', 'game-changer', 'empower', 'synergy', 'world-class', 'revolutionary', 'reimagine'];
const PLACEHOLDER = /\b(lorem|ipsum|dolor sit|tbd|todo|placeholder|your (headline|text|name|tagline) here|xxx+)\b/i;

function resolve(value: string | undefined, tokens: Map<string, string>): string | null {
  if (!value) return null;
  let v = value.trim();
  for (let i = 0; i < 5; i++) {
    const m = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v);
    if (!m) break;
    v = tokens.get(m[1]!) ?? m[2]?.trim() ?? '';
  }
  return normalizeColor(v);
}

function isDont(doc: BogenDoc, node: BogenNode): boolean {
  return [node, ...doc.ancestors(node.id).map((id) => doc.getNode(id)).filter((n): n is BogenNode => Boolean(n))].some((n) => n.attrs?.['data-brand-example'] === 'dont');
}

export function presentationCheck(doc: BogenDoc, pageId: string, brand: BrandData | null, kind?: 'deck' | 'book'): { findings: PresentationFinding[]; slides: number; ask_yourself: string[] } {
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  const boards = doc.getChildren(pageId).filter((b) => b.artboard && b.attrs?.[SLIDE_ATTR]);
  const meta = new Map<string, SlideMeta>();
  for (const b of boards) {
    try { meta.set(b.id, JSON.parse(b.attrs![SLIDE_ATTR]!) as SlideMeta); } catch { /* not ours */ }
  }
  const slides = boards.filter((b) => meta.get(b.id)?.kind !== 'application').sort((a, b) => (meta.get(a.id)!.n - meta.get(b.id)!.n));
  const book = kind === 'book' || (kind === undefined && slides.length > 0 && slides.every((s) => meta.get(s.id)!.key.startsWith('book-')));
  const apps = boards.filter((b) => meta.get(b.id)?.kind === 'application');
  const out: PresentationFinding[] = [];
  const add = (rule: string, severity: PresentationFinding['severity'], message: string, ids?: string[]) => out.push({ rule, severity, message, ...(ids?.length ? { node_ids: ids.slice(0, 20) } : {}) });
  const texts = (root: string) => doc.descendants(root).filter((n) => n.type === 'text' && (n.text ?? '').trim() && !n.virtual);

  // Placeholder text, anywhere: objective.
  const placeholder = boards.flatMap((b) => texts(b.id)).filter((n) => PLACEHOLDER.test(n.text!));
  if (placeholder.length) add('placeholder', 'hard', `${placeholder.length} texts read as placeholders. Write real copy in the brand's voice.`, placeholder.map((n) => n.id));

  // Contrast of text on the colour behind it: objective.
  const bgOf = (n: BogenNode): string | null => {
    for (const id of [n.id, ...doc.ancestors(n.id)]) {
      const a = doc.getNode(id);
      const c = resolve(a?.style.backgroundColor, tokens);
      if (c) return c;
      if (a?.type === 'image' || a?.type === 'svg' || a?.name === 'Photo') return null;
    }
    return null;
  };
  const low: string[] = [];
  for (const b of boards) {
    for (const n of texts(b.id)) {
      if (isDont(doc, n)) continue;
      let fg: string | null = null;
      for (const id of [n.id, ...doc.ancestors(n.id)]) { fg = resolve(doc.getNode(id)?.style.color, tokens); if (fg) break; }
      const bg = bgOf(n);
      if (fg && bg && contrastRatio(fg, bg) < 3) low.push(n.id);
    }
  }
  if (low.length) add('contrast', 'hard', `${low.length} texts sit on a colour with less than 3:1 contrast.`, low);

  // Colour as literal values instead of the brand's tokens.
  const literal = boards.flatMap((b) => doc.descendants(b.id)).filter((n) => !n.virtual && !isDont(doc, n) && ['color', 'backgroundColor'].some((k) => /^#|^rgb/i.test(n.style[k] ?? '')));
  if (literal.length) add('tokens', 'advisory', `${literal.length} layers set colour as a value, not as the brand's token.`, literal.map((n) => n.id));

  // A reason on every identity and system slide.
  const unargued = slides.filter((s) => ['identity', 'system'].includes(meta.get(s.id)!.kind) && !meta.get(s.id)!.rationale);
  if (unargued.length) add('rationale', 'advisory', `${unargued.length} identity slides have no reason why. One line each makes the system argued, not decorated.`, unargued.map((s) => s.id));

  if (book) return { findings: out, slides: slides.length, ask_yourself: ['Could a printer and a developer work from these pages alone, without asking?'] };

  // The hero colour early.
  const first = slides.slice(0, 5).map((s) => meta.get(s.id)!.ground).filter(Boolean);
  const accent = brand?.colors.find((c) => /primary|accent|brand/i.test(c.role))?.token;
  if (accent && !first.includes(accent)) add('hero-colour', 'advisory', 'The brand\'s hero colour carries none of the first five slides.');

  // Rhythm.
  let run = 1;
  for (let i = 1; i < slides.length; i++) {
    run = meta.get(slides[i]!.id)!.template === meta.get(slides[i - 1]!.id)!.template ? run + 1 : 1;
    if (run === 4) add('rhythm', 'advisory', `Four slides in a row use the ${meta.get(slides[i]!.id)!.template} layout. Alternate sparse and dense.`, slides.slice(i - 3, i + 1).map((s) => s.id));
  }
  const has = (f: (m: SlideMeta) => boolean) => slides.some((s) => f(meta.get(s.id)!));
  if (!has((m) => Boolean(m.bleed))) add('full-bleed', 'advisory', 'No slide goes full bleed.');
  if (!has((m) => Boolean(m.dense))) add('dense', 'advisory', 'No slide is dense: show the system in quantity somewhere.');
  if (!has((m) => m.shot === 'close') || !has((m) => m.shot === 'distance')) add('scale', 'advisory', 'Show the brand both close up and from a distance.');
  for (const [key, label] of [['idea', 'the idea'], ['motion', 'motion'], ['wall', 'the system at scale'], ['next', 'next steps']] as const) {
    if (!has((m) => m.key === key)) add('missing', 'advisory', `There is no slide for ${label}.`);
  }

  // Type: families and the step from body to display.
  const fams = new Set<string>();
  let largest = 0;
  let smallest = Infinity;
  for (const b of slides) {
    for (const n of texts(b.id)) {
      const f = (n.style.fontFamily ?? '').split(',')[0]!.trim();
      if (f) fams.add(f);
      const px = Number(/^([\d.]+)px$/.exec(n.style.fontSize ?? '')?.[1] ?? (tokens.get(/var\(--([\w-]+)/.exec(n.style.fontSize ?? '')?.[1] ?? '')?.replace('px', '') ?? NaN));
      if (Number.isFinite(px)) { largest = Math.max(largest, px); smallest = Math.min(smallest, px); }
    }
  }
  if (fams.size > 2) add('families', 'advisory', `${fams.size} font families are used. Two carry a brand.`);
  if (largest && smallest < Infinity && largest < smallest * 2.5) add('display', 'advisory', 'Display type is less than 2.5 times the body. Let the big lines be big.');

  // Words.
  const all = boards.flatMap((b) => texts(b.id)).filter((n) => !isDont(doc, n));
  const cliche = all.filter((n) => CLICHES.some((w) => new RegExp(`\\b${w}`, 'i').test(n.text!)));
  if (cliche.length) add('cliche', 'advisory', `${cliche.length} texts use words every brand uses (${CLICHES.filter((w) => cliche.some((n) => new RegExp(`\\b${w}`, 'i').test(n.text!))).join(', ')}).`, cliche.map((n) => n.id));
  const avoid = (brand?.words ?? []).filter((w) => w.use === 'avoid');
  const banned = all.filter((n) => avoid.some((w) => new RegExp(`\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(n.text!)));
  if (banned.length) add('brand-words', avoid.some((w) => w.severity === 'hard') ? 'hard' : 'advisory', `${banned.length} texts use words the brand avoids.`, banned.map((n) => n.id));
  const lines = apps.map((a) => texts(a.id).map((n) => n.text!.trim()).sort((x, y) => y.length - x.length)[0]).filter(Boolean);
  if (lines.length >= 4 && new Set(lines).size <= Math.ceil(lines.length / 3)) add('voice', 'advisory', 'Most applications repeat the same line. Different lines in one voice prove the voice.');
  // Sets of boards (the feed, the stories, the posters) read as a system when their forms vary.
  const sets = new Map<string, BogenNode[]>();
  for (const a of apps) { const set = meta.get(a.id)?.set; if (set) sets.set(set, [...(sets.get(set) ?? []), a]); }
  for (const [set, members] of sets) {
    const ordered = members.slice().sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
    const bad = layoutViolations(ordered.map((m) => meta.get(m.id)?.layout));
    if (bad.length) add('layout-repeat', 'advisory', `In the ${set} boards, ${bad.map((b) => `${ordered[b.index]!.name} ${b.rule === 'adjacent' ? 'repeats the form of the board before it' : 'is a fourth board of one form in nine'}`).join('; ')}. Vary the form: photo, split, the one number, a quote, the device as a figure, type alone, details.`, bad.map((b) => ordered[b.index]!.id));
  }
  const mute = apps.filter((a) => !texts(a.id).length && !/icon|merch|sign/i.test(a.name));
  if (mute.length) add('applications', 'advisory', `${mute.length} applications carry no line in the brand's voice.`, mute.map((a) => a.id));

  // Photos in one treatment.
  const photoFilters = new Set(boards.flatMap((b) => doc.descendants(b.id)).filter((n) => n.name === 'Photo').map((n) => doc.getChildren(n.id).find((c) => c.type === 'image')?.style.filter ?? 'none'));
  if (photoFilters.size > 1) add('photo-treatment', 'advisory', 'Photos come in more than one treatment. One treatment and one crop make them the brand\'s.');

  // Effects the brand does not have.
  const fx = boards.flatMap((b) => doc.descendants(b.id)).filter((n) => !n.virtual && !isDont(doc, n) && (/\d/.test(n.style.boxShadow ?? '') || /\d/.test(n.style.textShadow ?? '') || /drop-shadow|blur\(/.test(n.style.filter ?? '')));
  if (fx.length && brand?.fields.shadows === 'none') add('effects', 'advisory', `${fx.length} layers have shadows or glows the brand does not allow.`, fx.map((n) => n.id));

  return {
    findings: out, slides: slides.length,
    ask_yourself: [
      'Cover the logo on each application: does it still read as this brand? If not, the device, type and voice are not carrying it yet.',
      'Is every picture argued by a rule that ties it to the subject, or is it a mood?',
      'Would a competitor\'s name fit on the insight and the idea slide? Then they are not specific enough.',
    ],
  };
}

export { readBrand };
