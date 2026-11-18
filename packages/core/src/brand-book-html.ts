import { converter, parse } from 'culori';
import { type BrandBookChapterId } from './brand-book.ts';
import { ALL_LANGUAGES, brandLanguages, chapterLanguage, itemLanguage } from './brand-language.ts';
import { voiceFindings } from './brand-voice.ts';
import { colorDistance, contrastRatio, familyStack, luminance, normalizeColor, pairingTable, resolveBrandColor, type BrandColor, type BrandData, type BrandFamily, type BrandLogo, type BrandRule } from './brand.ts';
import { escapeAttr, escapeHtml } from './css.ts';

/**
 * The brand book: the brand as a set of landscape pages, laid out like a studio's guidelines and generated from the
 * brand's data and nothing else. Each page is a fixed 1280 by 800 sheet with a running head, a section rail and a
 * folio, so that the PDF has one page per sheet; under 700px wide the pages reflow into one column for a phone.
 *
 * What the brand does not have is left out rather than filled: a section without data has no page, and the contents
 * page says which sections are still to add. Drafts and suggestions are marked as such where they appear. The book is
 * for sharing, so working notes (file paths, sources, notes to agents) stay in the Markdown export, and copy is never
 * cut mid-sentence: what does not fit gets a page of its own or is left to the export.
 *
 * Every page is planned to fit its sheet from the length of its text; scripts/check-brand-book-render.ts measures the
 * rendered pages of every brand and is the check on that plan.
 */

export const BRAND_BOOK_PAGE = { width: 1280, height: 800 } as const;

/** An example from the brand, already rendered to a picture by whoever has a renderer. */
export interface BrandBookExample {
  name: string; verdict: 'good' | 'bad'; src: string; note?: string; width?: number; height?: number;
  /** The artboard's width in CSS px, and the smallest text in the part of it that was captured. */
  cssWidth?: number; minTextPx?: number;
  /** Only the top of the artboard was captured, ending where no line or object is cut. */
  cut?: boolean;
}
export interface BrandBookOptions {
  examples?: BrandBookExample[];
  /** The published version this book shows the state after, if any. */
  version?: number;
  /** When the book was made, already formatted in the book's language. */
  date?: string;
}
export interface BrandBookPage { section: string; title: string; html: string }

const W = BRAND_BOOK_PAGE.width;
const H = BRAND_BOOK_PAGE.height;
const M = 64; // page margin
const CONTENT = W - 2 * M; // 1152: the content column, the full width between the margins
const BODY = H - 40 - 32 - 20 - 16 - 2 * 28; // 636: the height between the running head and the folio
/** The book's one grid: twelve columns across the content width with one gutter, so that every column of every page
 * starts on the same lines. Equal columns of 2, 3, 4 or 6 fall on it by themselves; other widths are spans of it. */
export const BOOK_GRID = { columns: 12, gutter: 32, left: 64, width: 1152 } as const;
const GUTTER = BOOK_GRID.gutter;
const COL = (CONTENT - 11 * GUTTER) / 12;
/** The width of `k` columns of the book's grid with the gutters between them. */
const span = (k: number) => Math.round((k * COL + (k - 1) * GUTTER) * 100) / 100;
const DESK = '#e8e7e3';
const PAPER_WHITE = '#ffffff';
const INK_BLACK = '#1c1c1a';
const GOOD = '#2f7a3a';
const BAD = '#a3261a';
const AMBER = '#8a5a00';

const oklch = converter('oklch');
const toRgb = converter('rgb');

/** `a` mixed into `b`: 0 is all a, 1 is all b. */
function mixHex(a: string, b: string, t: number): string {
  const x = toRgb(parse(a)), y = toRgb(parse(b));
  if (!x || !y) return a;
  const ch = (p: number, q: number) => Math.round(Math.max(0, Math.min(1, p + (q - p) * t)) * 255).toString(16).padStart(2, '0');
  return `#${ch(x.r, y.r)}${ch(x.g, y.g)}${ch(x.b, y.b)}`;
}

// ------------------------------------------------------------------ the book's own words, in the brand's language

/** The chrome of the book in German; any other language gets English. Keys are the English text. */
const DE: Record<string, string> = {
  'Brand guidelines': 'Markenrichtlinien',
  'Contents': 'Inhalt',
  'Cover': 'Titel',
  'Brand idea': 'Markenidee',
  'Principles': 'Prinzipien',
  'Logo': 'Logo',
  'Colour': 'Farbe',
  'Typography': 'Typografie',
  'Space and layout': 'Raum und Layout',
  'Voice and tone': 'Sprache und Ton',
  'Imagery and icons': 'Bilder und Icons',
  'Rules': 'Regeln',
  'Tokens': 'Tokens',
  'Applications': 'Anwendungen',
  'About this book': 'Über dieses Buch',
  'continued': 'Fortsetzung',
  'For': 'Für',
  'Tone': 'Ton',
  'Version': 'Version',
  'Not published yet': 'Noch nicht veröffentlicht',
  'suggestion': 'Vorschlag',
  'the primary mark': 'das Hauptzeichen',
  'Clear space': 'Schutzzone',
  'Minimum width': 'Mindestbreite',
  'Use on': 'Verwenden auf',
  'Not set yet': 'Noch nicht festgelegt',
  'on every side, the dashed line': 'an jeder Seite, die gestrichelte Linie',
  'any ground': 'jedem Grund',
  'light grounds': 'hellem Grund',
  'dark grounds': 'dunklem Grund',
  'Variants': 'Varianten',
  'At least': 'Mindestens',
  'wide': 'breit',
  'Only one version of the mark so far. A reversed version for dark grounds and a small mark for icons belong on the brand page.': 'Bisher gibt es nur eine Fassung des Zeichens. Eine negative Fassung für dunklen Grund und ein kleines Zeichen für Icons gehören auf die Markenseite.',
  'The mark is only ever used as it was drawn. These are the real mark, changed in the ways that break it.': 'Das Zeichen wird nur so verwendet, wie es gezeichnet wurde. Hier ist das echte Zeichen, so verändert, wie es nicht sein darf.',
  'Do not stretch or squash it.': 'Nicht verzerren oder stauchen.',
  'Do not rotate it.': 'Nicht drehen.',
  'Do not recolour it.': 'Nicht umfärben.',
  'Do not add shadows or effects.': 'Keine Schatten oder Effekte.',
  'Do not place it on a ground it was not made for.': 'Nicht auf einen Grund setzen, für den es nicht gemacht ist.',
  'Do not crowd it: keep the clear space.': 'Nicht bedrängen: die Schutzzone frei halten.',
  'Partner': 'Partner',
  'Core colours': 'Hauptfarben',
  'By how much the brand\'s own work uses each colour.': 'Anteil jeder Farbe in den Arbeiten der Marke.',
  'Roughly how much of a page each colour takes: mostly ground and ink, the accent sparingly.': 'Ungefähr, wie viel einer Seite jede Farbe einnimmt: vor allem Grund und Schrift, der Akzent sparsam.',
  'All colours': 'Alle Farben',
  'Name': 'Name',
  'Token': 'Token',
  'Text': 'Text',
  'Surfaces': 'Flächen',
  'Supporting': 'Ergänzend',
  'Lines': 'Linien',
  'States': 'Zustände',
  'Illustration': 'Illustration',
  'Pairs and contrast': 'Paare und Kontrast',
  'Text colour on ground, with the measured WCAG contrast. AA needs 4.5:1 for text, AAA 7:1.': 'Schriftfarbe auf Grund, mit gemessenem WCAG-Kontrast. AA verlangt 4,5:1 für Text, AAA 7:1.',
  'Use': 'Verwenden',
  'Do not use': 'Nicht verwenden',
  'on': 'auf',
  'Fails': 'Nicht erfüllt',
  'AA large only': 'AA nur groß',
  'Scale': 'Größen',
  'shown at': 'gezeigt mit',
  'Spacing scale': 'Abstände',
  'Corners': 'Ecken',
  'Rules of the page': 'Regeln der Seite',
  'Content is at most': 'Inhalte sind höchstens',
  'px wide.': 'px breit.',
  'No shadows.': 'Keine Schatten.',
  'No gradients.': 'Keine Verläufe.',
  'Grid': 'Raster',
  'The full layout notes are in the Markdown export.': 'Die vollständigen Layout-Notizen stehen im Markdown-Export.',
  'Say': 'Sagen',
  'Avoid': 'Vermeiden',
  'say': 'sondern',
  'Never': 'Nie',
  'In use': 'Im Einsatz',
  'Write': 'So',
  'Not': 'Nicht',
  'Do': 'Tun',
  'Do not': 'Lassen',
  'Must': 'Muss',
  'Binding': 'Verbindlich',
  'Marks only': 'Nur für Markierungen',
  'Guidance': 'Empfehlung',
  'Should': 'Soll',
  'The tokens a designer works with, as CSS custom properties. Every other token is in the brand\'s CSS export.': 'Die Tokens, mit denen gestaltet wird, als CSS-Variablen. Alle anderen stehen im CSS-Export der Marke.',
  'Not like this': 'Nicht so',
  'Not like this.': 'Nicht so.',
  'Made from the brand\'s data in Bogen, so it always shows the brand as it is now.': 'Aus den Daten der Marke in Bogen erstellt, also immer auf dem aktuellen Stand.',
  'written chapters confirmed': 'geschriebenen Kapiteln bestätigt',
  'of': 'von',
  'in draft': 'im Entwurf',
  'values are still suggestions, marked as such, and bind nobody until confirmed.': 'Werte sind noch Vorschläge, so markiert, und gelten erst, wenn sie bestätigt sind.',
  'Every value in it is confirmed.': 'Jeder Wert darin ist bestätigt.',
  'Still to add': 'Noch zu ergänzen',
  'Add them on the brand page and they appear here.': 'Auf der Markenseite ergänzt, erscheinen sie hier.',
  'The written guidelines have sixteen chapters. Confirmed chapters guide design; drafts are proposals. The full text, with sources, working notes and open questions, is in the Markdown export.': 'Die geschriebenen Richtlinien haben sechzehn Kapitel. Bestätigte Kapitel leiten die Gestaltung, Entwürfe sind Vorschläge. Der ganze Text, mit Quellen, Arbeitsnotizen und offenen Fragen, steht im Markdown-Export.',
  'confirmed': 'bestätigt',
  'draft': 'Entwurf',
  'open': 'offen',
  'Confirmed': 'Bestätigt',
  'Draft': 'Entwurf',
  'Open': 'Offen',
  'Not applicable': 'Nicht zutreffend',
  'open questions': 'offene Fragen',
  'From the draft chapter. Not confirmed yet.': 'Aus dem Kapitelentwurf, noch nicht bestätigt.',
  'From the open chapter. Not confirmed yet.': 'Aus dem offenen Kapitel, noch nicht bestätigt.',
  'Purpose and positioning': 'Zweck und Positionierung',
  'Audience and contexts': 'Zielgruppe und Kontexte',
  'Brand architecture': 'Markenarchitektur',
  'Personality and principles': 'Persönlichkeit und Prinzipien',
  'Logo and marks': 'Logo und Zeichen',
  'Colour system': 'Farbsystem',
  'Typography and language': 'Typografie und Sprache',
  'Layout and responsive behavior': 'Layout und Anpassung',
  'Imagery and art direction': 'Bildsprache',
  'Icons and illustration': 'Icons und Illustration',
  'Voice and content': 'Sprache und Inhalt',
  'Motion and interaction': 'Bewegung und Interaktion',
  'Data and information': 'Daten und Information',
  'Applications and components': 'Anwendungen und Komponenten',
  'Accessibility and quality': 'Barrierefreiheit und Qualität',
  'Assets and governance': 'Dateien und Verantwortung',
  'on every side': 'an jeder Seite',
  'of the mark\'s height, on every side': 'der Zeichenhöhe, an jeder Seite',
  'Headlines only': 'Nur für Überschriften',
  'Examples': 'Beispiele',
  'Dear': 'Hallo',
  'Kind regards': 'Viele Grüße',
  'Hello': 'Hallo',
  'Letter': 'Brief',
  'Business card': 'Visitenkarte',
  'Social post': 'Beitrag',
  'Front': 'Vorderseite',
  'Back': 'Rückseite',
  'Home page, first screen, drawn from the brand': 'Startseite, erster Bildschirm, aus der Marke gezeichnet',
  'The brand\'s own home page': 'Die eigene Startseite der Marke',
  'Small sizes': 'Kleine Größen',
  'Misuse': 'Falsche Verwendung',
  'Supporting colours': 'Ergänzende Farben',
  'Appendix': 'Anhang',
  'Core': 'Kern',
  'Semantic': 'Semantisch',
  'Components': 'Komponenten',
  'The values everything else is built from.': 'Die Werte, aus denen alles andere gebaut ist.',
  'Roles: what a colour or size is for.': 'Rollen: wofür eine Farbe oder Größe da ist.',
  'Values that belong to one component.': 'Werte, die zu einer Komponente gehören.',
  'Stationery': 'Geschäftsausstattung',
  'Business card, front': 'Visitenkarte, Vorderseite',
  'Business card, back': 'Visitenkarte, Rückseite',
  'Email signature': 'E-Mail-Signatur',
  'Letter and social post': 'Brief und Social-Media-Beitrag',
  'Letter, A4': 'Brief, A4',
  'Social post, 1:1': 'Beitrag, 1:1',
  'Website': 'Website',
  'Home page, first screen': 'Startseite, erster Bildschirm',
  'page': 'Seite',
  'values are proposals and bind nobody until confirmed.': 'Werte sind Vorschläge und gelten erst, wenn sie bestätigt sind.',
  'Made from the brand\'s data in Bogen, so it always shows the brand as it is now. The full text, with sources and working notes, is in the Markdown export.': 'Aus den Daten der Marke in Bogen erstellt, also immer auf dem aktuellen Stand. Der ganze Text, mit Quellen und Arbeitsnotizen, steht im Markdown-Export.',
  'Edition': 'Ausgabe',
  'State': 'Stand',
  'Brand': 'Marke',
  'Roles: what a colour is for.': 'Rollen: wofür eine Farbe da ist.',
  'From small to large.': 'Von klein nach groß.',
  'System serif': 'System-Serif',
  'System sans': 'System-Sans',
  'Proposal': 'Vorschlag',
  'chapters in this book are confirmed; the rest are drafts.': 'Kapiteln in diesem Buch sind bestätigt, die übrigen sind Entwürfe.',
  'Every chapter in this book is confirmed.': 'Jedes Kapitel in diesem Buch ist bestätigt.',
  'Every value is confirmed.': 'Jeder Wert ist bestätigt.',
  'Type sizes': 'Schriftgrößen',
  'Spacing': 'Abstände',
  'The sizes text is set in, largest first.': 'Die Größen, in denen Text gesetzt wird, die größte zuerst.',
  'System monospace': 'System-Monospace',
  'Proposed rules: they bind nobody until the brand confirms them.': 'Vorgeschlagene Regeln: Sie gelten erst, wenn die Marke sie bestätigt.',
  'first screen': 'erster Bildschirm',
  'at': 'bei',
  'width': 'Breite',
  'mark height': 'Zeichenhöhe',
  'Type at work': 'Schrift im Einsatz',
  'Headline': 'Überschrift',
  'Lead': 'Vorspann',
  'Body': 'Fließtext',
  'The brand\'s own words in its own hierarchy.': 'Die eigenen Worte der Marke in ihrer eigenen Rangfolge.',
  'Social media': 'Social Media',
  'Post, 1:1': 'Beitrag, 1:1',
  'At their true size.': 'In ihrer wahren Größe.',
  'Shown at': 'Gezeigt in',
  'Story, 9:16': 'Story, 9:16',
  'The brand\'s own ratio': 'Das Verhältnis der Marke',
};

/** The book's language: German for a German brand, else English. */
export function brandBookLanguage(data: BrandData): 'de' | 'en' {
  return /^de\b/i.test(brandLanguages(data).primary ?? '') ? 'de' : 'en';
}

// ------------------------------------------------------------------ text: presentable, whole sentences

/** A sentence that is a working note rather than guidance: file paths, sources, notes to agents. */
const CSS_PROPERTY = /(?:^|[\s(])[a-z]+-[a-z]+(?:-[a-z]+)*:\s*[\w(]/;
const WORKING_NOTE_CODE = /(#[0-9a-f]{3,8}\b[^#]*){2,}|\b\d+(?:\.\d+)?(?:ch|rem|vw|vh|svh|fr)\b|\bim Code\b|\bin (?:the )?code\b|canonical entry|no canonical|proposed guidance|approved asset|must not substitute|recorded identity|rendered-image|not screenshot|kein(?:e|en)? kanonisch|nicht ersetzen/i;
const WORKING_NOTE = /CLAUDE\.md|AGENTS\.md|README|\bsrc\/|\bpublic\/|licenses?\/|node_modules|\.(?:css|scss|tsx?|jsx?|mjs|cjs|py|sh|json|woff2?|ttf|otf|ya?ml|md)\b|https?:\/\/|github\.com|Quelltext|source ?code|Kommentar in|comment in|Fontsource|Token-Namen|token names|\bvar\(--|\bcommit\b|Repo\b|repository|Nutzerwunsch|user'?s request|on request of the user|laut\s+[A-Z][\w.]*\.md/i;

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = /\b(z\.\s?B|d\.\s?h|u\.\s?a|bzw|ca|etc|vgl|inkl|exkl|ggf|evtl|usw|Nr|e\.\s?g|i\.\s?e|vs|approx|incl|Dr|Mr|Ms|St)\.(?=\s)/g;

function sentencesOf(text: string): string[] {
  const kept = text.replace(/\s+/g, ' ').trim().replace(ABBREVIATIONS, (m) => m.replace(/\./g, '\u2024'));
  const parts = kept.split(/(?<=[.!?…])\s+(?=[\p{Lu}0-9„"“(])/u).map((s) => s.trim().replace(/\u2024/g, '.')).filter(Boolean);
  // A quotation that runs over several sentences stays one piece, so that no cut leaves a quote open.
  const out: string[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last !== undefined && quoteDebt(last) > 0) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}

/** How many quotation marks a text opens and does not close: German „…“, English “…”, guillemets and straight quotes. */
function quoteDebt(s: string): number {
  const n = (re: RegExp) => (s.match(re) ?? []).length;
  const german = n(/„/g);
  const curly = german ? Math.max(0, german - n(/“/g)) : !n(/”/g) && /[^\s(]“/.test(s) && !/(^|\s)“/.test(s) ? 0 : Math.max(0, n(/“/g) - n(/”/g));
  return curly + Math.max(0, n(/«/g) - n(/»/g)) + (n(/"/g) % 2);
}

/** A text with every quotation mark it opens closed again, for a text cut short. */
export function balanceQuotes(s: string): string {
  const n = (re: RegExp) => (s.match(re) ?? []).length;
  let out = s;
  if (n(/„/g)) { for (let k = n(/„/g) - n(/“/g); k > 0; k--) out += '“'; for (let k = n(/“/g) - n(/„/g); k > 0; k--) out = `„${out}`; }
  // A “ after a word with no ” in the text is a German closing mark whose „ was cut off.
  else if (!n(/”/g) && /[^\s(]“/.test(s) && !/(^|\s)“/.test(s)) { for (let k = n(/“/g); k > 0; k--) out = `„${out}`; }
  else { for (let k = n(/“/g) - n(/”/g); k > 0; k--) out += '”'; for (let k = n(/”/g) - n(/“/g); k > 0; k--) out = `“${out}`; }
  for (let k = n(/«/g) - n(/»/g); k > 0; k--) out += '»';
  if (n(/"/g) % 2) out += '"';
  return out;
}

/** Splits items into pages of at most `room`, as evenly as their heights allow: no last page with one item left over. */
function paginate<T>(items: T[], height: (x: T) => number, room: number, count?: number): T[][] {
  const total = items.reduce((s, x) => s + height(x), 0);
  let pages = Math.max(1, count ?? Math.ceil(total / room));
  const out: T[][] = [];
  let remaining = total;
  let i = 0;
  while (i < items.length) {
    const left = Math.max(1, pages - out.length);
    const target = remaining / left;
    const page: T[] = [];
    let used = 0;
    while (i < items.length) {
      const h = height(items[i]!);
      if (page.length && (used + h > room || (left > 1 && used + h / 2 > target))) break;
      page.push(items[i]!); used += h; i++;
    }
    out.push(page);
    remaining -= used;
    if (out.length >= pages && i < items.length) pages++;
  }
  return out;
}

/** Short function words that tell English from German in a sentence. */
const EN_WORDS = new Set('the and of to is are be with for that this it on use should must not your you an as by from or into when what each every only its their our will can a before after all any more than no if then also have has but about over under between without within who which where how check do does never always'.split(' '));
const DE_WORDS = new Set('der die das und ist sind mit für nicht ein eine einen dem den des auf zu im wir ihr sie es wird werden kein keine nur wie bei aus oder auch sich dass vom zum zur vor nach alle mehr als wenn dann hat haben aber über unter zwischen ohne wer welche wo noch schon sehr immer nie'.split(' '));

/** 'en' or 'de' when a sentence clearly reads as one of them, else null. */
export function sentenceLanguage(s: string): 'en' | 'de' | null {
  const words = s.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 4) return null;
  let en = 0, de = 0;
  for (const w of words) { if (EN_WORDS.has(w)) en++; if (DE_WORDS.has(w)) de++; }
  if (/[äöüß]/i.test(s)) de += 2;
  if (en >= 2 && en >= 2 * de) return 'en';
  if (de >= 2 && de >= 2 * en) return 'de';
  return null;
}

/** Sentences that are notes to whoever builds the brand, not guidance for the reader. */
const INSTRUCTION = /^(Use the existing|Test a real|Check\b|Make sure|Replace (this|the)|TODO|Add (a|the|more)\b)|\brequired\b.*\bexamples?\b|\bexamples?\b.*\brequired\b|\bbefore declaring\b|\bproposed design\b|\buser-confirmed\b|\bthe owner\b|\bSource:\s|\bis proposed\b|\bare proposed\b|\bnicht bestätigt\b|\bnicht beschrieben\b|\bnot (?:yet )?described\b|\bnot documented\b|\bnoch offen\b|\bvor der Freigabe prüfen\b|\bsource [a-z0-9]{8,}\b|\b[a-z0-9]{10}\b(?=.*\b(id|node|layer|artboard)\b)/i;

/**
 * The text without its working notes, sentence by sentence. With the book's language given, a sentence that clearly
 * reads as the other language is left out: an English note in a German book is a note, not the brand's copy.
 */
function presentable(text: string | undefined, lang?: 'en' | 'de'): string {
  if (!text) return '';
  return sentencesOf(text.replace(/\*\*([^*\n]+)\*\*/g, '$1'))
    .filter((s) => !WORKING_NOTE.test(s) && !WORKING_NOTE_CODE.test(s) && !CSS_PROPERTY.test(s) && !INSTRUCTION.test(s))
    .filter((s) => { if (!lang) return true; const l = sentenceLanguage(s); return !l || l === lang; })
    .join(' ');
}

/** Whole sentences up to `max` characters; a first sentence that is longer is cut after a clause, never inside a word. */
function upTo(text: string, max: number): string {
  const all = sentencesOf(text);
  if (!all.length) return '';
  let out = '';
  for (const s of all) {
    if (out && (out + ' ' + s).length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out.length <= max) return out;
  return clauseCut(out, max);
}

/** Whole sentences up to `max` characters, and nothing when even the first is longer: never a cut sentence. */
function wholeUpTo(text: string, max: number): string {
  let out = '';
  for (const s of sentencesOf(text)) {
    if ((out ? out.length + 1 : 0) + s.length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  return out;
}

/** A long sentence shortened to its first clause or clauses that fit, ending at a clause mark. */
function clauseCut(text: string, max: number): string {
  const head = text.slice(0, max + 1);
  const at = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' – '), head.lastIndexOf(' — '));
  if (at > max * 0.35) return balanceQuotes(text.slice(0, at).replace(/[,;:]\s*$/, ''));
  const space = head.lastIndexOf(' ');
  return balanceQuotes(text.slice(0, space > 0 ? space : max));
}

/** The short statement a brand leads with: its first sentence or two, if they are short. */
function statementOf(positioning: string): { statement: string; rest: string } {
  const all = sentencesOf(positioning);
  if (!all.length) return { statement: '', rest: '' };
  let statement = '';
  let used = 0;
  for (const s of all) {
    if (statement && (statement + ' ' + s).length > 72) break;
    statement = statement ? `${statement} ${s}` : s;
    used++;
  }
  if (statement.length > 120) {
    // Only a cut at a clause mark makes a statement; a sentence that has none is not cut, and the brand has no short one.
    const head = statement.slice(0, 111);
    const mark = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' – '), head.lastIndexOf(' — '));
    if (mark < 110 * 0.35) return { statement: '', rest: all.join(' ') };
    const cut = clauseCut(statement, 110);
    const whole = all.join(' ');
    return { statement: cut, rest: balanceQuotes(whole.slice(cut.replace(/[“”»"]+$/, '').length).replace(/^[\s,;:–—-]+/, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase())) };
  }
  return { statement, rest: all.slice(used).join(' ') };
}

// ------------------------------------------------------------------ small pieces

function css(style: Record<string, string | number | undefined>): string {
  return escapeAttr(Object.entries(style).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}:${v}`).join(';'));
}
const esc = escapeHtml;
const onColor = (bg: string) => (luminance(bg) > 0.36 ? '#111111' : '#ffffff');

function rgbOf(value: string): string {
  const c = toRgb(parse(value));
  return c ? `${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)}` : '';
}
function oklchOf(value: string, lang: 'de' | 'en' = 'en'): string {
  const c = oklch(parse(value));
  if (!c) return '';
  const n = (x: string) => (lang === 'de' ? x.replace('.', ',') : x);
  return `${n((c.l * 100).toFixed(1))}${lang === 'de' ? '\u00a0%' : '%'} ${n(c.c.toFixed(3))} ${Number.isFinite(c.h) ? Math.round(c.h ?? 0) : 0}`;
}
const gradeOf = (ratio: number) => (ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large only' : 'Fails');

/** Lines a text takes in a column, from an average glyph width: generous, so that a plan errs towards room. */
function linesFor(text: string, width: number, size: number, factor = 0.54): number {
  const perLine = Math.max(8, Math.floor(width / (size * factor)));
  let lines = 0;
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = 0;
    lines++;
    for (const w of words) {
      if (line && line + 1 + w.length > perLine) { lines++; line = w.length; } else line += (line ? 1 : 0) + w.length;
    }
  }
  return lines;
}

/** The colours by the job they do, guessed from their roles and names. */
function rolesOf(data: BrandData) {
  const find = (re: RegExp, not: (BrandColor | undefined)[] = []) => data.colors.find((c) => !not.includes(c) && re.test(`${c.role} ${c.name} ${c.token}`.toLowerCase()));
  const exact = (re: RegExp, not: (BrandColor | undefined)[] = []) => data.colors.find((c) => !not.includes(c) && re.test(c.role.toLowerCase().trim()));
  const byLight = [...data.colors].sort((a, b) => luminance(b.value) - luminance(a.value));
  const named = exact(/^(primary|accent|action|brand)$/);
  const ground = exact(/^(background|ground|paper|canvas|page)$/, [named]) ?? find(/background|ground|paper|surface|canvas|sheet/, [named]) ?? byLight.find((c) => c !== named);
  const ink = exact(/^(text|ink|foreground)$/, [ground, named]) ?? find(/\btext\b|ink|foreground/, [ground, named]) ?? [...byLight].reverse().find((c) => c !== ground && c !== named && contrastRatio(c.value, ground?.value ?? '#ffffff') >= 4.5);
  const primary = named ?? find(/primary|action|brand|accent/, [ground, ink]) ?? data.colors.find((c) => c !== ground && c !== ink);
  // The second colour is one of the brand's own, not a hover state, a text, a surface or a line that merely says "accent".
  const second = data.colors.find((c) => ![ground, ink, primary].includes(c) && /secondary|accent|highlight|signal/.test(`${c.role} ${c.name} ${c.token}`.toLowerCase()) && !['States', 'Text', 'Surfaces', 'Lines'].includes(colourGroup(c)));
  return { ground, ink, primary, second };
}

function fontOf(data: BrandData, role: RegExp): BrandFamily | undefined {
  return data.families.find((f) => role.test(f.role)) ?? data.families[0];
}

/** Which group a colour that is not one of the core colours belongs to, by its role, name and token. */
function colourGroup(c: BrandColor): string {
  const s = `${c.role} ${c.name} ${c.token}`.toLowerCase();
  if (/illu|illustration|chart|data-|project|process|portrait|extrusion/.test(s)) return 'Illustration';
  if (/error|danger|warn|success|info|focus|disabled|hover|active|pressed|selected|visited|positive|negative/.test(s)) return 'States';
  if (/border|line|divider|rule|hair|stroke|outline/.test(s)) return 'Lines';
  if (/text|ink|foreground|on-/.test(s)) return 'Text';
  if (/surface|paper|background|ground|canvas|card|panel|inset|section|sheet/.test(s)) return 'Surfaces';
  return 'Supporting';
}
/** Words that lead into what follows, so a cut phrase must not end on them. */
const LEADING_WORDS = /^(und|oder|aber|bis|zur|zum|zu|der|die|das|den|dem|des|ein|eine|einen|einem|für|mit|aus|von|vom|im|in|an|am|auf|bei|nach|über|unter|ohne|durch|als|wie|dass|the|and|or|but|to|of|for|with|from|by|a|an|in|on|at|as|that|your|our|its|their|is|are|was)$/i;
const GROUP_ORDER = ['Text', 'Surfaces', 'Supporting', 'Lines', 'States', 'Illustration'];

/** A logo's width over its height: as recorded, else from its SVG's viewBox. */
function logoAspect(l: BrandLogo): number | undefined {
  if (l.aspect) return l.aspect;
  const m = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(l.svg ?? '');
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : undefined;
}

/**
 * The logo at its own proportions inside the box, so that no empty margin of the box moves it off the line it is
 * aligned to. `ground` is the colour it was made for, recorded on the element for the book's own check.
 */
function logoPictureRaw(l: BrandLogo, box0: { w: number; h: number }, extra = '', ground?: string): string {
  const a = logoAspect(l);
  const box = a ? (box0.w / box0.h > a ? { w: Math.round(box0.h * a), h: box0.h } : { w: box0.w, h: Math.round(box0.w / a) }) : box0;
  // Recorded as a custom property: the only kind of mark that survives the book's import into a document.
  const g = ground ? { '--bb-ground': ground } : {};
  return l.asset
    ? `<img src="${escapeAttr(l.asset)}" alt="${escapeAttr(l.name)}" style="${css({ width: `${box.w}px`, height: `${box.h}px`, 'object-fit': 'contain', display: 'block', flex: 'none', ...g })};${extra}">`
    : `<div role="img" aria-label="${escapeAttr(l.name)}" style="${css({ width: `${box.w}px`, height: `${box.h}px`, display: 'flex', 'align-items': 'center', 'justify-content': /object-position:\s*left/.test(extra) ? 'flex-start' : 'center', flex: 'none', ...g })};${extra}">${(l.svg ?? '').replace(/<svg\b([^>]*)>/, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height|preserveAspectRatio)="[^"]*"/g, '')} width="100%" height="100%" preserveAspectRatio="${/object-position:\s*left/.test(extra) ? 'xMinYMid' : 'xMidYMid'} meet">`)}</div>`;
}

/**
 * What the brand's own rules say about how type, frames and pictures look, read from its rule texts, so that the book
 * obeys them: a display face "in capitals only" is set in capitals, "headlines in X italic" are set italic, a brand
 * without shadows or dashed lines gets none, and "no screenshots of other brands" keeps them out. The book's root
 * carries it as data-policy, and scripts/check-brand-book-render.ts fails a page that breaks it.
 */
export interface BookPolicy {
  /** The family the brand sets in capitals only. */
  upperFamily?: string;
  /** The family whose headlines are italic. */
  italicFamily?: string;
  /** The family the brand names for headings, when it is not its display family. */
  headingFamily?: string;
  /** No capitals anywhere (beyond what the text already has). */
  noUpper: boolean;
  noShadow: boolean;
  /** The brand's own hard offset shadow, in px. */
  hardShadow?: number;
  noDashed: boolean;
  noOtherBrandScreens: boolean;
  noWindowChrome: boolean;
  /** The width (font-stretch, in %) the brand sets its display sizes at, e.g. "width 112 to 125%". */
  displayStretch?: number;
  /** Screenshots are shown whole, never cropped ("in vollem Seitenverhältnis", "uncropped"). */
  uncroppedScreens: boolean;
  /** Portraits (or all photos) are shown in greyscale. */
  grayscale?: 'portraits' | 'photos';
  /** The wordmark the brand sets in capitals ("the BOGEN wordmark"): its logos named so lead. */
  capsWordmark?: string;
  /** A headline says one thing: no double slogans, no short sentences set against each other. */
  oneStatement: boolean;
  /** Headlines the brand names as the exception to that, with where they belong. */
  statementExceptions: string[];
  /** The brand speaks as one person ("ich", "I") and never as "wir" or "we". */
  singular: boolean;
  /** Colours the brand never sets as a field ("Tomato is never a band, page or field background"), by value. */
  noField: string[];
  /** How a letter addresses its reader when the brand says so apart from its usual address ("postalischer Erstkontakt: Sie"). */
  letterAddress?: 'sie' | 'du';
}

export function bookPolicy(data: BrandData): BookPolicy {
  const sentences = data.rules.flatMap((r) => sentencesOf(r.text).map((s) => ({ s, kind: r.kind, check: r.check })));
  const familyIn = (s: string) => data.families.map((f) => ({ f, at: s.toLowerCase().indexOf(f.family.toLowerCase()) })).filter((x) => x.at >= 0 && x.f.family.length > 2).sort((a, b) => a.at - b.at || b.f.family.length - a.f.family.length)[0]?.f;
  const CAPS = /(?<!\p{L})(versalien|großbuchstaben|grossbuchstaben|all caps|capitals|uppercase|caps only|majuskeln)(?!\p{L})/iu;
  const NEGATED_CAPS = /(?<!\p{L})(no|keine|nicht|never|nie|without|ohne)(?!\p{L})[^.]{0,20}(versalien|großbuchstaben|all caps|capitals|uppercase)/iu;
  const upper = sentences.find((x) => x.kind === 'do' && CAPS.test(x.s) && !NEGATED_CAPS.test(x.s) && familyIn(x.s));
  const noUpper = data.rules.some((r) => r.check?.type === 'no-uppercase') || sentences.some((x) => NEGATED_CAPS.test(x.s) || (x.kind === 'dont' && CAPS.test(x.s)));
  const ITALIC = /(?<!\p{L})(italic|kursiv)(?!\p{L})/iu;
  const HEADS = /(?<!\p{L})(headlines?|headings?|überschriften|titles?|titel)(?!\p{L})/iu;
  const italic = sentences.find((x) => x.kind === 'do' && ITALIC.test(x.s) && HEADS.test(x.s) && !/\b(never|nie|not|nicht|no|kein)\b[^.,]{0,12}\b(italic|kursiv)/i.test(x.s.split(/[.;]/)[0] ?? '') && familyIn(x.s));
  // "Space Grotesk für Überschriften und Lesetext": the family named for headings in a clause of its own.
  const headingClause = sentences.flatMap((x) => x.s.split(/[,;]\s*/).map((c) => ({ c, kind: x.kind }))).find((x) => x.kind === 'do' && /(?<!\p{L})(für|for)(?!\p{L})[^.]{0,6}(überschriften|headings|headlines)(?!\p{L})/iu.test(x.c) && familyIn(x.c));
  const display = data.families.find((f) => /display|head/i.test(f.role));
  const headingFamily = headingClause && familyIn(headingClause.c)?.family !== display?.family ? familyIn(headingClause.c)?.family : undefined;
  const all = data.rules.map((r) => r.text).join(' ');
  const hard = /(versatzschatten|offset shadow|hard shadow|harter? schatten)[^.]{0,40}?(\d{1,2})\s*px/i.exec(all);
  // "Display at weight 800 to 900, width 112 to 125 %": the display sizes are set that wide.
  const stretch = /(?:width|breite|stretch|wdth)\s*(1[0-4]\d)\s*(?:%|to|bis|–|-)/i.exec(all);
  const gray = /[^.]*(graustufen|grayscale|greyscale|schwarz-?weiß|black and white|monochrome photos?)[^.]*/i.exec(all);
  const name = data.fields.name ?? '';
  const upperName = name.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const capsWord = name.length >= 3 && name !== name.toUpperCase() && (new RegExp(`\\b${upperName}\\b[^.]{0,20}\\b(wordmark|wortmarke)`).test(all) || new RegExp(`\\b(wordmark|wortmarke)\\b[^.]{0,12}\\b${upperName}\\b`, 'i').test(all)) ? name.toUpperCase() : undefined;
  // "Überschriften enthalten genau eine klare Aussage: keine Doppel-Slogans, keine gegeneinandergestellten Kurzsätze."
  const STATEMENT = /doppel-?slogans?|gegeneinander\w*\s+kurzs[äa]tze|genau eine (?:klare )?aussage|one (?:clear )?(?:statement|message|idea) (?:per|in each|in every) (?:headline|heading)|(?:double|twin) slogans?|no (?:two|paired) short sentences/i;
  const statementRule = data.rules.find((r) => STATEMENT.test(r.text));
  const oneStatement = !!statementRule;
  // "Einzige Ausnahme ist der Startseiten-Hero „Kunden gewinnen. Abläufe vereinfachen.“": the quoted headline.
  const exceptions = statementRule ? [...statementRule.text.matchAll(/(?:ausnahme|except|exception)[^„“"]{0,60}[„“"]([^“”"]{3,120})[“”"]/gi)].map((m) => m[1]!.trim()) : [];
  // One person: the brand's own words say "ich" or "I" and never "wir" or "we".
  const own = [data.fields.positioning, data.fields.tone, data.fields.audience].map((x) => String(x ?? '')).join(' ');
  const singular = /(?<!\p{L})([Ii]ch|[Mm]ich|[Mm]ir|[Mm]ein\w*|I|I'm|[Mm]y|me)(?!\p{L})/u.test(own) && !/(?<!\p{L})(wir|uns|unser\w*|we|our|us)(?!\p{L})/iu.test(own);
  // "Unbekannter postalischer B2B-Erstkontakt: Sie": letters address the reader as the brand says for post.
  const postal = sentences.find((x) => /postalisch|\bbrief\w*|anschreiben|\bletters?\b|\bpost\b/i.test(x.s) && /(?<!\p{L})(Sie|du)(?!\p{L})/u.test(x.s));
  const letterAddress = postal ? (/(?<!\p{L})Sie(?!\p{L})/u.test(postal.s.replace(/^Sie\b/, '')) ? 'sie' as const : 'du' as const) : undefined;
  const noShadow = data.fields.shadows === 'none' || data.rules.some((r) => r.check?.type === 'no-shadow') || /\b(no|keine)\b[^.]{0,30}\b(shadows?|schatten)\b/i.test(all);
  return {
    ...(upper ? { upperFamily: familyIn(upper.s)!.family } : {}),
    ...(italic ? { italicFamily: familyIn(italic.s)!.family } : {}),
    ...(headingFamily ? { headingFamily } : {}),
    noUpper: noUpper && !upper,
    noShadow: noShadow && !hard,
    ...(hard ? { hardShadow: Math.min(12, Number(hard[2])) } : {}),
    noDashed: /\b(no|keine|without|ohne)\b[^.]{0,40}\b(dashed|gestrichelt)/i.test(all),
    noOtherBrandScreens: /screenshots? of other (brands|products)|other brands'? screenshots|screenshots? (anderer|fremder) marken/i.test(all),
    noWindowChrome: true,
    ...(stretch ? { displayStretch: Math.min(150, Math.max(100, Number(stretch[1]))) } : {}),
    uncroppedScreens: /(voll(?:em|en)? seitenverhältnis|nicht (?:be)?schnitten|unbeschnitten|ungeschnitten|full aspect ratio|uncropped|never crop(?:ped)?|not cropped|whole screenshots?)/i.test(all),
    ...(gray ? { grayscale: /porträt|portrait|headshot|person/i.test(gray[0]) ? 'portraits' as const : 'photos' as const } : {}),
    ...(capsWord ? { capsWordmark: capsWord } : {}),
    oneStatement,
    statementExceptions: oneStatement ? exceptions : [],
    singular,
    ...(letterAddress ? { letterAddress } : {}),
    noField: data.colors.filter((c) => c.name.trim().length > 2 && sentences.some((x) => x.s.toLowerCase().includes(c.name.trim().toLowerCase()) && /(?<!\p{L})(never|nie|niemals|not|kein\w*|no)(?!\p{L})[^.]{0,50}(?<!\p{L})(bands?|pages?|fields?|backgrounds?|fläche|flächen|hintergrund|hintergründe|bänder|band)(?!\p{L})/iu.test(x.s.slice(x.s.toLowerCase().indexOf(c.name.trim().toLowerCase()))))).map((c) => c.value.toLowerCase()),
  };
}

/**
 * Copy the book sets as a sample of the brand's voice is held to the brand's own voice rules: voice_check's measures
 * (address, sentence and heading length, number format, its spelling of its terms), the words it avoids, the person it
 * speaks as, and one statement per headline. A line that fails is not used. scripts/check-brand-book-render.ts runs the
 * same test over every sample on the rendered pages (marked --bb-sample).
 */
export function bookVoice(data: BrandData, policy: BookPolicy = bookPolicy(data)) {
  const avoidWords = data.words.filter((w) => w.use === 'avoid' && w.word.trim()).map((w) => w.word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const avoidRe = avoidWords.length ? new RegExp(`(?<!\\p{L})(${avoidWords.join('|')})(?!\\p{L})`, 'iu') : null;
  const voiceIssue = (text: string, tag: string) => { try { return voiceFindings(data, [{ id: '', name: '', tag, text }]).some((x) => x.rule !== 'voice.required' && x.rule !== 'voice.address-mixed'); } catch { return false; } };
  const wrongPerson = (text: string) => policy.singular && /(?<!\p{L})(wir|uns|unser\w*|we|our|us)(?!\p{L})/iu.test(text);
  const sameText = (a: string, b: string) => a.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() === b.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  /** A line of copy the brand would write. */
  const copyOk = (text: string) => !!text && !wrongPerson(text) && !avoidRe?.test(text) && !voiceIssue(text, 'p');
  /** A headline the brand would write: one statement, unless the brand names it as the exception (on its home page). */
  const headlineOk = (text: string, home = false) => !!text && !wrongPerson(text) && !avoidRe?.test(text) && !voiceIssue(text, 'h1') && (!policy.oneStatement || sentencesOf(text).length <= 1 || (home && policy.statementExceptions.some((x) => sameText(x, text))));
  /** Copy for a letter: in the address the brand names for post, when it names one. */
  const DU = /(?<!\p{L})(du|dich|dir|dein\w*)(?!\p{L})/iu, SIE = /(?<!^|[.!?]\s)(?<!\p{L})(Sie|Ihnen|Ihr\w*)(?!\p{L})/u;
  const letterOk = (text: string) => (policy.letterAddress === 'sie' ? !DU.test(text) : policy.letterAddress === 'du' ? !SIE.test(text) : true);
  return { copyOk, headlineOk, sameText, letterOk };
}

/** The display and heading families with the brand's own case and slant, added to every element set in them. */
function applyPolicy(html: string, data: BrandData, policy: BookPolicy): string {
  let out = html;
  for (const f of data.families) {
    const upper = policy.upperFamily === f.family;
    const italic = policy.italicFamily === f.family;
    if (!upper && !italic) continue;
    const decl = `font-family:${escapeAttr(familyStack(f))}`;
    out = out.split(decl).join(`${decl};${upper ? 'text-transform:uppercase;letter-spacing:0.01em' : ''}${upper && italic ? ';' : ''}${italic ? 'font-style:italic;padding-left:0.08em' : ''}`);
  }
  // The display sizes at the width the brand sets them: every line of 40px and more in the display family, and every
  // heading of 20px and more set at a display weight when the display family is also the text face.
  const display = data.families.find((f) => /display|head/i.test(f.role));
  if (policy.displayStretch && display) {
    const decl = `font-family:${escapeAttr(familyStack(display))}`;
    out = out.replace(/style="([^"]*)"/g, (m, st: string) => {
      const size = /(?:^|;)font-size:(\d+(?:\.\d+)?)px/.exec(st);
      // A family that is also the text face is display only at its display weights.
      const weight = Number(/(?:^|;)font-weight:(\d+)/.exec(st)?.[1] ?? 400);
      const shared = data.families.some((x) => x !== display && x.family === display.family);
      const isDisplay = !shared || weight >= Math.min(...(display.weights.length ? display.weights : [700]));
      return st.includes(decl) && size && Number(size[1]) >= (shared ? 20 : 40) && isDisplay && !st.includes('font-stretch') ? `style="${st};font-stretch:${policy.displayStretch}%"` : m;
    });
  }
  return out;
}

/**
 * Text as a typesetter sets it, between the tags of a page: curly quotation marks and apostrophes in the book's language,
 * and hex values in capitals, so that "#0a0a0a" and "#0A0A0A" never stand on the same book. Style elements are left alone.
 */
export function typeset(html: string, lang: 'de' | 'en', name = ''): string {
  // A person's name that ends in the brand's name ("Marsel Nenaj") is never broken across lines.
  const glue = name.trim().length > 2 ? new RegExp(`(\\p{Lu}\\p{Ll}+) (${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?!\\p{L})`, 'giu') : null;
  return html.split(/(<style[\s\S]*?<\/style>)/).map((part) => part.startsWith('<style') ? part : part.replace(/>([^<]+)</g, (_m, text: string) => `>${glue ? typesetText(text, lang).replace(glue, '$1\u00a0$2') : typesetText(text, lang)}<`)).join('');
}
export function typesetText(text: string, lang: 'de' | 'en'): string {
  // One way to write a size: "820 px" and "1440px" become "820px" and "1440px".
  let s = text.replace(/(?<![&\w])#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/gi, (m) => m.toUpperCase()).replace(/(\d) px\b/g, '$1px');
  s = s.replace(/(?<=\p{L})'(?=\p{L})/gu, '\u2019').replace(/(?<=\p{L}s)'(?=[\s,.;:!?)]|$)/gu, '\u2019').replace(/'(?=\d\ds\b)/g, '\u2019');
  s = s.replace(/(^|[\s(\[\u00a0])'/g, `$1${lang === 'de' ? '\u201a' : '\u2018'}`).replace(/'/g, lang === 'de' ? '\u2018' : '\u2019');
  s = s.replace(/(^|[\s(\[\u00a0])"/g, `$1${lang === 'de' ? '\u201e' : '\u201c'}`).replace(/"/g, lang === 'de' ? '\u201c' : '\u201d');
  return s;
}

export function brandBookPages(data: BrandData, opts: BrandBookOptions = {}): BrandBookPage[] {
  const f = data.fields;
  const name = f.name || 'Brand';
  const lang = brandBookLanguage(data);
  const t = (s: string) => (lang === 'de' ? DE[s] ?? s : s);
  const body = fontOf(data, /body|text/);
  const display = fontOf(data, /display|head/);
  const mono = data.families.find((x) => /mono|code/.test(x.role));
  const bodyFont = body ? familyStack(body) : 'system-ui, sans-serif';
  const displayFont = display ? familyStack(display) : bodyFont;
  const displayWeight = display?.weights.length ? Math.max(...display.weights) : 700;
  const monoFont = mono ? familyStack(mono) : 'ui-monospace, monospace';
  const { ground, ink, primary, second } = rolesOf(data);
  // The book is printed on the brand's own paper when it has a light one, in its own ink when that reads; the accent
  // marks the folios and the rule under the running head.
  const PAPER = ground && luminance(ground.value) > 0.62 ? ground.value : PAPER_WHITE;
  const INK = ink && contrastRatio(ink.value, PAPER) >= 7 ? ink.value : INK_BLACK;
  const DIM = contrastRatio(mixHex(INK, PAPER, 0.32), PAPER) >= 4.6 ? mixHex(INK, PAPER, 0.32) : INK;
  const RULE = mixHex(INK, PAPER, 0.86);
  const TINT = mixHex(INK, PAPER, 0.95);
  const ACCENT = primary && contrastRatio(primary.value, PAPER) >= 3 ? primary.value : INK;
  // Do and don't in the brand's own colours: do in its ink, don't in its error colour when it has one that reads, else
  // in its ink too, struck through or crossed. No green or red the brand does not have.
  const errorColour = data.colors.find((c) => /error|danger|fehler|negative/i.test(`${c.role} ${c.name} ${c.token}`) && contrastRatio(c.value, PAPER) >= 4.5);
  const GOOD = INK;
  const BAD = errorColour?.value ?? INK;
  const AMBER = DIM;
  /** The best of the brand's own colours to set text in on a ground: its ink or paper when they read, else black or white. */
  const textOn = (bg: string, min = 4.5) => {
    const options = [ink?.value, ground?.value, primary?.value, '#111111', '#ffffff'].filter((x): x is string => !!x && x !== bg);
    return options.find((c) => contrastRatio(c, bg) >= min) ?? (contrastRatio('#111111', bg) >= contrastRatio('#ffffff', bg) ? '#111111' : '#ffffff');
  };
  const policy = bookPolicy(data);
  const { copyOk, headlineOk, sameText, letterOk } = bookVoice(data, policy);
  /** The longest run of whole sentences of `text`, up to `max` characters, that the brand would write as one paragraph. */
  const passageOf = (text: string, max: number) => {
    const all = sentencesOf(text);
    let best = '';
    for (let i = 0; i < all.length; i++) {
      let acc = '';
      for (let k = i; k < all.length; k++) {
        const next = acc ? `${acc} ${all[k]}` : all[k]!;
        if (next.length > max || !copyOk(next)) break;
        acc = next;
      }
      if (acc.length > best.length) best = acc;
    }
    return best;
  };
  // Headings are set in the family the brand names for them; display sizes in its display family.
  const headingFam = policy.headingFamily ? data.families.find((x) => x.family === policy.headingFamily) : undefined;
  const headingFont = headingFam ? familyStack(headingFam) : displayFont;
  // Headings in the display family take its lightest display weight ("Display at weight 800 to 900"), not a weight it does
  // not name.
  const headingWeight = headingFam ? (headingFam.weights.includes(700) ? 700 : headingFam.weights.includes(600) ? 600 : Math.max(...(headingFam.weights.length ? headingFam.weights : [600]))) : display?.weights.length ? Math.min(...display.weights) : 700;
  /** A soft lift for the pieces on the desk, or the brand's own hard offset shadow, or none where the brand has none. */
  const lift = policy.noShadow ? `box-shadow:inset 0 0 0 1px ${'#00000026'}` : policy.hardShadow ? `box-shadow:${policy.hardShadow}px ${policy.hardShadow}px 0 ${ink?.value ?? INK_BLACK}` : 'box-shadow:0 1px 2px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.10)';
  const dashed = policy.noDashed ? 'solid' : 'dashed';
  const langs = brandLanguages(data);
  const P = (text: string | undefined) => presentable(text, lang);
  /** What the brand says about itself as rules and notes on its tone: never set as a sample of its copy. */
  const ruleTexts = [...data.rules.map((r) => r.text), String(f.tone ?? ''), String((f as { address?: string }).address ?? '')].filter(Boolean);
  /** A name as a reader should see it: no hex values, ids or source notes in it. */
  const cleanName = (s: string) => s.replace(/\s*\(?\bsource [a-z0-9]{6,}\)?/gi, '').replace(/\s*#[0-9a-f]{3,8}\b/gi, '').replace(/\s*\((?:suggestion|vorschlag)\)/gi, '').replace(/\s{2,}/g, ' ').replace(/[\s·:–-]+$/, '').trim();
  const ROLE_DE: Record<string, string> = { primary: 'Primärfarbe', secondary: 'Sekundärfarbe', accent: 'Akzent', action: 'Aktion', brand: 'Markenfarbe', text: 'Schrift', ink: 'Schrift', foreground: 'Schrift', background: 'Grund', ground: 'Grund', paper: 'Papier', canvas: 'Grund', surface: 'Fläche', border: 'Linie', line: 'Linie', divider: 'Linie', error: 'Fehler', danger: 'Fehler', success: 'Erfolg', warning: 'Warnung', info: 'Hinweis', focus: 'Fokus', hover: 'Hover', muted: 'gedämpft', secondary_text: 'Nebentext', highlight: 'Hervorhebung', link: 'Link', illustration: 'Illustration', inverse: 'invers', strong: 'kräftig', soft: 'weich', raised: 'erhöht', inset: 'vertieft' };
  /** A colour's role in words, in the book's language: "primary-hover" becomes "Primärfarbe, Hover". */
  const roleWords = (role: string) => {
    const parts = role.toLowerCase().replace(/#[0-9a-f]{3,8}/g, '').split(/[\s_-]+/).filter(Boolean);
    if (!parts.length) return '';
    const words = parts.map((w) => (lang === 'de' ? ROLE_DE[w] ?? w : w));
    const out = words.join(lang === 'de' ? ', ' : ' ');
    return out.charAt(0).toUpperCase() + out.slice(1);
  };
  /** The colour's own name; a name that is only its role or a hex value is replaced by its role in words. */
  const baseName = (c: BrandColor) => {
    const n = cleanName(c.name);
    if (!n || /^(primary|secondary|accent|text|ink|background|ground|surface|border|foreground|brand)$/i.test(n) || n.toLowerCase() === c.role.toLowerCase().trim()) return roleWords(n || c.role) || n;
    return n;
  };
  // Colours that would read the same ("Schrift", "Schrift") are told apart by number, lightest first.
  const sameName = new Map<string, BrandColor[]>();
  // The core colours keep their plain names ("Schrift"); only the others that would read the same are numbered.
  const coreSet = [ground, ink, primary, second].filter(Boolean);
  for (const c of data.colors) { if (coreSet.includes(c)) continue; const k = baseName(c).toLowerCase(); sameName.set(k, [...(sameName.get(k) ?? []), c]); }
  for (const list of sameName.values()) list.sort((a, b) => luminance(b.value) - luminance(a.value));
  const colourName = (c: BrandColor) => {
    const n = baseName(c);
    const list = sameName.get(n.toLowerCase()) ?? [];
    return list.length > 1 && list.includes(c) ? `${n} ${list.indexOf(c) + 1}` : n;
  };
  /** The role under the name, unless it says the same. */
  const roleLabel = (c: BrandColor) => { const r = roleWords(c.role); return r && r.toLowerCase() !== colourName(c).toLowerCase() ? r : ''; };
  /** A token whose name claims a value it does not hold (a hex in the name that is not its colour) is left out. */
  const honestToken = (token: string, value: string) => { const m = /(?:^|-)([0-9a-f]{6})(?:$|-)/i.exec(token); return !m || `#${m[1]!.toLowerCase()}` === value.toLowerCase().slice(0, 7); };
  const appendix: string[] = [];
  const logoGround = (l: BrandLogo) => resolveBrandColor(data, l.background)?.value ?? normalizeColor(l.background) ?? (l.background === 'dark' ? (ink?.value ?? '#111111') : (ground?.value ?? '#ffffff'));
  const logoPicture = (l: BrandLogo, box: { w: number; h: number }, extra = '') => logoPictureRaw(l, box, extra, logoGround(l));
  /** A logo made for this ground: the same colour within a small distance, not merely a similar lightness. */
  const madeFor = (l: BrandLogo, bg: string) => colorDistance(logoGround(l), bg) < 10;
  // A mark, not a wordmark: "Wordmark" and "Wortmarke" are lockups of the name.
  const compactName = /revers|negativ|dark|dunkel|mono|small|klein|icon|(?<!word|wort)mark|symbol|zeichen|favicon|bildmarke/i;
  // A brand that names its wordmark in capitals ("the BOGEN wordmark") leads with that wordmark, so that the cover,
  // the logo page and the pieces all show the one mark the rules describe.
  const capsLead = policy.capsWordmark && policy.noUpper ? data.logos.find((l) => /wordmark|wortmarke/i.test(l.name) && !/revers|negativ|dark|dunkel|on |auf /i.test(l.name)) ?? data.logos.find((l) => /wordmark|wortmarke/i.test(l.name)) : undefined;
  const primaryLockup: BrandLogo | undefined = capsLead ?? data.logos.find((l) => !compactName.test(l.name) && (logoAspect(l) ?? 2) >= 1.4) ?? data.logos.find((l) => !/revers|negativ|dark|dunkel/i.test(l.name)) ?? data.logos[0];
  /** An item's text: one tagged with its own language keeps it, the rest are held to the book's language. */
  const PI = (r: { text: string; lang?: string }) => (r.lang && !r.lang.startsWith(lang) ? presentable(r.text) : P(r.text));
  const chapter = (id: BrandBookChapterId) => {
    const c = data.book?.chapters.find((x) => x.id === id);
    return c && c.status !== 'not-applicable' && c.markdown.trim() ? c : undefined;
  };
  const langAttr = (c: { lang?: string; markdown: string } | undefined) => {
    const tag = chapterLanguage(c, langs);
    return tag ? ` lang="${escapeAttr(tag)}"` : '';
  };
  // An item in another language than the brand's first says so, for screen readers and hyphenation; one in the
  // first language needs nothing, as the page already says it.
  const otherLang = (e: { lang?: string }) => { const tag = itemLanguage(e, langs.primary); return tag && tag !== ALL_LANGUAGES && tag !== langs.primary ? tag : null; };
  const said = (e: { lang?: string }, text: string) => { const tag = otherLang(e); return tag ? `<span lang="${escapeAttr(tag)}">${esc(text)}</span>` : esc(text); };
  const itemLang = (e: { lang?: string }) => { const tag = otherLang(e); return tag ? ` lang="${escapeAttr(tag)}"` : ''; };
  // Approval state is one block in the colophon, not a tag on every value: a book a client reads shows the brand.
  const mark = (_item: { suggested?: boolean }) => '';
  /** A rule's text that already says no ("Keine …", "Do not …") takes no "Never" before it: no double negatives. */
  const saysNo = (text: string) => /^(no|not|never|don't|do not|avoid|without|kein\w*|nicht|nie|niemals|vermeide\w*|ohne|lass\w*)\b/i.test(text.trim());
  /** The label of a rule: how binding it is, or "Never" for a don't that does not say no itself; and, for a rule the
   * brand has not confirmed, that it is a proposal. */
  /** A rule that says what something is only for ("„System“ nur konkret technisch") binds like a must, not a never. */
  const restricts = (text: string) => /(?<!\p{L})(nur|only|ausschließlich|solely|exclusively)(?!\p{L})/iu.test(text);
  const ruleTag = (r: { text: string; kind: 'do' | 'dont'; severity?: string; suggested?: boolean }, size = 12) => {
    // Notes of the page that are not rules carry no level.
    if (r.severity === 'none') return '<span></span>';
    const never = r.kind === 'dont' && !saysNo(r.text) && !restricts(r.text);
    const hard = r.severity === 'hard';
    // Must and never are set strong; should and avoid lighter, so the two levels read apart at a glance.
    const color = never ? (hard ? BAD : mixHex(BAD, PAPER, 0.25)) : hard ? GOOD : DIM;
    // The level, said so that it reads before a rule that says no as well as before one that says do.
    const word = never ? t(hard ? 'Never' : 'Avoid') : t(hard ? 'Binding' : 'Guidance');
    return `<span style="${css({ display: 'flex', 'flex-direction': 'column', gap: '1px', 'font-family': bodyFont, flex: 'none' })}"><span style="${css({ 'font-size': `${size}px`, 'line-height': `${Math.round(size * 1.6)}px`, 'font-weight': hard ? 700 : 500, color })}">${esc(word)}</span>${r.suggested ? `<span style="${css({ 'font-size': '11px', 'line-height': '14px', color: DIM })}">${esc(t('Proposal'))}</span>` : ''}</span>`;
  };
  const draftNote = (_c: { status: string } | undefined) => '';
  /** The first presentable paragraph of a chapter, for the introduction on a section's rail. */
  const introOf = (text: string | undefined) => {
    if (!text) return '';
    const block = text.trim().split(/\n\s*\n/).filter((b) => !/^\s*([-*] |\d+[.)]\s|\||```|>|#)/.test(b)).map((b) => P(b)).find((b) => b.length > 40 && !/[{}]|: \d+px/.test(b));
    return block ? upTo(block, 300) : '';
  };

  // ------------------------------------------------------------ type set pieces
  const label = (text: string, extra: Record<string, string | number> = {}) => `<p style="${css({ margin: 0, 'font-size': '13px', 'line-height': '18px', color: DIM, 'font-family': bodyFont, 'text-wrap': 'pretty', ...extra })}">${text}</p>`;
  const small = (text: string, extra: Record<string, string | number> = {}) => `<p style="${css({ margin: 0, 'font-size': '15px', 'line-height': '22px', color: INK, 'font-family': bodyFont, 'overflow-wrap': 'break-word', 'min-width': 0, 'text-wrap': 'pretty', ...extra })}">${text}</p>`;
  const h3 = (text: string) => `<h3 style="${css({ margin: 0, 'font-size': '18px', 'line-height': '24px', 'font-weight': 600, color: INK, 'font-family': bodyFont })}">${text}</h3>`;
  // Columns are always one gutter apart, so that they sit on the book's grid; `gap` is the space between rows.
  const grid = (cols: string, inner: string, gap = 24, extra: Record<string, string | number> = {}) => `<div class="bb-grid" style="${css({ display: 'grid', 'grid-template-columns': cols, 'column-gap': `${GUTTER}px`, 'row-gap': `${gap}px`, ...extra })}">${inner}</div>`;
  const stack = (gap: number, inner: string, extra: Record<string, string | number> = {}) => `<div style="${css({ display: 'flex', 'flex-direction': 'column', gap: `${gap}px`, 'min-width': 0, ...extra })}">${inner}</div>`;
  // One size for every token under a swatch; a long one breaks at its hyphens rather than shrinks.
  const tokenLine = (token: string, _width: number, color = DIM) => `<p style="${css({ margin: 0, 'font-size': '12px', 'line-height': '16px', 'font-family': monoFont, color, 'overflow-wrap': 'anywhere' })}">--${esc(token).replace(/-/g, '-<wbr>')}</p>`;

  /** The average glyph width of a face as a share of its size: wider in capitals and in heavy faces. */
  function glyphOf(fam: BrandFamily): number {
    const caps = policy.upperFamily === fam.family;
    const heavy = /black|heavy|ultra|fat/i.test(fam.family) || Math.max(0, ...fam.weights) >= 800;
    const wide = policy.displayStretch && display && fam.family === display.family ? policy.displayStretch / 100 : 1;
    return (caps ? (heavy ? 0.88 : 0.76) : heavy ? 0.7 : 0.58) * wide;
  }
  const heavyFace = (fam?: BrandFamily) => !!fam && (/black|heavy|ultra|fat/i.test(fam.family) || Math.max(0, ...fam.weights) >= 800);
  const displayGlyph = display ? glyphOf(display) : 0.56;
  const headFam = headingFam ?? display;
  /** The heading face is one that sets a sentence well: not heavy, not capitals only, and not the body face itself. */
  const headingIsText = !!headFam && !heavyFace(headFam) && policy.upperFamily !== headFam.family && headingFont !== bodyFont;
  /**
   * A statement in the display face when it takes at most `maxLines` lines at a display size; longer text is set in
   * the body face at the lead size instead, as a studio would: display type is for a few words, not a paragraph.
   */
  const displayOrLead = (text: string, maxSize: number, width: number, maxLines = 3, color = INK, minSize = 40, sample = '') => {
    const mark = sample ? { '--bb-sample': sample } : {};
    const longest = Math.max(...text.split(/\s+/).map((w) => w.length));
    for (let size = maxSize; size >= minSize; size -= 4) {
      if (linesFor(text, width, size, displayGlyph) <= maxLines && longest * size * displayGlyph <= width * 0.96) return `<p class="bb-xl" style="${css({ ...mark, margin: 0, 'font-size': `${size}px`, 'line-height': 1.08, 'letter-spacing': '-0.02em', color, 'font-family': displayFont, 'font-weight': displayWeight, 'max-width': `${width}px`, 'text-wrap': 'balance' })}" dir="auto">${esc(text)}</p>`;
    }
    const lead = text.length <= 150 ? 36 : text.length <= 240 ? 30 : 26;
    // A heading face made for text (a serif, a book weight) carries a longer statement too: headings stay in the
    // heading face. Only a heavy or capitals-only display face hands longer text to the body face.
    return `<p style="${css({ ...mark, margin: 0, 'font-size': `${lead}px`, 'line-height': 1.3, color, 'font-family': headingIsText ? headingFont : bodyFont, 'font-weight': headingIsText ? headingWeight : 500, 'max-width': `${width}px`, 'text-wrap': 'pretty' })}" dir="auto">${esc(text)}</p>`;
  };
  /** Text for a heading-sized line: the heading face when it stays within three lines or is made for text, else the body face. */
  const headingOrBody = (text: string, size: number, width: number) => headingIsText || linesFor(text, width, size, 0.56) <= 3 ? headingFont : bodyFont;

  /** A few rules set large, numbered, as statements: what a page of only two or three short rules looks like on purpose. */
  /**
   * A few rules set large: the same component as every list of rules (the level in a column, the rule in the body face),
   * at a larger size, so that a page of two or three rules reads as chosen and not as a list cut short.
   */
  /**
   * What a rule looks like when the brand's own material can show it: the colours it gives a job to, each with that job,
   * or the faces it names, each setting a line of the brand's own in the way the rule says. Nothing else is drawn.
   */
  const ruleDemo = (r: { text: string }): string => {
    const clauses = r.text.split(/[.;]\s*|,\s+(?=\p{Lu})/u).map((x) => x.trim()).filter(Boolean);
    const esc2 = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "Pink for events, blue for buying and selling": a field of each colour with its job.
    const jobs = data.colors.filter((c) => c.name.trim().length > 2).flatMap((c) => r.text.split(/[,;.]/).map((cl) => new RegExp(`(?<!\\p{L})${esc2(c.name.trim())}(?!\\p{L})\\s+(?:is\\s+)?(?:for|für)\\s+(.+)`, 'iu').exec(cl.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => ({ c, job: m[1]!.trim() })));
    if (jobs.length >= 1) return `<div style="${css({ '--bb-kind': 'swatch', display: 'flex', gap: '12px' })}">${jobs.slice(0, 3).map(({ c, job }) => `<div style="${css({ flex: '1 1 0', height: '150px', background: c.value, 'box-shadow': `inset 0 0 0 1px ${RULE}`, padding: '14px 16px', display: 'flex', 'flex-direction': 'column', 'justify-content': 'space-between', 'min-width': 0 })}"><span style="${css({ 'font-size': '15px', 'font-weight': 600, color: textOn(c.value), 'font-family': bodyFont })}">${esc(colourName(c))}</span><span style="${css({ 'font-size': '15px', 'line-height': 1.3, color: textOn(c.value), 'font-family': bodyFont })}">${esc(job)}</span></div>`).join('')}</div>`;
    // "Headlines in Bodoni Moda italic. Facts in Work Sans, never italic.": each face sets a line of the brand's own.
    const named = clauses.map((cl) => ({ cl, fam: [...data.families].sort((a, b) => b.family.length - a.family.length).find((x) => x.family.length > 2 && cl.toLowerCase().includes(x.family.toLowerCase())) })).filter((x): x is { cl: string; fam: BrandFamily } => !!x.fam);
    if (!named.length) return '';
    const headLine = statement || shortStatement;
    const factLine = sentencesOf(P(f.audience)).find((x) => x.length <= 90 && copyOk(x)) ?? '';
    const rows = named.slice(0, 3).map(({ cl, fam }) => {
      const isHead = /headline|heading|überschrift|titel|title|display/i.test(cl);
      const sample = isHead ? headLine : factLine;
      if (!sample) return '';
      const italic = /(?<!\p{L})(italic|kursiv)(?!\p{L})/iu.test(cl) && !/(?<!\p{L})(never|nie|not|nicht|no|kein\w*)(?!\p{L})[^.]{0,12}(italic|kursiv)/iu.test(cl);
      const lead = cl.slice(0, cl.toLowerCase().indexOf(fam.family.toLowerCase())).replace(/\s+(in|im|mit|with)\s*$/i, '').trim();
      return `<div style="display:flex;flex-direction:column;gap:6px;min-width:0">${label(esc(lead || fam.family))}<p style="${css({ '--bb-sample': isHead ? 'headline' : 'copy', margin: 0, 'font-family': familyStack(fam), 'font-size': isHead ? '30px' : '17px', 'line-height': isHead ? 1.12 : 1.45, 'font-style': italic ? 'italic' : 'normal', 'font-weight': isHead ? Math.max(...(fam.weights.length ? fam.weights : [400])) : 400, color: INK, 'text-wrap': 'balance' })}" dir="auto">${esc(sample)}</p></div>`;
    }).filter(Boolean);
    return rows.length ? `<div style="${css({ '--bb-kind': 'specimen', display: 'flex', 'flex-direction': 'column', gap: '18px' })}">${rows.join('')}</div>` : '';
  };
  /**
   * A few rules set large: the same component as every list of rules (the level in a column, the rule in the body face),
   * at a larger size, so that a page of two or three rules reads as chosen and not as a list cut short; a rule the
   * brand's material can show is shown beside it.
   */
  const bigRules = (list: { text: string; kind: 'do' | 'dont'; severity?: string; lang?: string; suggested?: boolean }[]) => {
    const demos = new Map(list.map((r) => [r, r.severity === 'none' ? '' : ruleDemo(r)] as const));
    const anyDemo = [...demos.values()].some(Boolean);
    const textW = CONTENT - 100 - (anyDemo ? span(5) + GUTTER : 0);
    const fits = (size: number) => list.reduce((sum, r) => sum + Math.max(linesFor(r.text, textW, size, 0.5) * size * 1.4, demos.get(r) ? 190 : 0) + 44, 0) <= BODY - 30;
    const size = fits(24) ? 24 : fits(20) ? 20 : fits(17) ? 17 : 0;
    if (!size) return '';
    return stack(0, sortRules(list).map((r, k) => `<div style="${css({ display: 'grid', 'grid-template-columns': anyDemo ? `88px minmax(0, 1fr) ${span(5)}px` : '88px minmax(0, 1fr)', 'column-gap': '12px', 'align-items': 'baseline', 'border-top': k ? `1px solid ${RULE}` : '0', padding: k ? '18px 0 22px' : '4px 0 22px', '--bb-grid': 'free' })}"><span style="display:flex">${ruleTag(r, 13)}</span><p${itemLang(r)} style="${css({ margin: 0, 'font-size': `${size}px`, 'line-height': 1.4, color: INK, 'font-family': bodyFont, 'font-weight': 400, 'text-wrap': 'pretty', 'min-width': 0, 'padding-right': anyDemo ? `${GUTTER - 12}px` : '0' })}">${esc(r.text)}</p>${anyDemo ? `<div style="align-self:start;padding-top:4px">${demos.get(r) ?? ''}</div>` : ''}</div>`).join(''), { flex: '1 1 auto', 'justify-content': 'flex-start' });
  };
  /** Binding rules before advice. */
  function sortRules<T extends { severity?: string }>(list: T[]): T[] { return [...list].sort((a, b) => (a.severity === 'hard' ? 0 : 1) - (b.severity === 'hard' ? 0 : 1)); }

  /** A brand with little written down: its book is short and tight, without chapter openers. */
  const sparse = data.rules.length + data.voiceExamples.length + data.assets.length + data.artboards.length + data.words.length < 14;
  /** A screenshot that shows another brand or product, kept out when the brand's rules say so. */
  const otherBrandShot = (a: { name: string; tags: string[] }) => policy.noOtherBrandScreens && /screen|shot|editor|product|app\b/i.test(`${a.name} ${a.tags.join(' ')}`) && a.name.split(/\s+/).slice(1).some((w) => /^[A-Z][a-z]{2,}/.test(w) && !name.includes(w) && !/^(The|With|And|Für|Mit|Und|Der|Die|Das|Brand|Marke)$/.test(w));

  // ------------------------------------------------------------ sections
  interface Section { id: string; title: string; intro?: string; introLang?: string; pages: string[]; bg?: string; tint?: boolean; appendix?: boolean }
  const sections: Section[] = [];
  /** How many of the brand's voice examples the book leaves out because they break its own rules. */
  let leftOutExamples = 0;
  const missing: string[] = [];
  const add = (s: Section | null, ifMissing: string) => { if (s && s.pages.length) sections.push(s); else missing.push(t(ifMissing)); };

  const positioning = P(f.positioning);
  let { statement, rest } = statementOf(positioning);
  /** The brand's own statement as it stands, before a headline rule chose another line for display. */
  const ownStatement = statement;
  if (statement && !headlineOk(statement)) {
    // A line of the positioning that says one thing: a short sentence, or the clause before its colon or dash.
    const options = sentencesOf(positioning).flatMap((x) => [x, x.split(/:\s|\s[–—]\s/)[0]!]).map((x) => x.trim()).filter((x, i, a) => a.indexOf(x) === i && x.length >= 12 && x.length <= 72 && x.split(/\s+/).length >= 2 && headlineOk(x.replace(/[.!]$/, '')) && quoteDebt(x) === 0);
    // A line of three words or more says a thing; two words are often half of a slogan.
    const pick = options.find((x) => x.split(/\s+/).length >= 3) ?? options[0];
    if (pick) {
      const at = positioning.indexOf(pick);
      statement = pick.replace(/[.!]$/, '').replace(/:$/, '');
      rest = `${positioning.slice(0, at)}${positioning.slice(at + pick.length).replace(/^[\s:–—-]+/, '')}`.trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
    } else { statement = ''; rest = positioning; }
    // The double slogan the headline rule forbids stays out of the text too: it is the home page's line alone.
    if (policy.oneStatement && rest.startsWith(ownStatement)) rest = rest.slice(ownStatement.length).trim();
  }
  /** A short line for small pieces: the statement when short, else its first clause, else the name; never cut inside. */
  const shortStatement = (() => {
    if (statement && statement.length <= 64) return statement;
    const first = sentencesOf(statement)[0] ?? '';
    if (first && first.length <= 64) return first;
    const at = Math.max(first.slice(0, 65).lastIndexOf(', '), first.slice(0, 65).lastIndexOf(': '), first.slice(0, 65).lastIndexOf(' – '));
    return at > 20 ? first.slice(0, at) : name;
  })();

  // Brand idea: the statement large, the rest of the positioning as text, who it is for and how it speaks; the
  // principles on a page of their own.
  {
    const principles = chapter('principles');
    const list = principlesOf(principles?.markdown).map((x) => ({ title: x.title, text: upTo(P(x.text), 260) })).filter((x) => x.title).slice(0, 4);
    const pages: string[] = [];
    const audience = upTo(P(f.audience), 230);
    const tone = upTo(P(f.tone), 230);
    if (statement || audience || tone) {
      const head = statement ? displayOrLead(statement, statement.length <= 48 ? 92 : 72, 1000, statement.length <= 110 ? 4 : 3, INK, 40, 'headline') : '';
      const restText = upTo(rest, 420);
      const restHtml = restText ? `<p style="${css({ margin: 0, 'font-size': '19px', 'line-height': 1.5, color: INK, 'font-family': bodyFont, 'max-width': '720px' })}" dir="auto">${esc(restText)}</p>` : '';
      // The tone leads the voice chapter; said here too, it would be said twice.
      const facts = [audience && ['For', audience], tone && !P(f.tone) && ['Tone', tone]].filter(Boolean) as string[][];
      const factHtml = facts.length ? grid(`repeat(${facts.length}, minmax(0, 1fr))`, facts.map(([k, v]) => stack(8, `${label(esc(t(k!)))}${small(esc(v!), restText ? { 'font-size': '16px', 'line-height': '24px' } : { 'font-size': '21px', 'line-height': '31px' })}`, { 'border-top': `1px solid ${RULE}`, 'padding-top': '12px' })).join(''), 32) : '';
      pages.push(stack(56, `${stack(28, `${head}${restHtml}`)}${factHtml}`, { flex: '1 1 auto', 'justify-content': restText && facts.length ? 'space-between' : 'flex-start' }));
    }
    if (list.length) {
      const cols = list.length === 3 ? 3 : 2;
      pages.push(stack(20, `${h3(esc(t('Principles')))}${grid(`repeat(${cols}, minmax(0, 1fr))`, list.map((x, i) => stack(10, `<span style="${css({ 'font-size': '13px', color: DIM, 'font-family': bodyFont })}">${String(i + 1).padStart(2, '0')}</span><h4${langAttr(principles)} style="${css({ margin: 0, 'font-size': '26px', 'line-height': 1.15, 'font-family': headingFont, 'font-weight': headingWeight, color: INK })}">${esc(x.title)}</h4>${x.text ? small(esc(x.text), { 'font-size': '15px', 'line-height': '23px' }) : ''}`, { 'border-top': `2px solid ${primary?.value ?? INK}`, 'padding-top': '14px' })).join(''), 32, { 'row-gap': '36px' })}${draftNote(principles)}`));
    }
    add({ id: 'idea', title: t('Brand idea'), pages }, 'Brand idea');
  }

  // Logo: the primary lockup large in its clear zone, its smallest sizes, the variants; then misuse.
  {
    const pages: string[] = [];
    const logos = data.logos;
    if (logos.length) {
      const primaryLogo = primaryLockup!;
      const bg = logoGround(primaryLogo);
      const aspect = logoAspect(primaryLogo) ?? 2.6;
      const heroH = logos.length > 1 ? 400 : 540;
      const logoW = Math.min(440, Math.round(Math.min(170, heroH * 0.4) * aspect)), logoH = Math.round(logoW / aspect);
      // The clear zone is drawn when the brand set it, as a share of the mark's height: x at the minimum width is that
      // many px of a mark that is minWidth / aspect high, so at the size shown it is the same share of the mark.
      const markHAtMin = primaryLogo.minWidth ? primaryLogo.minWidth / aspect : 0;
      // Without a minimum width the clear space has no size to be a share of: it is said in px and not drawn.
      const share = primaryLogo.clearSpace && markHAtMin ? Math.min(1, primaryLogo.clearSpace / markHAtMin) : 0;
      const clear = share ? Math.max(10, Math.min(Math.floor((heroH - logoH) / 2) - 24, Math.round(logoH * share))) : 0;
      const zoneLine = textOn(bg, 3) === '#ffffff' || luminance(textOn(bg, 3)) > 0.5 ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.45)';
      const zone = clear ? `<div style="${css({ position: 'relative', padding: `${clear}px`, outline: `1px ${dashed} ${zoneLine}` })}">${logoPicture(primaryLogo, { w: logoW, h: logoH })}</div>` : logoPicture(primaryLogo, { w: logoW, h: logoH });
      const hero = `<div style="${css({ height: `${heroH}px`, background: bg, display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'box-shadow': `inset 0 0 0 1px ${RULE}` })}">${zone}</div>`;
      /** The ground a logo is made for, in words: light or dark grounds, any ground, or the brand colour it is made for. */
      const useOnOf = (l: BrandLogo) => l.background === 'dark' ? t('dark grounds') : l.background === 'light' ? t('light grounds') : !l.background || l.background === 'any' ? t('any ground') : (() => { const c = resolveBrandColor(data, l.background); if (!c) return ''; const n = baseName(c); return n && n !== roleWords(c.role) && !/^(schrift|text|ink|grund|background)$/i.test(n) ? (lang === 'de' ? n : n.toLowerCase()) : luminance(c.value) < 0.3 ? t('dark grounds') : t('light grounds'); })();
      const useOn = useOnOf(primaryLogo);
      /** A logo's name as a reader sees it: no notes in brackets ("(Footer)", "(auf Papier)"). */
      const logoLabel = (l: BrandLogo) => cleanName(l.name).replace(/\s*\([^)]*\)/g, '').trim() || cleanName(l.name);
      const GROUND_WORD = /(?<!\p{L})(on|auf|reversed?|revers|negativ|dark|light|hell|dunkel|inverse)(?!\p{L})/iu;
      const spec = [
        share ? [t('Clear space'), `x = ${shareWords(share, lang)} ${t('of the mark\'s height, on every side')} (${primaryLogo.clearSpace}px ${t('at')} ${Math.round(markHAtMin)}px ${t('mark height')})`] : primaryLogo.clearSpace ? [t('Clear space'), `${primaryLogo.clearSpace}px ${t('on every side')}`] : null,
        primaryLogo.minWidth ? [t('Minimum width'), `${primaryLogo.minWidth}px`] : null,
        useOn ? [t('Use on'), useOn] : null,
      ].filter((x): x is string[] => !!x);
      // The smallest sizes: the compact mark if the brand has one, else the lockup, at 16, 24 and 48px high.
      const compact = logos.find((l) => l !== primaryLogo && (logoAspect(l) ?? 3) < 1.4) ?? logos.find((l) => l !== primaryLogo && /(?<!word|wort)mark|icon|symbol|zeichen|bildmarke|favicon/i.test(l.name)) ?? primaryLogo;
      const cAspect = compact.aspect || (compact === primaryLogo ? aspect : 1);
      // The smallest sizes at their true size: on the page itself when the mark is made for it, else together on one
      // strip of the ground it is made for, never in a box per size.
      const onPage = madeFor(compact, PAPER);
      // Only sizes the brand allows: none narrower than the mark's minimum width.
      const minW = compact.minWidth || (compact === primaryLogo ? primaryLogo.minWidth : 0) || 0;
      const heights = [16, 24, 48].filter((h) => Math.round(h * cAspect) >= minW);
      const sizes = (heights.length ? heights : [Math.ceil(minW / cAspect)]).map((h) => stack(8, `<div style="${css({ height: '48px', display: 'flex', 'align-items': 'flex-end' })}">${logoPicture(compact, { w: Math.round(h * cAspect), h })}</div>${label(`${h}px`, onPage ? {} : { color: textOn(logoGround(compact), 4.5) })}`)).join('');
      const specHtml = stack(14, `${small(`<strong style="font-weight:600">${esc(logoLabel(primaryLogo))}</strong>`, { 'font-size': '17px' })}${spec.map(([k, v]) => stack(4, `${label(esc(k!))}${small(esc(v!))}`, { 'border-top': `1px solid ${RULE}`, 'padding-top': '10px' })).join('')}${stack(10, `${label(esc(compact === primaryLogo ? t('Small sizes') : `${t('Small sizes')}: ${logoLabel(compact)}`))}<div style="${css({ display: 'flex', 'flex-wrap': 'wrap', gap: '24px', 'align-items': 'flex-end', ...(onPage ? {} : { background: logoGround(compact), padding: '14px 16px' }) })}">${sizes}</div>`, { 'border-top': `1px solid ${RULE}`, 'padding-top': '10px' })}`);
      // The same picture for the same ground is one variant, whatever its names.
      const sameArt = (a: BrandLogo, b: BrandLogo) => ((a.asset && a.asset === b.asset) || (!!a.svg && a.svg === b.svg)) && colorDistance(logoGround(a), logoGround(b)) < 10;
      const others = logos.filter((l, i) => l !== primaryLogo && !sameArt(l, primaryLogo) && !logos.slice(0, i).some((x) => x !== primaryLogo && sameArt(x, l))).slice(0, 4);
      const variants = others.map((l) => stack(8, `<div style="${css({ height: '150px', background: logoGround(l), display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'box-shadow': `inset 0 0 0 1px ${RULE}`, overflow: 'hidden' })}">${logoPicture(l, { w: 190, h: 76 })}</div>${label(`${esc(logoLabel(l))}${useOnOf(l) && !GROUND_WORD.test(logoLabel(l)) && !logoLabel(l).toLowerCase().includes(useOnOf(l).toLowerCase()) ? ` · ${esc(t('on'))} ${esc(useOnOf(l))}` : ''}`)}`)).join('');
      pages.push(stack(28, `${grid(`minmax(0, 1fr) ${span(4)}px`, `${hero}${specHtml}`, 40)}${others.length ? grid(`repeat(${Math.max(others.length, 3)}, minmax(0, 1fr))`, variants, 20) : ''}`, { flex: '1 1 auto', 'justify-content': 'space-between' }));
      // Misuse: the real mark, altered in the ways people alter marks, each with a small red cross.
      const misuse: [string, string, string?][] = [
        ['Do not stretch or squash it.', 'transform:scaleX(1.45)'],
        ['Do not rotate it.', 'transform:rotate(-14deg)'],
        ['Do not recolour it.', 'filter:hue-rotate(140deg) saturate(1.6)'],
        ['Do not add shadows or effects.', 'filter:drop-shadow(6px 6px 0 rgba(0,0,0,.45))'],
        ['Do not place it on a ground it was not made for.', '', primary && primary.value !== bg ? primary.value : (onColor(bg) === '#111111' ? '#7a7a7a' : '#c8c8c8')],
        ['Do not crowd it: keep the clear space.', 'margin:-24px'],
      ];
      const cross = `<span aria-hidden="true" style="${css({ position: 'absolute', top: '12px', right: '12px', width: '26px', height: '26px', 'border-radius': '13px', background: BAD, color: textOn(BAD), border: `2px solid ${PAPER}`, 'box-sizing': 'border-box', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-size': '17px', 'line-height': 1, 'font-family': 'system-ui, sans-serif', 'font-weight': 700 })}">×</span>`;
      const tiles = misuse.map(([text, style, ground2]) => stack(10, `<div style="${css({ '--bb-kind': 'demo', position: 'relative', height: '222px', background: ground2 ?? bg, display: 'flex', 'align-items': 'center', 'justify-content': 'center', overflow: 'hidden', 'box-shadow': `inset 0 0 0 1px ${RULE}` })}">${text.startsWith('Do not crowd') ? `<div style="display:flex;align-items:center;gap:0">${logoPicture(primaryLogo, { w: 190, h: 70 })}<span aria-hidden="true" style="${css({ 'font-size': '17px', color: textOn(bg), 'font-family': bodyFont })}">${esc(t('Partner'))}</span></div>` : logoPicture(primaryLogo, { w: 210, h: 80 }, style)}${cross}</div>${small(esc(t(text)), { 'font-size': '15px', 'line-height': '21px' })}`)).join('');
      pages.push(stack(20, `${h3(esc(t('Misuse')))}${grid('repeat(3, minmax(0, 1fr))', tiles, 28, { 'row-gap': '28px' })}`));
    }
    const c = chapter('logo');
    add({ id: 'logo', title: t('Logo'), intro: introOf(c?.markdown), introLang: langAttr(c), pages }, 'Logo');
  }

  // Colour: the core colours as tall columns as wide as the share of a page each takes, with every value; then the
  // pairs that matter. The long tail of one-off colours goes to the appendix.
  {
    const pages: string[] = [];
    const colors = data.colors;
    if (colors.length) {
      const core = [ground, ink, primary, second].filter((c, i, a): c is BrandColor => !!c && a.indexOf(c) === i).slice(0, 4);
      const others = colors.filter((c) => !core.includes(c));
      // A ratio the brand states for ground, ink and accent ("im Verhältnis 60/30/10") is the bar's own.
      const ratioM = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*\/)/.exec(data.rules.filter((r) => r.topic === 'color').map((r) => r.text).join(' '));
      const ratio = ratioM && core.length === 3 && core[0] === ground && core[1] === ink && core[2] === primary && Number(ratioM[1]) + Number(ratioM[2]) + Number(ratioM[3]) === 100 ? [1, 2, 3].map((k) => Number(ratioM[k])) : null;
      const weight = (c: BrandColor) => (ratio ? ratio[core.indexOf(c)]! : c.usage ?? (c === ground ? 50 : c === ink ? 26 : c === primary ? 14 : 10));
      const total = core.reduce((s, c) => s + weight(c), 0) || 1;
      // Each share is a field of its colour with a hairline inside it, so the paper's share reads too, and the bar keeps
      // inside the margins.
      const bar = `<div style="${css({ display: 'flex', gap: '2px', height: '16px', width: '100%' })}" role="img" aria-label="${escapeAttr(core.map((c) => `${colourName(c)} ${Math.round((weight(c) / total) * 100)}%`).join(', '))}">${core.map((c) => `<span style="${css({ flex: `${weight(c)} 1 0`, background: c.value, 'box-shadow': `inset 0 0 0 1px ${mixHex(INK, PAPER, 0.7)}` })}"></span>`).join('')}</div>`;
      const barNote = ratio ? `${t('The brand\'s own ratio')}: ${core.map((c) => `${colourName(c)} ${weight(c)}${lang === 'de' ? '\u00a0%' : '%'}`).join(', ')}.` : core.some((c) => c.usage !== undefined) ? t('By how much the brand\'s own work uses each colour.') : t('Roughly how much of a page each colour takes: mostly ground and ink, the accent sparingly.');
      const supporting = others.filter((c) => colourGroup(c) === 'Supporting' || colourGroup(c) === 'States').slice(0, 6);
      const fewOthers = others.length > 0 && others.length <= 6;
      const shown = fewOthers ? others : supporting;
      const meta = (rows: [string, string][], size = 13) => `<dl style="${css({ margin: 0, display: 'grid', 'grid-template-columns': `${size === 13 ? 54 : 44}px minmax(0, 1fr)`, gap: '2px 6px', 'font-size': `${size}px`, 'line-height': `${size + 5}px`, 'font-family': bodyFont, color: INK })}">${rows.map(([k, v]) => `<dt style="color:${DIM}">${k}</dt><dd style="margin:0;white-space:nowrap">${v}</dd>`).join('')}</dl>`;
      const swatchH = shown.length ? 226 : 440;
      // Every core colour says its job under its name, or none does: a caption on one swatch alone reads as a slip.
      const captioned = core.every((c) => roleLabel(c));
      // The core colours as wide as their share, in whole columns of the book's grid (at least two each).
      const spans = (() => {
        const minSpan = 2, free = 12 - minSpan * core.length;
        const raw = core.map((c) => (weight(c) / total) * free);
        const out = raw.map((x) => minSpan + Math.floor(x));
        let left = 12 - out.reduce((a, b) => a + b, 0);
        for (const k of raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r).map((x) => x.i)) { if (left <= 0) break; out[k]!++; left--; }
        return out;
      })();
      // One title size for every core swatch: the largest at which each name fits its column.
      const titleSize = Math.max(16, Math.min(26, ...core.map((c, k) => Math.floor((span(spans[k] ?? 3) - 36) / (Math.max(...colourName(c).split(/\s+/).map((x) => x.length)) * 0.62)))));
      const column = (c: BrandColor) => {
        const fg = textOn(c.value);
        const role = captioned ? roleLabel(c) : '';
        const cols = spans[core.indexOf(c)] ?? 3;
        return stack(12, `<div style="${css({ '--bb-kind': 'swatch', height: `${swatchH}px`, background: c.value, 'box-shadow': `inset 0 0 0 1px ${RULE}`, padding: '18px', display: 'flex', 'flex-direction': 'column', 'justify-content': 'space-between' })}"><span style="${css({ 'font-size': `${titleSize}px`, 'line-height': 1.1, color: fg, 'font-family': headingFont, 'font-weight': headingWeight, hyphens: 'auto' })}" dir="auto">${esc(colourName(c))}</span>${role ? `<span style="${css({ 'font-size': '14px', color: fg, 'font-family': bodyFont })}">${esc(role)}</span>` : ''}</div>${meta([['HEX', esc(c.value.toUpperCase())], ['RGB', rgbOf(c.value)], ['OKLCH', oklchOf(c.value, lang)]], 12)}${honestToken(c.token, c.value) ? tokenLine(c.token, span(cols)) : ''}`, { 'grid-column': `span ${cols}`, 'min-width': 0 });
      };
      // The supporting colours with the same values as the core ones, smaller.
      const small6 = (c: BrandColor) => stack(8, `<div style="${css({ height: '56px', background: c.value, 'box-shadow': `inset 0 0 0 1px ${RULE}` })}"></div>${small(esc(colourName(c)), { 'font-size': '14px', 'line-height': '19px', 'font-weight': 600 })}${meta([['HEX', esc(c.value.toUpperCase())], ['RGB', rgbOf(c.value)], ['OKLCH', oklchOf(c.value, lang)]], 12)}${honestToken(c.token, c.value) ? tokenLine(c.token, span(2)) : ''}`);
      pages.push(stack(22, `${stack(8, `${bar}${label(esc(barNote))}`)}${grid('repeat(12, minmax(0, 1fr))', core.map(column).join(''), 0)}${shown.length ? stack(10, `${h3(esc(t('Supporting colours')))}${grid('repeat(6, minmax(0, 1fr))', shown.map(small6).join(''), 16)}`) : ''}`));
      if (!fewOthers && others.length) {
        // Every other colour in one table, grouped by its job, in the appendix.
        const cols = '18px minmax(0, 1fr) 84px 104px 150px max-content';
        const cell = (inner: string, extra: Record<string, string | number> = {}) => `<div style="${css({ 'font-size': '13px', 'line-height': '18px', 'font-family': bodyFont, color: INK, padding: '5px 0', 'border-top': `1px solid ${RULE}`, 'min-width': 0, ...extra })}">${inner}</div>`;
        const headRow = ['', t('Name'), 'HEX', 'RGB', 'OKLCH', t('Token')].map((h) => cell(esc(h), { color: DIM, 'border-top': '0', 'font-size': '13px' })).join('');
        const rowFor = (c: BrandColor) => `${cell(`<span style="${css({ display: 'block', width: '18px', height: '18px', background: c.value, 'box-shadow': `inset 0 0 0 1px ${RULE}` })}"></span>`)}${cell(`<strong style="font-weight:600">${esc(colourName(c))}</strong>${roleLabel(c) ? ` <span style="color:${DIM}">${esc(roleLabel(c))}</span>` : ''}`)}${cell(esc(c.value.toUpperCase()), { 'white-space': 'nowrap' })}${cell(rgbOf(c.value), { 'white-space': 'nowrap' })}${cell(oklchOf(c.value, lang), { 'white-space': 'nowrap' })}${cell(honestToken(c.token, c.value) ? `--${esc(c.token)}` : '', { 'font-family': monoFont, 'font-size': '12px', 'white-space': 'nowrap', color: DIM })}`;
        const groupRow = (g: string) => `<div style="${css({ 'grid-column': '1 / -1', 'font-size': '14px', 'line-height': '18px', 'font-weight': 600, color: INK, 'font-family': bodyFont, padding: '14px 0 2px' })}">${esc(t(g))}</div>`;
        const byGroup = GROUP_ORDER.map((g) => ({ g, list: others.filter((c) => colourGroup(c) === g) })).filter((x) => x.list.length);
        const nameWidth = CONTENT - 18 - 84 - 104 - 150 - 240 - 5 * 16;
        const rowH = (c: BrandColor) => 29 + (linesFor(`${colourName(c)} ${roleLabel(c)}`, nameWidth, 13, 0.6) - 1) * 18;
        const total = byGroup.reduce((sum, x) => sum + 34 + x.list.reduce((s2, c) => s2 + rowH(c), 0), 0);
        const room = Math.min(BODY - 90, total / Math.ceil(total / (BODY - 90)) + 60);
        let page = '';
        let used = 0;
        const flush = () => { if (page) appendix.push(stack(12, `${h3(esc(t('All colours')))}${grid(cols, headRow + page, 16, { '--bb-grid': 'free', 'column-gap': '16px', 'row-gap': '0', 'align-items': 'center' })}`)); page = ''; used = 0; };
        for (const { g, list } of byGroup) {
          if (used + 34 + rowH(list[0]!) > room) flush();
          page += groupRow(g); used += 34;
          for (const c of list) {
            if (used + rowH(c) > room) { flush(); page += groupRow(g); used += 34; }
            page += rowFor(c); used += rowH(c);
          }
        }
        flush();
      }
      // The pairs that matter: core text on core grounds first, then the failing ones worth a warning; one page.
      // Without pairs of its own, the core colours are measured against each other: text colours on grounds, by WCAG.
      const listedPairs = pairingTable(data);
      const pairs = listedPairs.length ? listedPairs : core.flatMap((fgc) => core.filter((bgc) => bgc !== fgc).map((bgc) => { const contrast = contrastRatio(fgc.value, bgc.value); return { id: '', fg: fgc, bg: bgc, verdict: (contrast >= 3 ? 'allow' : 'forbid') as 'allow' | 'forbid', contrast, passes: contrast >= 4.5 }; })).filter((p) => p.contrast >= 3 || (p.fg === ink || p.bg === ground));
      if (pairs.length) {
        const coreScore = (p: (typeof pairs)[number]) => (core.includes(p.fg) ? 1 : 0) + (core.includes(p.bg) ? 1 : 0);
        const allowed = pairs.filter((p) => p.verdict === 'allow').sort((a, b) => coreScore(b) - coreScore(a) || b.contrast - a.contrast);
        const forbidden = pairs.filter((p) => p.verdict !== 'allow').sort((a, b) => coreScore(b) - coreScore(a));
        // The pair the book itself is set in, ink on ground, comes first.
        // Measured when the brand did not list it: it is the pair every page of the book stands on.
        const listed = allowed.find((p) => p.fg === ink && p.bg === ground);
        const measured = !listed && ink && ground && contrastRatio(ink.value, ground.value) >= 4.5 && !pairs.some((p) => p.fg === ink && p.bg === ground) ? { id: '', fg: ink, bg: ground, verdict: 'allow' as const, contrast: contrastRatio(ink.value, ground.value), passes: true } : undefined;
        const own = listed ?? measured;
        const pick = [...(own ? [own] : []), ...allowed.filter((p) => p !== own).slice(0, (forbidden.length ? 8 : 12) - (own ? 1 : 0)), ...forbidden.slice(0, 4)];
        const cols = pick.length > 8 ? 6 : 4;
        const rows = Math.ceil(pick.length / cols);
        const tileH = Math.min(rows === 1 ? 320 : 200, Math.floor((BODY - 100 - rows * 112) / rows));
        const cells = pick.map((p) => {
          const ratio = contrastRatio(p.fg.value, p.bg.value);
          // A pair the brand allows that only passes for large text is for headlines only, said in amber, not "use".
          // A ground the brand never sets as a field is shown, and marked as for marks only.
          const marksOnly = policy.noField.includes(p.bg.value.toLowerCase());
          const ok = p.verdict === 'allow' && ratio >= 3 && !marksOnly;
          const large = ok && ratio < 4.5;
          return `<div style="display:grid;grid-template-rows:subgrid;grid-row:span 3;min-width:0"><div style="${css({ '--bb-kind': 'swatch', height: `${tileH}px`, background: p.bg.value, color: p.fg.value, padding: '16px', display: 'flex', 'flex-direction': 'column', 'justify-content': 'space-between', 'box-shadow': `inset 0 0 0 1px ${RULE}`, position: 'relative' })}"><span style="${css({ 'font-size': cols === 6 ? '40px' : '52px', 'line-height': 1, 'font-family': headingFont, 'font-weight': headingWeight })}">Aa</span><span style="${css({ 'font-size': '16px', 'font-family': bodyFont })}" dir="auto">${esc(name)}</span>${ok ? '' : `<span aria-hidden="true" style="${css({ position: 'absolute', top: '10px', right: '10px', width: '22px', height: '22px', 'border-radius': '11px', background: BAD, color: textOn(BAD), border: `2px solid ${PAPER}`, 'box-sizing': 'border-box', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-size': '15px', 'line-height': 1, 'font-family': 'system-ui, sans-serif', 'font-weight': 700 })}">×</span>`}</div><p style="${css({ margin: 0, 'font-size': '13px', 'line-height': '18px', color: INK, 'font-family': bodyFont, 'margin-top': '4px' })}"><strong style="display:block;color:${large ? AMBER : ok ? INK : BAD}">${esc(t(marksOnly ? 'Marks only' : large ? 'Headlines only' : ok ? 'Use' : 'Do not use'))}</strong><span style="display:block;white-space:nowrap;color:${DIM}">${ratio.toFixed(2).replace('.', lang === 'de' ? ',' : '.')}:1 · ${esc(t(gradeOf(ratio)))}</span></p><p style="${css({ margin: '0 0 18px', 'font-size': '13px', 'line-height': '18px', color: INK, 'font-family': bodyFont, 'text-wrap': 'pretty' })}">${esc(colourName(p.fg))} ${esc(t('on'))} ${esc(colourName(p.bg))}</p></div>`;
        }).join('');
        pages.push(stack(16, `${h3(esc(t('Pairs and contrast')))}${label(esc(t('Text colour on ground, with the measured WCAG contrast. AA needs 4.5:1 for text, AAA 7:1.')))}${grid(`repeat(${cols}, minmax(0, 1fr))`, cells, 20, { 'row-gap': '4px', 'margin-top': '6px' })}`));
      }
    }
    const c = chapter('color');
    add({ id: 'colour', title: t('Colour'), intro: introOf(c?.markdown), introLang: langAttr(c), pages }, 'Colour');
  }

  // Typography: each family with a job, large, with its letters, weights and a passage set in it; then the scale as a
  // few named steps, each with real copy at its real size.
  {
    const pages: string[] = [];
    const usedBySteps = (x: BrandFamily) => data.typeScale.some((s) => s.family === x.id || s.family === x.family);
    const families = data.families.filter((x) => /display|head|body|text|ui|interface|mono|code|serif|sans|brand|label|copy/i.test(x.role) || usedBySteps(x)).slice(0, 4);
    /** What the brand's own rules say a family is for ("Space Mono für Labels, Nummern und Telemetrie"), if they do. */
    const ruleRole = (x: BrandFamily) => {
      const others = data.families.map((y) => y.family).filter((n) => n.length > 2 && n !== x.family);
      for (const r of data.rules) for (const sent of sentencesOf(PI(r))) {
        const lower = sent.toLowerCase();
        let at = lower.indexOf(x.family.toLowerCase());
        let len = x.family.length;
        if (at < 0 && /mono|code/i.test(x.role)) { const m = /(?<!\p{L})mono(?:space)?(?!\p{L})/iu.exec(sent); if (m) { at = m.index; len = m[0].length; } }
        if (at < 0) continue;
        let tail = sent.slice(at + len);
        const next = Math.min(tail.length, ...others.map((n) => tail.toLowerCase().indexOf(n.toLowerCase())).filter((i) => i >= 0));
        tail = tail.slice(0, next);
        const m = /(?<!\p{L})((?:nur |only |ausschließlich |exclusively )?(?:für|for)\s[^.;]+)/iu.exec(tail);
        if (!m || (r.kind === 'dont' && !/^(nur|only|ausschließlich|exclusively)\b/i.test(m[1]!))) continue;
        const phrase = m[1]!.replace(/[,\s]+$/, '').trim();
        if (phrase.length <= 64) return phrase;
      }
      return '';
    };
    const famRole = (x: BrandFamily) => {
      const r = x.role.toLowerCase();
      const de = lang === 'de';
      const own = ruleRole(x);
      if (own) return `${/mono|code/.test(r) ? 'Monospace' : /display|head/.test(r) && policy.headingFamily !== x.family ? (de ? 'Auszeichnung' : 'Display') : 'Text'}, ${own}`;
      if (/mono|code/.test(r)) return de ? 'Monospace, für Code und Zahlen' : 'Monospace, for code and figures';
      if (policy.headingFamily === x.family) return de ? 'Text, für Überschriften und Fließtext' : 'Text, for headings and body copy';
      if (/display|head/.test(r)) return policy.headingFamily ? (de ? 'Auszeichnung, für große Zeilen' : 'Display, for large lines') : de ? 'Auszeichnung, für Überschriften' : 'Display, for headings';
      if (/body|text|copy|ui|interface/.test(r)) return de ? 'Text, für Fließtext und Oberfläche' : 'Text, for body copy and interface';
      return roleWords(x.role);
    };
    // Copy in the brand's own voice: its positioning, then who it is for. Its tone and address are notes about how it
    // speaks, not copy, so they are not set as samples.
    const sources = [rest, positioning, P(f.audience)].filter(Boolean);
    const passage = sources.map((x) => passageOf(x, 260)).find((x) => x.length >= 60) ?? sources.map((x) => passageOf(x, 260)).find(Boolean) ?? statement;
    /** A short whole sentence of the brand's own for the smallest step, other than the passage. */
    const shortSentence = (max: number) => sources.flatMap((x) => sentencesOf(x)).find((x) => x.length <= max && x.length >= 20 && !passage.includes(x) && copyOk(x)) ?? '';
    // A line of the brand's own for each display face, other than the statement the cover and the idea already set.
    const altLines = [...data.voiceExamples.map((e) => e.good), ...principlesOf(chapter('principles')?.markdown).map((x) => x.title)].map((x) => P(x)).filter((x) => x && x.length >= 8 && x.length <= 60 && !statement.includes(x) && quoteDebt(x) === 0 && sentenceLanguage(x) !== (lang === 'de' ? 'en' : 'de') && headlineOk(x));
    let altAt = 0;
    const usedSamples: string[] = [];
    // Two families to a page; three share one page in three columns, so a third face never stands alone.
    const per = families.length === 3 ? 3 : 2;
    for (let i = 0; i < families.length; i += per) {
      const chunk = families.slice(i, i + per);
      const colW = (CONTENT - GUTTER * (chunk.length - 1)) / chunk.length;
      const fams = chunk.map((x) => {
        const st = familyStack(x);
        const weights = x.weights.length ? x.weights : [400];
        const heavy = /black|heavy|ultra|extra|wide|expanded|extended/i.test(x.family) || Math.max(...weights) >= 800;
        const isMono = /mono|code/i.test(`${x.role} ${x.family}`);
        const alphaSize = Math.min(30, Math.floor((chunk.length === 1 ? colW / 2 : colW) / (26 * (heavy ? 0.86 : 0.8))));
        const letters = `<span aria-hidden="true" style="${css({ 'font-size': chunk.length === 3 ? '128px' : '226px', 'line-height': 0.86, 'font-family': st, color: INK, 'font-weight': weights.at(-1) })}">Aa</span>`;
        const generic = /^(ui-monospace|monospace|system-ui|ui-sans-serif|ui-serif|sans-serif|serif|-apple-system)$/i.test(x.family.trim());
        // Two jobs in one family ("Archivo" for display and for text) are told apart by width and weights.
        const twin = families.filter((y) => y.family === x.family).length > 1;
        const range = weights.length > 1 ? `${Math.min(...weights)}–${Math.max(...weights)}` : String(weights[0]);
        const familyLabel = generic ? t(/mono/i.test(x.family) ? 'System monospace' : /serif/i.test(x.family) && !/sans/i.test(x.family) ? 'System serif' : 'System sans') : twin ? `${x.family}${policy.displayStretch && display && x === display ? ' Expanded' : ''} ${range}` : x.family;
        const nameBlock = stack(6, `<span style="${css({ 'font-size': chunk.length === 3 ? '26px' : '34px', 'line-height': 1.1, 'font-family': st, color: INK })}">${esc(familyLabel)}</span>${label(esc(famRole(x)), { 'font-size': '14px' })}`);
        const alphabet = `<p style="${css({ margin: 0, 'font-size': `${alphaSize}px`, 'line-height': 1.45, 'font-family': st, color: INK, 'font-weight': heavy ? Math.max(...weights) : undefined })}">${policy.upperFamily === x.family ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>ÄÖÜ 0123456789 &amp; ? ! € @ ( )' : lang === 'de' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>ÄÖÜ äöüß 0123456789 &amp; ? !' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 &amp; ? ! € @ ( )'}</p>`;
        const weightRow = `<div style="display:flex;flex-wrap:wrap;gap:6px 22px">${weights.map((w) => `<span style="${css({ 'font-size': '19px', 'font-family': st, 'font-weight': w, color: INK })}">${w}</span>`).join('')}</div>`;
        const sample = isMono ? `<p style="${css({ margin: 0, 'font-size': '16px', 'line-height': 1.6, 'font-family': st, color: INK })}">${data.colors.filter((c) => honestToken(c.token, c.value)).slice(0, 3).map((c) => `--${esc(c.token)}: ${esc(c.value)};`).join('<br>')}</p>` : heavy || /display|head/i.test(x.role) ? `<p style="${css({ '--bb-sample': 'headline', margin: 0, 'font-size': chunk.length === 3 ? '26px' : '46px', 'line-height': 1.1, 'font-family': st, 'font-weight': weights.at(-1), color: INK, 'text-wrap': 'balance' })}" dir="auto">${esc((() => { const line = altLines[altAt++] ?? shortStatement; usedSamples.push(line.replace(/[.!]$/, '')); return line; })())}</p>` : `<p style="${css({ '--bb-sample': 'copy', margin: 0, 'font-size': '20px', 'line-height': 1.55, 'font-family': st, color: INK, 'max-width': '560px' })}" dir="auto">${esc(passage)}</p>`;
        if (chunk.length === 1) return `<div style="--bb-kind:specimen">${grid('1fr 1fr', `${stack(20, `${letters}${nameBlock}${weightRow}`)}${stack(28, `${alphabet}${sample}`)}`, 56, { 'padding-top': '4px' })}</div>`;
        if (chunk.length === 3) return `<div style="--bb-kind:specimen;min-width:0">${stack(16, `${letters}${nameBlock}${alphabet}${weightRow}${sample}`, { 'padding-top': '4px', 'min-width': 0 })}</div>`;
        return `<div style="--bb-kind:specimen;min-width:0">${stack(18, `<div style="display:flex;align-items:flex-end;gap:24px;min-width:0">${letters}${nameBlock}</div>${alphabet}${weightRow}${sample}`, { 'padding-top': '4px' })}</div>`;
      }).join('');
      pages.push(chunk.length === 1 ? fams : grid(`repeat(${chunk.length}, minmax(0, 1fr))`, fams, 56, { 'align-items': 'start' }));
    }
    // The type at work: the brand's statement, a line of who it is for and a passage, set in its own hierarchy as a page
    // would set them, each with the style it is in. Only the brand's own words; a brand without them has no such page.
    {
      const deck = sentencesOf(P(f.audience)).find((x) => x.length <= 140 && copyOk(x) && !passage.includes(x)) ?? '';
      if (!sparse && statement && passage && passage !== statement && deck) {
        const stepNear = (target: number, lo: number, hi: number) => [...data.typeScale].filter((x) => x.size >= lo && x.size <= hi).sort((a, b) => Math.abs(a.size - target) - Math.abs(b.size - target))[0];
        const b = stepNear(17, 14, 20);
        const w = CONTENT;
        const fitsW = (size: number) => linesFor(statement, w, size, displayGlyph) <= 3 && Math.max(...statement.split(/\s+/).map((x) => x.length)) * size * displayGlyph <= w * 0.96;
        // The largest step of the brand's own scale that sets the statement in three lines at most.
        const h = [...data.typeScale].filter((x) => x.size >= 40 && x.size <= 96).sort((a, b2) => b2.size - a.size).find((x) => fitsW(Math.round(x.size)));
        let hs = Math.round(h?.size ?? 64);
        while (hs > 32 && (linesFor(statement, w, hs, displayGlyph) > 3 || Math.max(...statement.split(/\s+/).map((x) => x.length)) * hs * displayGlyph > w * 0.96)) hs -= 2;
        const bs = Math.round(b?.size ?? 17);
        // The faces by the names the specimen pages give them, so that one face has one name in the book.
        const twinFamily = (x: BrandFamily | undefined) => !!x && data.families.filter((y) => y.family === x.family).length > 1;
        const fam = (x: BrandFamily | undefined, weight: number) => {
          if (!x) return '';
          if (/^(ui-|system-ui|sans-serif|serif|monospace|-apple-system)/.test(x.family)) return `${t('System sans')} ${weight}`;
          return `${x.family}${twinFamily(x) && policy.displayStretch && x === display ? ' Expanded' : ''} ${weight}`;
        };
        const headFamily = display ?? body;
        const rows: [string, string, string][] = [
          [t('Headline'), fam(headFamily, displayWeight), `${hs}px`],
          [t('Lead'), fam(body, 400), '22px'],
          [t('Body'), fam(body, 400), `${bs}px`],
        ];
        const spec = stack(0, rows.map(([k, v, sz]) => `<div style="${css({ display: 'grid', 'grid-template-columns': `${span(1)}px minmax(0, 1fr) auto`, 'column-gap': '16px', 'border-top': `1px solid ${RULE}`, padding: '10px 0' })}">${label(esc(k), { color: INK, 'font-weight': 600 })}${label(esc(v))}${label(esc(sz), { 'font-variant-numeric': 'tabular-nums' })}</div>`).join(''));
        const headline = `<p style="${css({ '--bb-sample': 'headline', margin: 0, 'font-size': `${hs}px`, 'line-height': 1.06, 'letter-spacing': '-0.02em', 'font-family': displayFont, 'font-weight': displayWeight, color: INK, 'text-wrap': 'balance', 'max-width': `${w}px` })}" dir="auto">${esc(statement)}</p>`;
        const text = stack(24, `<p style="${css({ '--bb-sample': 'copy', margin: 0, 'font-size': '22px', 'line-height': 1.4, 'font-family': bodyFont, color: INK, 'text-wrap': 'pretty' })}" dir="auto">${esc(deck)}</p><p style="${css({ '--bb-sample': 'copy', margin: 0, 'font-size': `${bs}px`, 'line-height': 1.6, 'font-family': bodyFont, color: INK, 'max-width': `${span(5)}px`, 'text-wrap': passage.length < 200 ? 'balance' : 'pretty' })}" dir="auto">${esc(passage)}</p>`);
        // The headline across the page under a rule of the accent; the lead and the passage at the foot, the styles beside them.
        pages.push(stack(16, `${h3(esc(t('Type at work')))}${stack(0, `${headline}${grid(`${span(7)}px minmax(0, 1fr)`, `${text}${stack(12, `${label(esc(t('The brand\'s own words in its own hierarchy.')))}${spec}`)}`, 24, { 'align-items': 'end' })}`, { 'border-top': `2px solid ${ACCENT}`, 'padding-top': '24px', 'min-height': `${BODY - 60}px`, 'justify-content': 'space-between' })}`));
      }
    }
    if (data.typeScale.length) {
      // A handful of named steps from the brand's scale: the largest, up to three headings, the body size and the
      // smallest. Sizes are rounded to whole pixels; the brand's own name for the step and its token come with it.
      const steps = [...data.typeScale].sort((a, b) => b.size - a.size);
      // The body step by its role first ("body", "paragraph"), then by a looser name, never by its place in the order.
      const roleOf = (s: (typeof steps)[number]) => `${s.role} ${s.name} ${s.token ?? ''}`.toLowerCase();
      const named0 = (s: (typeof steps)[number]) => `${s.name} ${s.token ?? ''}`.toLowerCase();
      const bodyStep = steps.find((s) => /\bbody\b|paragraph|fließtext|lesetext/.test(named0(s))) ?? steps.find((s) => /\bbody\b|paragraph|fließtext|lesetext|\bcopy\b/.test(roleOf(s))) ?? steps.find((s) => /\bbase\b|\btext\b(?!-)/.test(roleOf(s))) ?? [...steps].sort((a, b) => Math.abs(a.size - 16) - Math.abs(b.size - 16))[0]!;
      const display = steps[0]!;
      const caption = steps.find((s) => s !== bodyStep && /caption|small|klein|meta|fine|footnote|eyebrow|label/.test(roleOf(s)) && s.size >= 11 && s.size < bodyStep.size) ?? [...steps].reverse().find((s) => s.size >= 11 && s.size < bodyStep.size);
      const between = steps.filter((s) => s.size < display.size && s.size > bodyStep.size + 2);
      const distinct: typeof steps = [];
      for (const s of between) if (!distinct.some((d) => Math.abs(d.size - s.size) / s.size < 0.12)) distinct.push(s);
      const headings = distinct.length <= 3 ? distinct : [distinct[0]!, distinct[Math.floor(distinct.length / 2)]!, distinct.at(-1)!];
      const named: { level: string; s: (typeof steps)[number] }[] = [
        { level: 'Display', s: display },
        // A step the brand names for something other than a heading ("details", "lead") keeps its own name.
        ...headings.map((s, k) => ({ level: /h[1-6]\b|head|title|titel|überschrift|display|section/.test(roleOf(s)) || !s.name || /^\d+(\.\d+)?\s*px$/i.test(s.name.trim()) ? `H${k + 1}` : s.name.replace(/^[-\w]*?(?:text|type|font)-/i, '').replace(/^\w/, (c) => c.toUpperCase()), s })),
        ...(bodyStep !== display ? [{ level: lang === 'de' ? 'Fließtext' : 'Body', s: bodyStep }] : []),
        ...(caption && caption !== bodyStep ? [{ level: lang === 'de' ? 'Klein' : 'Caption', s: caption }] : []),
      ];
      // Real copy: the statement for the largest, distinct phrases of the brand's own for the headings, a passage for
      // the body. A heading with no phrase left of its own is left out, rather than repeat one.
      const phrases = [...new Set([
        ...sentencesOf(positioning).map((x) => x.replace(/[.!]$/, '')),
        // Whole sentences only: a clause cut out of one reads as a fragment.
        ...sentencesOf(P(f.audience)).map((y) => y.replace(/[.!]$/, '')),
        ...data.voiceExamples.map((e) => (e.good ?? '').replace(/[.!]$/, '')),
        ...principlesOf(chapter('principles')?.markdown).map((x) => x.title),
      ].filter((x) => x && x.split(/\s+/).length >= 2 && !WORKING_NOTE.test(x) && !/;/.test(x) && (positioning.includes(x) || !ruleTexts.some((r) => r.includes(x))) && quoteDebt(x) === 0 && (!lang || sentenceLanguage(x) !== (lang === 'de' ? 'en' : 'de')) && headlineOk(x)))];
      const taken = new Set<string>([passage, ...usedSamples]);
      const trackingPx = (tracking: string, size: number) => { const m = /^(-?\d*\.?\d+)\s*(em|px)?$/.exec((tracking || '').trim()); if (!m) return 0; const v = Number(m[1]); return m[2] === 'px' ? v : m[2] === 'em' || Math.abs(v) < 1 ? v * size : 0; };
      const fitPhrase = (size: number, weight: number, tracking: string, lines = 1, fam0?: BrandFamily) => {
        const perChar = size * Math.max(fam0 ? glyphOf(fam0) : 0, weight >= 800 ? 0.7 : weight >= 600 ? 0.62 : 0.56) + Math.max(0, trackingPx(tracking, size));
        const max = Math.floor(((CONTENT - 200) * 0.94 * lines) / perChar);
        const longestFits = (p: string) => Math.max(...p.split(/\s+/).map((w) => w.length)) * perChar <= (CONTENT - 200) * 0.94;
        const cut = (p: string) => (p.length <= max && longestFits(p) && !LEADING_WORDS.test(p.split(/\s+/).at(-1)!) ? p : '');
        const options = phrases.map(cut).filter((p) => p && !taken.has(p) && ![...taken].some((q) => q.includes(p) || p.includes(q))).sort((a, b) => b.length - a.length);
        const p = options[0];
        if (!p) return '';
        taken.add(p);
        return p.charAt(0).toUpperCase() + p.slice(1);
      };
      const famFor = (s: (typeof steps)[number]) => { const fam = data.families.find((x) => x.id === s.family || x.family === s.family); return fam ? familyStack(fam) : s.size >= 28 ? displayFont : bodyFont; };
      const rows: { html: string; h: number }[] = [];
      for (const { level, s } of named) {
        const size = Math.round(s.size);
        const isBody = s === bodyStep || s === caption;
        const big = s === display && size >= 72;
        const colW = big ? CONTENT : CONTENT - 200;
        const stepFam = data.families.find((x) => x.id === s.family || x.family === s.family);
        const glyph = stepFam ? Math.max(glyphOf(stepFam), s.weight >= 800 ? 0.74 : s.weight >= 600 ? 0.64 : 0.58) : s.weight >= 800 ? 0.74 : s.weight >= 600 ? 0.64 : 0.58;
        // A phrase fits when its longest word fits the line and the whole fits in two lines.
        const wholeFits = (p: string) => Math.max(...p.split(/\s+/).map((w) => w.length)) * size * glyph <= colW * 0.95 && p.length * size * glyph <= colW * (size > 90 ? 1.8 : 2);
        const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
        const text = s === display ? (statement && wholeFits(statement) ? statement : cap(phrases.find((p) => wholeFits(p) && p.split(/\s+/).length >= 2 && !LEADING_WORDS.test(p.split(/\s+/).at(-1)!) && !passage.includes(p) && ![...taken].some((q) => q.includes(p) || p.includes(q))) ?? phrases.find((p) => wholeFits(p) && p.split(/\s+/).length >= 2 && !passage.includes(p)) ?? '') || name) : isBody ? (s === bodyStep ? passage : shortSentence(90)) : fitPhrase(size, s.weight, s.tracking, size >= 40 ? 1 : 2, stepFam);
        if (!text) continue;
        // A display size wider than the page even for one word is shown as large as it fits, and says so.
        const longest = Math.max(...text.split(/\s+/).map((w) => w.length));
        const shown = longest * size * glyph > colW * 0.95 ? Math.floor((colW * 0.95) / (longest * glyph)) : size;
        if (s === display) taken.add(text);
        const tracking = s.tracking && s.tracking !== '0' ? (/^-?\d*\.?\d+$/.test(s.tracking.trim()) && Math.abs(Number(s.tracking)) < 1 ? `${s.tracking}em` : s.tracking) : undefined;
        const lh = s.lineHeight || (size >= 32 ? '1.1' : '1.5');
        const spec = `<div style="${css({ display: 'flex', 'flex-direction': 'column', gap: '2px', 'min-width': 0 })}"><span style="${css({ 'font-size': '15px', 'font-weight': 600, color: INK, 'font-family': bodyFont })}">${esc(level)}</span><span style="${css({ 'font-size': '13px', 'line-height': '18px', color: DIM, 'font-family': bodyFont })}">${size}px${s.weight ? ` · ${s.weight}` : ''}${shown < size ? ` · ${esc(t('shown at'))} ${shown}px` : ''}</span><span style="${css({ 'font-size': '12px', 'line-height': '16px', color: DIM, 'font-family': monoFont, 'overflow-wrap': 'anywhere' })}">${s.token ? `--${esc(s.token)}` : esc(s.name)}</span></div>`;
        const textLines = isBody ? linesFor(text, colW, size, 0.52) : linesFor(text, colW, shown, glyph);
        const lhPx = /px$/.test(lh) ? parseFloat(lh) : (parseFloat(lh) || 1.2) * shown;
        rows.push({ h: Math.max(56, textLines * lhPx) + 28 + (big ? 60 : 0), html: `<div style="${css({ '--bb-kind': 'specimen', display: 'grid', 'grid-template-columns': big ? 'minmax(0, 1fr)' : `${span(2)}px minmax(0, 1fr)`, 'column-gap': `${GUTTER}px`, 'row-gap': '16px', 'align-items': 'start', 'border-top': `1px solid ${RULE}`, padding: '12px 0 14px' })}">${spec}<p style="${css({ '--bb-sample': isBody ? 'copy' : text.toLowerCase() === name.toLowerCase() ? '' : 'headline', margin: 0, 'font-size': `${shown}px`, 'line-height': lh, 'font-weight': s.weight || undefined, 'letter-spacing': tracking, 'font-family': famFor(s), color: INK, 'max-width': isBody ? '760px' : undefined, 'text-wrap': isBody ? 'pretty' : 'balance' })}" dir="auto">${esc(text)}</p></div>` });
      }
      // A display size that takes most of a page gets that page; the other steps share the next.
      const [first, ...others] = rows;
      // The display size gets a page of its own only when it and the other steps do not fit on one.
      const alone = !!first && first.h > (BODY - 50) * 0.45 && rows.reduce((sum, r) => sum + r.h * 1.02, 0) > BODY - 60;
      if (alone) pages.push(stack(0, `${h3(esc(t('Scale')))}<div style="height:12px"></div>${first.html}`));
      for (const part of paginate(alone ? others : rows, (r) => r.h * 1.02, BODY - 60)) pages.push(stack(0, `${h3(esc(t('Scale')))}<div style="height:12px"></div>${part.map((r) => r.html).join('')}`));
    }
    const c = chapter('type');
    add({ id: 'type', title: t('Typography'), intro: introOf(c?.markdown), introLang: langAttr(c), pages }, 'Typography');
  }

  // Space and layout: the scales drawn, and the short rules of the page; the long notes stay in the export.
  {
    const pages: string[] = [];
    const layoutNotes = P(f.layoutNotes);
    const notes = [P(f.grid) ? (/^[\p{L} ]{2,24}:/u.test(P(f.grid)) ? upTo(P(f.grid), 260) : `${t('Grid')}: ${upTo(P(f.grid), 260)}`) : '', f.container ? `${t('Content is at most')} ${f.container}${t('px wide.')}` : '', f.shadows === 'none' ? t('No shadows.') : '', f.gradients === 'none' ? t('No gradients.') : ''].filter(Boolean) as string[];
    // Long layout prose becomes a few short facts: whole sentences without measurements, at most five; the rest is in
    // the export.
    const facts = sentencesOf(layoutNotes).filter((x) => x.length <= 150 && !/\d\s*(px|vw|vh|%|fr|u\b)|\bu\s*=|min\(|max\(|clamp\(/i.test(x)).slice(0, 5);
    const cut = sentencesOf(layoutNotes).length > facts.length;
    if (data.spacing.length || data.radius.length || notes.length || facts.length) {
      // One step per value, with every token that names it: a scale with aliases draws each size once.
      const steps = (list: typeof data.spacing) => [...new Set(list.map((s) => s.value))].sort((a, b) => a - b).map((v) => ({ value: v, tokens: list.filter((s) => s.value === v).map((s) => s.token) }));
      const spacingSteps = steps(data.spacing);
      const radiusSteps = steps(data.radius).slice(0, 6);
      const tokensOf = (list: string[], room: number) => {
        const shown: string[] = [];
        for (const tk of list) { if (shown.length && (shown.join(', ').length + tk.length + 4) * 6.8 > room) break; shown.push(`--${tk}`); }
        return `${esc(shown.join(', '))}${list.length > shown.length ? ` +${list.length - shown.length}` : ''}`;
      };
      const fmt = (v: number) => `${Math.round(v * 10) / 10}px`;
      let spacing = '';
      let spacingH = 0;
      if (spacingSteps.length && spacingSteps.length <= 9) {
        // Few sizes: the squares in a row, bottom-aligned, each with its size and names.
        const colW = Math.floor((CONTENT - 16 * (spacingSteps.length - 1)) / spacingSteps.length);
        // Drawn at a whole or half multiple of their size, said under the heading.
        const k = Math.max(0.5, Math.floor(Math.min(3, 150 / Math.max(...spacingSteps.map((x) => x.value))) * 2) / 2);
        spacing = `<div style="${css({ '--bb-grid': 'free', display: 'grid', 'grid-template-columns': `repeat(${spacingSteps.length}, minmax(0, 1fr))`, gap: '16px', 'align-items': 'end' })}">${spacingSteps.map((s) => stack(8, `<div style="${css({ width: `${Math.max(6, Math.min(s.value * k, colW, 150))}px`, height: `${Math.max(6, Math.min(s.value * k, 150))}px`, background: ACCENT })}"></div>${label(fmt(s.value), { 'white-space': 'nowrap' })}<p style="${css({ margin: 0, 'font-size': '11px', 'line-height': '15px', 'font-family': monoFont, color: DIM, 'overflow-wrap': 'anywhere' })}">${s.tokens.map((tk) => esc(`--${tk}`)).join('<br>')}</p>`)).join('')}</div>`;
        spacingH = 40 + 150 + 30 + Math.max(...spacingSteps.map((s) => s.tokens.length)) * 15 * 2;
      } else if (spacingSteps.length) {
        // Many sizes: a ruled table in two columns, a bar as long as the size.
        const perCol = Math.ceil(spacingSteps.length / 2);
        // Bars as long as their size against the largest, so that no two sizes draw the same.
        const maxSpace = Math.max(...spacingSteps.map((x) => x.value));
        const colW = (CONTENT - 40) / 2;
        const rowFor = (s: (typeof spacingSteps)[number]) => `<div style="${css({ display: 'grid', 'grid-template-columns': '56px 120px minmax(0, 1fr)', gap: '12px', 'align-items': 'center', 'border-top': `1px solid ${RULE}`, padding: '4px 0', 'min-width': 0 })}">${label(fmt(s.value), { 'white-space': 'nowrap', color: INK })}<div style="${css({ height: '10px', width: `${Math.max(2, Math.round((s.value / maxSpace) * 120))}px`, background: ACCENT })}"></div><p style="${css({ margin: 0, 'font-size': '11px', 'line-height': '16px', 'font-family': monoFont, color: DIM, 'white-space': 'nowrap', 'min-width': 0 })}">${tokensOf(s.tokens, colW - 200)}</p></div>`;
        spacing = grid('1fr 1fr', [spacingSteps.slice(0, perCol), spacingSteps.slice(perCol)].map((c) => stack(0, c.map(rowFor).join(''))).join(''), 40, { 'align-items': 'start' });
        spacingH = 40 + perCol * 27;
      }
      const radius = radiusSteps.map((s) => stack(8, `<div style="${css({ width: '80px', height: '80px', background: ground?.value ?? '#f1f0ec', 'box-shadow': `inset 0 0 0 2px ${ink?.value ?? INK}`, 'border-radius': `${Math.min(s.value, 40)}px` })}"></div>${label(fmt(s.value), { 'white-space': 'nowrap', color: INK })}<p style="${css({ margin: 0, 'font-size': '11px', 'line-height': '15px', 'font-family': monoFont, color: DIM, 'overflow-wrap': 'anywhere' })}">${s.tokens.slice(0, 3).map((tk) => esc(`--${tk}`)).join('<br>')}</p>`, { width: '120px' })).join('');
      const scaleH = (spacing ? spacingH : 0) + (radius ? 40 + 80 + 90 + 32 : 0);
      const spacingK = spacingSteps.length && spacingSteps.length <= 9 ? Math.max(0.5, Math.floor(Math.min(3, 150 / Math.max(...spacingSteps.map((x) => x.value))) * 2) / 2) : 1;
      const scaleNote = spacingSteps.length > 9 ? '' : spacingK === 1 ? t('At their true size.') : `${t('Shown at')} ${String(spacingK).replace('.', lang === 'de' ? ',' : '.')}×.`;
      const scale = spacing || radius ? stack(32, `${spacing ? stack(14, `<div style="display:flex;align-items:baseline;gap:12px">${h3(esc(t('Spacing scale')))}${label(esc(scaleNote))}</div>${spacing}`) : ''}${radius ? stack(14, `${h3(esc(t('Corners')))}<div style="display:flex;flex-wrap:wrap;gap:24px">${radius}</div>`) : ''}`) : '';
      const allNotes = [...notes, ...facts];
      const notesHtml = allNotes.length ? stack(12, `${h3(esc(t('Rules of the page')))}${grid('1fr 1fr', allNotes.map((n) => small(esc(n), { 'font-size': '14px', 'line-height': '21px' })).join(''), 32, { 'row-gap': '12px' })}${cut ? label(esc(t('The full layout notes are in the Markdown export.'))) : ''}`) : '';
      const notesLarge = allNotes.length ? stack(16, `${h3(esc(t('Rules of the page')))}${grid('1fr 1fr', allNotes.map((n) => small(esc(n), { 'font-size': '19px', 'line-height': '29px', 'border-top': `1px solid ${RULE}`, 'padding-top': '12px' })).join(''), 40, { 'row-gap': '22px' })}${cut ? label(esc(t('The full layout notes are in the Markdown export.'))) : ''}`) : '';
      const notesH = allNotes.length ? 40 + Math.max(...allNotes.map((n) => linesFor(n, (CONTENT - 32) / 2, 14, 0.52))) * 21 * Math.ceil(allNotes.length / 2) + 30 : 0;
      if (scale && notesHtml && scaleH + 36 + notesH > BODY) {
        pages.push(scale);
        const short = allNotes.length <= 4 && !cut ? bigRules(allNotes.map((n) => ({ text: n, kind: 'do' as const, severity: 'none' }))) : '';
        pages.push(short ? stack(16, `${h3(esc(t('Rules of the page')))}${short.replace(/>(Do|Tun)<\/span>/g, '></span>')}`) : notesLarge);
      }
      else pages.push(stack(36, `${scale}${notesHtml}`));
    }
    const c = chapter('layout');
    add({ id: 'layout', title: t('Space and layout'), intro: introOf(c?.markdown), introLang: langAttr(c), pages }, 'Space and layout');
  }

  // Voice
  {
    const pages: string[] = [];
    const use = data.words.filter((w) => w.use === 'use');
    const avoid = data.words.filter((w) => w.use === 'avoid');
    // The brand's own examples, less those whose good line breaks its own rules: they are counted in the colophon.
    // A slogan of short sentences set against each other is a headline, held to the one-statement rule too.
    const slogan = (x: string) => policy.oneStatement && sentencesOf(x).length >= 2 && sentencesOf(x).every((y) => y.split(/\s+/).length <= 5);
    const keeps = (x: string) => copyOk(x) && !slogan(x);
    const examples = data.voiceExamples.filter((e) => (e.good || e.bad) && (!e.good || keeps(e.good)));
    leftOutExamples = data.voiceExamples.filter((e) => e.good && !keeps(e.good)).length;
    const voiceRules = data.rules.filter((r) => r.topic === 'voice').map((r) => ({ ...r, text: PI(r) })).filter((r) => r.text);
    const toneAll = P(f.tone);
    /** Voice rules that did not fit with the tone go ahead of the examples. */
    let rulesFirst: { html: string; h: number } | null = null;
    if (toneAll || use.length || avoid.length || examples.length || voiceRules.length) {
      // Set large, the tone is a headline: under a one-statement rule only its first sentence is.
      const toneHead = policy.oneStatement && sentencesOf(toneAll).length > 1 ? sentencesOf(toneAll)[0]! : toneAll.length > 150 ? upTo(toneAll, 130) : toneAll;
      const toneRest = toneAll.length > toneHead.length + 2 ? upTo(toneAll.slice(toneAll.indexOf(toneHead) + toneHead.length).trim(), 260) : '';
      const words = (use.length || avoid.length) ? grid('1fr 1fr', `${stack(10, `${h3(esc(t('Say')))}<div style="display:flex;flex-wrap:wrap;gap:8px">${use.slice(0, 16).map((w) => `<span style="${css({ padding: '5px 12px', background: mixHex(INK, PAPER, 0.9), color: INK, 'box-shadow': `inset 3px 0 0 ${INK}`, 'font-size': '15px', 'line-height': '22px', 'font-family': bodyFont })}">${said(w, w.word)}</span>`).join('')}</div>`)}${stack(10, `${h3(esc(t('Avoid')))}${stack(6, avoid.slice(0, 7).map((w) => small(`<s style="color:${BAD}">${said(w, w.word)}</s>${w.instead ? ` <svg role="img" aria-label="${escapeAttr(t('say'))}" width="14" height="10" viewBox="0 0 14 10" style="display:inline-block;vertical-align:middle;margin:0 2px"><path d="M0 5h12M8 1l4 4-4 4" fill="none" stroke="${DIM}" stroke-width="1.5"/></svg> ${said(w, w.instead)}` : ''}`)).join(''))}`)}`, 40) : '';
      const toneFace = toneHead && (headingIsText || linesFor(toneHead, 780, 34, 0.56) <= 3) ? headingFont : bodyFont;
      const tone = toneHead ? `<p class="bb-xl" style="${css({ margin: 0, 'font-size': toneFace === headingFont ? '34px' : '26px', 'line-height': toneFace === headingFont ? 1.18 : 1.35, 'font-family': toneFace, 'font-weight': toneFace === headingFont ? headingWeight : 500, color: INK, 'max-width': '780px', 'text-wrap': 'balance' })}" dir="auto">${esc(toneHead)}</p>${toneRest ? small(esc(toneRest), { 'font-size': '17px', 'line-height': '26px', 'max-width': '720px' }) : ''}` : '';
      const rules = voiceRules.length ? stack(6, voiceRules.slice(0, 3).map((r) => `<div style="display:flex;gap:12px;align-items:baseline;min-width:0"><span style="width:88px;flex:none;display:flex">${ruleTag(r, 13)}</span>${small(`${said(r, upTo(r.text, 320))}${mark(r)}`, { flex: '1 1 0' })}</div>`).join('')) : '';
      const wordsH = (use.length || avoid.length) ? 34 + Math.max(Math.ceil(use.slice(0, 16).length / 3) * 40, avoid.slice(0, 7).length * 28) : 0;
      const toneH = toneHead ? linesFor(toneHead, 780, 34, 0.5) * 40 + (toneRest ? 16 + linesFor(toneRest, 720, 17) * 26 : 0) : 0;
      const rulesH = voiceRules.slice(0, 3).reduce((s, r) => s + linesFor(upTo(r.text, 320), CONTENT - 76, 15) * 22 + 6, 0);
      if (!use.length && !avoid.length && !voiceRules.length && !examples.length && toneAll) {
        // Only the tone: one large quote, set on the page's baseline.
        // A description of the voice, not a quotation: set large under a bar of the accent, without quotation marks.
        pages.push(stack(28, `<span aria-hidden="true" style="${css({ display: 'block', width: '64px', height: '6px', background: ACCENT })}"></span>${displayOrLead(wholeUpTo(toneAll, 260) || upTo(toneAll, 260), 54, 1000, 4, INK, 32)}`, { flex: '1 1 auto', 'justify-content': 'center' }));
      } else if (toneH + wordsH + rulesH + 72 > BODY && toneH + wordsH + 56 <= BODY && rules && examples.length) { pages.push(stack(36, `${stack(16, tone)}${words}`)); rulesFirst = { html: `${h3(esc(t('Rules')))}<div style="height:10px"></div>${rules}`, h: rulesH + 54 }; }
      else if (toneH + wordsH + rulesH + 72 > BODY) { pages.push(stack(28, stack(16, tone))); pages.push(stack(36, `${words}${rules}`)); }
      else pages.push(stack(36, `${stack(16, tone)}${words}${rules}`));
      // Examples, spread evenly over as few pages as hold them. Without bad versions, the good ones fill two columns.
      if (examples.length) {
        const half = (CONTENT - 40) / 2;
        const exSize = examples.length <= 3 ? 24 : 17;
        const exLh = examples.length <= 3 ? 33 : 25;
        const goodCell = (e: (typeof examples)[number]) => `<div style="display:flex;gap:12px;border-top:2px solid ${GOOD};padding-top:10px"><span style="${css({ 'font-size': '13px', 'line-height': '25px', color: GOOD, 'font-weight': 600, 'font-family': bodyFont, width: '88px', flex: 'none' })}">${esc(t('Write'))}</span>${small(esc(e.good), { '--bb-sample': 'copy', 'font-size': `${exSize}px`, 'line-height': `${exLh}px`, flex: '1 1 0' }).replace('<p ', `<p${itemLang(e)} `)}</div>`;
        const badCell = (e: (typeof examples)[number]) => e.bad ? `<div style="display:flex;gap:12px;border-top:2px solid ${BAD};padding-top:10px"><span style="${css({ 'font-size': '13px', 'line-height': '25px', color: BAD, 'font-weight': 600, 'font-family': bodyFont, width: '88px', flex: 'none' })}">${esc(t('Not'))}</span>${small(esc(e.bad), { 'font-size': `${exSize}px`, 'line-height': `${exLh}px`, color: DIM, flex: '1 1 0' }).replace('<p ', `<p${itemLang(e)} `)}</div>` : '<div></div>';
        const lineCell = (e: (typeof examples)[number]) => `<div style="border-top:2px solid ${ACCENT};padding-top:10px">${small(`${lang === 'de' ? '„' : '“'}${esc(e.good)}${lang === 'de' ? '“' : '”'}`, { '--bb-sample': 'copy', 'font-size': `${exSize}px`, 'line-height': `${exLh}px` }).replace('<p ', `<p${itemLang(e)} `)}</div>`;
        // Pairs first, a row each; then the good lines that have no bad one, two to a row.
        const pairs = examples.filter((e) => e.good && e.bad);
        const singles = examples.filter((e) => e.good && !e.bad);
        const exH = (e: (typeof examples)[number]) => 12 + Math.max(linesFor(e.good, half - 60, exSize, 0.5), e.bad ? linesFor(e.bad, half - 60, exSize, 0.5) : 0) * exLh;
        const blocks: { html: string; h: number }[] = [
          ...pairs.map((e) => ({ html: grid('1fr 1fr', `${goodCell(e)}${badCell(e)}`, 40), h: exH(e) })),
          // Lines without a version to avoid are examples of the voice, not a "do" without its "don't".
          ...Array.from({ length: Math.ceil(singles.length / 2) }, (_, k) => singles.slice(k * 2, k * 2 + 2)).map((two, k) => ({ html: `${k === 0 && pairs.length ? `<div style="height:14px"></div>${h3(esc(t('Examples')))}` : ''}${grid('1fr 1fr', `${two.map(lineCell).join('')}${two.length < 2 ? '<div></div>' : ''}`, 40)}`, h: Math.max(...two.map(exH)) + (k === 0 && pairs.length ? 46 : 0) })),
        ];
        if (rulesFirst) blocks.unshift(rulesFirst);
        const examplesH = blocks.reduce((sum, x) => sum + x.h + 22, 0) + 46;
        const firstH = toneH + wordsH + rulesH + 72;
        if (pages.length === 1 && firstH + examplesH + 36 <= BODY) {
          // A short voice page takes its few examples too, rather than leaving two half-empty pages.
          pages[0] = stack(36, `${pages[0]!}${stack(22, `${h3(esc(t('In use')))}${blocks.map((x) => x.html).join('')}`)}`);
        } else for (const part of paginate(blocks, (x) => x.h + 22, BODY - 50)) pages.push(stack(22, part[0] === rulesFirst ? `${part[0]!.html}${part.length > 1 ? `<div style="height:8px"></div>${h3(esc(t('In use')))}${part.slice(1).map((x) => x.html).join('')}` : ''}` : `${h3(esc(t('In use')))}${part.map((x) => x.html).join('')}`));
      }
    }
    const c = chapter('voice');
    const intro = introOf(c?.markdown);
    // The rail does not repeat the tone the page already sets large.
    const repeats = !!toneAll && !!intro && (toneAll.slice(0, 40) === intro.slice(0, 40));
    add({ id: 'voice', title: t('Voice and tone'), intro: repeats ? '' : intro, introLang: langAttr(c), pages }, 'Voice and tone');
  }

  // Imagery and icons
  /** Imagery rules that would stand alone on a page: they join the Rules chapter. */
  const spill: BrandRule[] = [];
  {
    const pages: string[] = [];
    const images = data.assets.filter((a) => a.kind === 'image' && !otherBrandShot(a));
    const icons = data.assets.filter((a) => a.kind === 'icon');
    const rules = data.rules.filter((r) => r.topic === 'imagery' || r.topic === 'iconography').map((r) => ({ ...r, text: PI(r) })).filter((r) => r.text);
    if (data.treatments.length || images.length || icons.length || rules.length) {
      const treat = data.treatments.slice(0, 2).map((tr) => stack(8, `${grid('1fr 1fr', [tr.before, tr.after].map((src, i) => src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(`${tr.name}, ${i ? 'after' : 'before'}`)}" style="width:100%;height:220px;object-fit:cover;display:block">` : `<div style="height:220px;background:${RULE}"></div>`).join(''), 12)}${label(`${esc(tr.name)}: ${esc(tr.mode)}${tr.inks.length ? ` · ${esc(tr.inks.join(', '))}` : ''}.`)}`)).join('');
      const picCount = Math.min(images.length, treat ? 3 : 6);
      const picCols = picCount <= 4 ? Math.max(picCount, 2) : 3;
      const picH = picCols === 2 ? 340 : picCols === 3 && picCount <= 3 ? 300 : picCols === 4 ? 220 : 200;
      // The brand's own picture rules, kept by the book: screenshots whole when it says so, portraits (or all photos)
      // in greyscale when it says so.
      const isScreen = (a: { name: string; tags: string[] }) => /screen|shot|website|webseite|seite\b|referenz|reference|open-graph|og-|\bui\b/i.test(`${a.name} ${a.tags.join(' ')}`);
      const isPortrait = (a: { name: string; tags: string[] }) => /porträt|portrait|person|headshot|team|gesicht|face/i.test(`${a.name} ${a.tags.join(' ')}`);
      const picStyle = (a: { name: string; tags: string[] }) => {
        const screen = isScreen(a);
        const gray = policy.grayscale === 'photos' ? !screen : policy.grayscale === 'portraits' && isPortrait(a);
        return `--bb-kind:${screen ? 'screen' : isPortrait(a) ? 'portrait' : 'photo'};width:100%;height:${picH}px;object-fit:${screen && policy.uncroppedScreens ? 'contain' : 'cover'};${screen && policy.uncroppedScreens ? `background:${TINT};` : ''}${gray ? 'filter:grayscale(1);' : ''}display:block`;
      };
      const pics = images.slice(0, picCount).map((a) => stack(6, `<img src="${escapeAttr(a.asset)}" alt="${escapeAttr(a.alt || a.name)}" style="${picStyle(a)}">${label(esc(a.name))}`)).join('');
      const iconList = icons.slice(0, 12);
      const fewIcons = iconList.length <= 4;
      const icon = (a: (typeof icons)[number]) => stack(8, `<div style="${css({ height: fewIcons ? '220px' : '72px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', background: TINT })}"><img src="${escapeAttr(a.asset)}" alt="${escapeAttr(a.alt || a.name)}" style="width:${fewIcons ? 120 : 40}px;height:${fewIcons ? 120 : 40}px;object-fit:contain"></div>${label(esc(a.name.replace(/\s*\([^)]*\)\s*$/, '')), { 'font-size': '12px', 'line-height': '16px' })}`);
      const iconGrid = iconList.length ? grid(fewIcons ? `repeat(${Math.max(iconList.length, 3)}, minmax(0, 1fr))` : 'repeat(6, minmax(0, 1fr))', iconList.map(icon).join(''), fewIcons ? 24 : 16, { 'row-gap': '20px' }) : '';
      const iconsH = iconList.length ? (fewIcons ? 220 + 42 : Math.ceil(iconList.length / 6) * (72 + 8 + 34 + 20)) : 0;
      // Do and do not side by side, so the guidance reads as pairs; a sentence the chapter's opener already says is not said again.
      const introText = introOf(chapter('imagery')?.markdown);
      const fresh = rules.filter((r) => !introText.includes(r.text.slice(0, 60))).slice(0, 8);
      const doList = fresh.filter((r) => r.kind !== 'dont'), dontList = fresh.filter((r) => r.kind === 'dont');
      const ruleCol = (title: string, list: typeof fresh, color: string) => list.length ? stack(10, `<span style="${css({ 'font-size': '15px', 'font-weight': 600, color, 'font-family': bodyFont, 'border-bottom': `2px solid ${color}`, 'padding-bottom': '6px' })}">${esc(t(title))}</span>${list.map((r) => small(said(r, upTo(r.text, 260)), { 'font-size': '16px', 'line-height': '24px' })).join('')}`) : '<div></div>';
      const ruleList = !fresh.length ? '' : doList.length && dontList.length ? grid('1fr 1fr', ruleCol('Do', doList, GOOD) + ruleCol('Do not', dontList, BAD), 56, { 'align-items': 'start' }) : stack(0, ruleCol(doList.length ? 'Do' : 'Do not', doList.length ? doList : dontList, doList.length ? GOOD : BAD), { 'max-width': '760px' });
      const pictures = `${treat ? grid(`repeat(${Math.min(data.treatments.length, 2)}, minmax(0, 1fr))`, treat, 32) : ''}${pics ? grid(`repeat(${picCols}, minmax(0, 1fr))`, pics, 20) : ''}`;
      const picturesH = (treat ? 260 : 0) + (pics ? (picH + 30) * Math.ceil(picCount / picCols) + 20 * (Math.ceil(picCount / picCols) - 1) : 0);
      const rulesH = 40 + Math.max(...[doList, dontList].map((l) => l.reduce((s, r) => s + linesFor(upTo(r.text, 260), (CONTENT - 56) / 2, 16) * 24 + 10, 0)));
      // As many of pictures, icons and rules on a page as fit, in that order; the rest on the next.
      const parts = [pictures && { html: pictures, h: picturesH }, iconGrid && { html: iconGrid, h: iconsH }, ruleList && { html: ruleList, h: rulesH }].filter((x): x is { html: string; h: number } => !!x);
      let page: string[] = [];
      let used = 0;
      for (const p of parts) {
        if (page.length && used + 32 + p.h > BODY) { pages.push(stack(32, page.join(''))); page = []; used = 0; }
        page.push(p.html); used += (page.length > 1 ? 32 : 0) + p.h;
      }
      if (page.length) {
        // Rules left alone on a page are few: set them large rather than as a short list at the top of an empty page.
        const leftover = page.length === 1 && page[0] === ruleList;
        if (leftover && fresh.length <= 2) spill.push(...fresh);
        else {
          const alone = leftover && fresh.length <= 4 ? bigRules(fresh.map((r) => ({ ...r, kind: r.kind }))) : '';
          pages.push(alone || stack(32, page.join('')));
        }
      }
    }
    const c = chapter('imagery');
    add({ id: 'imagery', title: t('Imagery and icons'), intro: introOf(c?.markdown), introLang: langAttr(c), pages }, 'Imagery and icons');
  }

  // Rules: do and do not side by side; a page takes rules until a column is full, and no rule is cut short.
  {
    const pages: string[] = [];
    const rules = [...data.rules.filter((r) => !['voice', 'imagery', 'iconography'].includes(r.topic)).map((r) => ({ ...r, text: PI(r) })).filter((r) => r.text), ...spill];
    if (rules.length) {
      const colW = (CONTENT - 48) / 2;
      const textW = colW - 100;
      // A rule about something that can be drawn (corners, shadows, gradients, capitals) shows it: the way the brand
      // does it next to the way it does not, with a small red cross.
      const visualFor = (r: BrandRule): string => {
        const x = r.text.toLowerCase();
        const tile = (inner: string, style: string, bad: boolean) => `<span style="${css({ ...(bad ? { '--bb-kind': 'demo' } : {}), position: 'relative', width: '52px', height: '36px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', flex: 'none' })}"><span style="${style}">${inner}</span>${bad ? `<span aria-hidden="true" style="${css({ position: 'absolute', top: '-6px', right: '-6px', width: '16px', height: '16px', 'border-radius': '8px', background: BAD, color: textOn(BAD), 'font-size': '11px', 'line-height': '16px', 'text-align': 'center', 'font-family': 'system-ui, sans-serif', 'font-weight': 700 })}">×</span>` : ''}</span>`;
        const box = (extra: string) => `display:block;width:44px;height:28px;background:${primary?.value ?? INK};${extra}`;
        let good = '', bad = '';
        if (/square|eckig|kantig|sharp corner|no (round|radius)|keine runden/.test(x)) { good = tile('', box('border-radius:0'), false); bad = tile('', box('border-radius:12px'), true); }
        else if (/rounded corner|abgerundet|runde ecken/.test(x)) { good = tile('', box('border-radius:10px'), false); bad = tile('', box('border-radius:0'), true); }
        else if (/\b(no|keine?|ohne|without|never|nie)\b[^.]{0,30}(shadow|schatten)/.test(x)) { good = tile('', box(''), false); bad = tile('', box('box-shadow:0 6px 14px rgba(0,0,0,.35)'), true); }
        else if (/versatzschatten|offset shadow|hard shadow|harter schatten/.test(x) && !policy.noShadow) { good = tile('', box(`box-shadow:4px 4px 0 ${ink?.value ?? INK_BLACK}`), false); bad = tile('', box('box-shadow:0 6px 14px rgba(0,0,0,.35)'), true); }
        else if (/no gradient|keine? verl[äa]uf|without gradient|ohne verlauf|flächig/.test(x)) { good = tile('', box(''), false); bad = tile('', box(`background:linear-gradient(135deg, ${primary?.value ?? INK}, ${second?.value ?? '#ffffff'})`), true); }
        if (!good) return '';
        return `<span style="display:flex;gap:14px;flex:none;padding-top:2px">${good}${bad}</span>`;
      };
      const item = (r: BrandRule, _color: string) => `<div style="display:flex;gap:12px;border-top:1px solid ${RULE};padding:8px 0 0;min-width:0"><span style="width:88px;flex:none;display:flex">${ruleTag(r)}</span><p${itemLang(r)} style="${css({ margin: 0, 'font-size': '14px', 'line-height': '21px', color: INK, 'font-family': bodyFont, 'min-width': 0, flex: '1 1 0', 'text-wrap': 'pretty' })}">${esc(r.text)}${mark(r)}</p>${visualFor(r)}</div>`;
      const height = (r: BrandRule) => Math.max(linesFor(r.text, textW - (visualFor(r) ? 132 : 0), 14, 0.55) * 21, r.suggested ? 36 : 0, visualFor(r) ? 44 : 0) + 18;
      const room = BODY - 40;
      const dos = sortRules(rules.filter((r) => r.kind === 'do'));
      const donts = sortRules(rules.filter((r) => r.kind === 'dont'));
      const big = rules.length <= 4 ? bigRules(rules) : '';
      if (big) {
        pages.push(big);
      } else if (dos.length && donts.length) {
        // Side by side; each page takes from both lists until either column is full.
        const sum = (l: BrandRule[]) => l.reduce((x, r) => x + height(r), 0);
        const count = Math.max(1, Math.ceil(Math.max(sum(dos), sum(donts)) / room));
        const da = paginate(dos, height, room, count), db = paginate(donts, height, room, count);
        const last = Math.max(da.length, db.length) - 1;
        if (last > 0 && (da[last]?.length ?? 0) + (db[last]?.length ?? 0) <= 1) {
          for (const col of [da, db]) if (col.length > last) { const moved = col.pop()!; col[last - 1] = [...(col[last - 1] ?? []), ...moved]; }
        }
        for (let k = 0; k < Math.max(da.length, db.length); k++) {
          const a = da[k] ?? [], b = db[k] ?? [];
          const col = (title: string, list: BrandRule[], color: string) => list.length ? stack(10, `${h3(esc(t(title)))}${list.map((r) => item(r, color)).join('')}`) : '<div></div>';
          const big2 = '';
          pages.push(big2 || grid('1fr 1fr', col('Do', a, GOOD) + col('Do not', b, BAD), 48, { 'align-items': 'start' }));
        }
      } else {
        // One kind only: one heading, the rules in two columns.
        const list = dos.length ? dos : donts;
        const color = dos.length ? GOOD : BAD;
        let k = 0;
        while (k < list.length) {
          const cols: BrandRule[][] = [[], []];
          for (const c of cols) { let u = 0; while (k < list.length && (u + height(list[k]!) <= room || !c.length)) { u += height(list[k]!); c.push(list[k++]!); } }
          const big3 = pages.length && cols[0]!.length + cols[1]!.length <= 3 ? bigRules([...cols[0]!, ...cols[1]!]) : '';
          if (big3) { pages.push(big3); continue; }
          pages.push(stack(10, `${h3(esc(t(dos.length ? 'Do' : 'Do not')))}${grid('1fr 1fr', cols.map((c) => stack(10, c.map((r) => item(r, color)).join(''))).join(''), 48, { 'align-items': 'start' })}`));
        }
      }
    }
    if (pages.length && rules.some((r) => r.suggested)) pages[0] = stack(14, `${label(esc(t('Proposed rules: they bind nobody until the brand confirms them.')), { 'font-size': '14px' })}${pages[0]!}`, { flex: '1 1 auto' });
    add({ id: 'rules', title: t('Rules'), pages }, 'Rules');
  }

  // Tokens, grouped by what they are for: core values, semantic roles, components. A token whose name says something
  // its value is not (a hex or a font that is not the one it holds) is left out rather than shown wrong.
  {
    const pages: string[] = [];
    const fontNames = ['inter', 'roboto', 'helvetica', 'arial', 'grotesk', 'mono', 'serif', 'sans', 'archivo', 'jetbrains', 'jbmono', 'plex', 'geist', 'manrope', 'satoshi', 'poppins'];
    const honestFont = (token: string, family: string) => { const tk = token.toLowerCase(); const fam = family.toLowerCase(); return !fontNames.some((n) => tk.includes(n) && !fam.replace(/\s+/g, '').includes(n) && !(n === 'mono' && /mono|code/.test(fam)) && !(n === 'sans' && !/serif/.test(fam)) && !(n === 'serif' && /serif/.test(fam))); };
    const component = /button|btn|card|input|field|nav|header|footer|badge|chip|modal|dialog|table|form|link|hero|cta|tab|menu|toast|tooltip/i;
    const coreColours = [ground, ink, primary, second].filter((c): c is BrandColor => !!c);
    type Row = { swatch?: string; token: string; value: string };
    const colourRow = (c: BrandColor): Row => ({ swatch: c.value, token: c.token, value: c.value });
    // Only what a designer works with: core values and semantic roles. Component, project and one-off tokens, and
    // sizes no one sets text in, stay in the CSS export.
    const IMPL = /project|portrait|email|mail|illu|process|extrusion|wordmark|hero|footer|header|(^|-)og(-|$)|favicon|legacy|tmp|test|hover|pressed|active|focus|shadow|(^|-)z(-|$)|index|duration|ease|tirava|sidrit/i;
    const keep = (token: string) => !!token && !IMPL.test(token) && !component.test(token);
    const px = (v: number) => `${Math.round(v * 10) / 10}px`;
    const groups: { title: string; note: string; rows: Row[] }[] = [
      { title: 'Core', note: 'The values everything else is built from.', rows: [
        ...coreColours.filter((c) => honestToken(c.token, c.value) && keep(c.token)).map(colourRow),
        ...data.families.filter((x) => x.token && honestFont(x.token, x.family) && keep(x.token)).map((x) => ({ token: x.token, value: x.family })),
      ] },
      { title: 'Semantic', note: 'Roles: what a colour is for.', rows: data.colors.filter((c) => !coreColours.includes(c) && honestToken(c.token, c.value) && keep(c.token) && colourGroup(c) !== 'Illustration').map(colourRow) },
      // Sizes in order, each kind under its own heading: the spacing from small to large, type from large to small.
      { title: 'Spacing', note: 'From small to large.', rows: [...data.spacing].filter((x) => keep(x.token)).sort((a, b) => a.value - b.value).map((x) => ({ token: x.token, value: px(x.value) })) },
      { title: 'Corners', note: 'From small to large.', rows: [...data.radius].filter((x) => keep(x.token)).sort((a, b) => a.value - b.value).map((x) => ({ token: x.token, value: px(x.value) })) },
      { title: 'Type sizes', note: 'The sizes text is set in, largest first.', rows: [...data.typeScale].filter((x) => x.token && keep(x.token) && x.size <= 160).sort((a, b) => b.size - a.size).map((x) => ({ token: x.token!, value: `${Math.round(x.size)}px` })) },
    ].filter((g) => g.rows.length);
    // Rows flow down two columns per page; a group's heading travels with its first rows.
    type Item = { kind: 'head'; g: (typeof groups)[number]; cont?: boolean } | { kind: 'row'; r: Row; g: (typeof groups)[number] };
    const items: Item[] = groups.flatMap((g) => [{ kind: 'head' as const, g }, ...g.rows.map((r) => ({ kind: 'row' as const, r, g }))]);
    const ROW = 29, HEAD = 62;
    const colH = BODY - 50;
    // As many pages as the rows need, the rows spread evenly over their columns, so no page holds a few left over.
    const totalH = items.reduce((s2, it) => s2 + (it.kind === 'head' ? HEAD : ROW), 0);
    const pageCount = Math.max(1, Math.ceil(totalH / (2 * colH * 0.92)));
    const target = Math.min(colH, totalH / (pageCount * 2) + ROW);
    const flow = (limit: number) => {
      const out: Item[][] = [];
      let col: Item[] = [], used = 0;
      for (const it of items) {
        const h = it.kind === 'head' ? HEAD : ROW;
        const restH = items.slice(items.indexOf(it)).reduce((s2, x) => s2 + (x.kind === 'head' ? HEAD : ROW), 0);
        const room2 = used + restH <= colH && out.length % 2 === 1;
        if (col.length && !room2 && (used + h > limit || (it.kind === 'head' && used + HEAD + 3 * ROW > limit))) {
          out.push(col); col = []; used = 0;
          // A group that goes on in the next column takes its heading with it, so that every column starts on a heading.
          if (it.kind === 'row') { col.push({ kind: 'head', g: it.g, cont: true }); used += HEAD; }
        }
        col.push(it); used += h;
      }
      if (col.length) out.push(col);
      return out;
    };
    // Evenly spread first; when that leaves a last page of a few rows, the columns are filled to the foot instead.
    // The fewest pages first, then the fullest last page: columns from evenly spread up to filled to the foot.
    const lastRows = (c: Item[][]) => c.slice(Math.floor((c.length - 1) / 2) * 2).flat().length;
    let cols = flow(target);
    for (let limit = target + ROW; limit <= colH; limit += ROW) {
      const c = flow(limit);
      const pagesOf = (x: Item[][]) => Math.ceil(x.length / 2);
      if (pagesOf(c) < pagesOf(cols) || (pagesOf(c) === pagesOf(cols) && lastRows(cols) <= 8 && lastRows(c) > lastRows(cols))) cols = c;
    }
    const cell = (it: Item, first = false) => it.kind === 'head'
      ? `<div style="${css({ '--bb-flow-head': '1', padding: '18px 0 8px', display: 'flex', 'align-items': 'baseline', gap: '12px', 'border-bottom': `2px solid ${ACCENT}` })}"><span style="${css({ 'font-size': '17px', 'font-weight': 600, color: INK, 'font-family': bodyFont })}">${esc(t(it.g.title))}</span><span style="${css({ 'font-size': '13px', color: DIM, 'font-family': bodyFont })}">${esc(it.cont ? t('continued') : t(it.g.note))}</span></div>`
      : `<div style="${css({ display: 'grid', 'grid-template-columns': '18px minmax(0, 1fr) max-content', gap: '12px', 'align-items': 'center', 'border-top': first ? '0' : `1px solid ${RULE}`, padding: '5px 0', 'min-width': 0 })}">${it.r.swatch ? `<span style="${css({ width: '18px', height: '18px', background: it.r.swatch, 'box-shadow': `inset 0 0 0 1px ${RULE}` })}"></span>` : '<span></span>'}<code style="${css({ 'font-family': monoFont, 'font-size': '13px', 'line-height': '18px', color: INK, 'white-space': 'nowrap', overflow: 'hidden', 'min-width': 0 })}">--${esc(it.r.token)}</code><span style="${css({ 'font-size': '13px', 'line-height': '18px', color: DIM, 'font-family': bodyFont, 'white-space': 'nowrap' })}">${esc(it.r.value)}</span></div>`;
    for (let i = 0; i < cols.length; i += 2) {
      pages.push(stack(10, `${i === 0 ? label(esc(t('The tokens a designer works with, as CSS custom properties. Every other token is in the brand\'s CSS export.')), { 'font-size': '14px' }) : ''}${grid('1fr 1fr', cols.slice(i, i + 2).map((c) => stack(0, c.map((it, k) => cell(it, k === 0)).join(''), { '--bb-flow': 'column' })).join(''), 56, { 'align-items': 'start' })}`));
    }
    add({ id: 'tokens', title: t('Tokens'), pages }, 'Tokens');
  }

  // Applications: the brand put to work. Pieces drawn here from its own colours, type and logo (stationery, a letter,
  // a social post, a web page), then its real work, cropped so it can be read.
  {
    const pages: string[] = [];
    const de = lang === 'de';
    const A = primary?.value ?? INK;
    const G0 = ground?.value ?? '#ffffff';
    const G = G0;
    const I = ink?.value ?? INK;
    /** The brand's logo made for this ground, else its name set in its display face. */
    const logoOn = (bg: string, box: { w: number; h: number }, align = 'left center') => {
      const l = data.logos.find((x) => madeFor(x, bg) && x === primaryLockup) ?? data.logos.find((x) => madeFor(x, bg) && !compactName.test(x.name)) ?? data.logos.find((x) => madeFor(x, bg));
      if (l) return logoPicture(l, box, `object-position:${align}`);
      // The name on one line, as large as its box allows: a name is not broken where a box happens to end.
      // A name too long for one line at a readable size wraps between its words.
      const oneLine = Math.floor(box.w / (name.length * (displayGlyph + 0.04)));
      const size = oneLine >= 14 ? Math.min(Math.round(box.h * 0.62), oneLine) : Math.max(12, Math.min(Math.round(box.h * 0.62), Math.floor(box.w / (Math.max(...name.split(/\s+/).map((w) => w.length)) * 0.62))));
      return `<span style="${css({ display: 'block', 'max-width': `${box.w}px`, 'font-size': `${size}px`, 'line-height': 1.15, 'font-family': displayFont, 'font-weight': displayWeight, color: textOn(bg), ...(oneLine >= 14 ? { 'white-space': 'nowrap' } : { 'overflow-wrap': 'break-word', 'text-wrap': 'balance' }) })}" dir="auto">${esc(name)}</span>`;
    };
    // A caption clears the piece's hard shadow by as much as it would clear the piece.
    const caption = (s: string) => label(esc(s), { 'font-size': '13px', ...(policy.hardShadow ? { 'margin-top': `${policy.hardShadow}px` } : {}) });
    const good0 = (opts.examples ?? []).filter((e) => e.verdict === 'good');
    const hasWebPage = good0.some((e) => !e.width || e.width > 800);
    // The brand's own words only: its statement, the rest of its positioning, its voice examples. Nothing invented.
    const voiceLines = data.voiceExamples.map((e) => e.good).filter((x) => x && sentenceLanguage(x) !== (lang === 'de' ? 'en' : 'de') && !WORKING_NOTE.test(x) && headlineOk(x));
    const message = shortStatement && shortStatement !== name ? shortStatement : voiceLines.find((x) => x.length <= 60 && x.length >= 12) ?? '';
    // A letter addresses its reader as the brand says letters do: copy that says "du" stays out of a letter in "Sie".
    const fitsLetter = letterOk;
    const letterBody = [rest, P(f.audience)].map((x) => passageOf(x, 360)).filter((x) => x && fitsLetter(x) && !message.includes(x.slice(0, 30))).slice(0, 2);
    // The letter is on the brand's own paper: its ground when that is light, else its lightest colour.
    const LP = [G0, ...data.colors.map((c) => c.value)].filter((v) => luminance(v) > 0.8).sort((a, b) => luminance(b) - luminance(a))[0] ?? '#ffffff';
    const LI = contrastRatio(I, LP) >= 7 ? I : textOn(LP, 7);
    const headFace = (text: string, size: number, width: number) => headingOrBody(text, size, width);
    // A second colour of the brand's, clearly its own, takes the small accents (a bar, a rule), so it has one job.
    const chromaOf = (v: string) => oklch(v)?.c ?? 0;
    const A2 = second && !policy.noField.includes(second.value.toLowerCase()) && !['Text', 'Lines', 'Surfaces'].includes(colourGroup(second)) && chromaOf(second.value) > 0.06 && colorDistance(second.value, A) > 20 && colorDistance(second.value, G0) > 20 ? second.value : A;
    if (data.logos.length || message) {
      // A business card, both sides: the mark on a ground it is made for (the accent when a logo is made for it, else
      // the ink, else the paper), never on a ground its own misuse page crosses out; the brand's one line on the back.
      const cardW = 384, cardH = 236;
      const frontBg = [A, I, G].find((bg) => data.logos.some((l) => madeFor(l, bg))) ?? A;
      const front = `<div style="${css({ width: `${cardW}px`, height: `${cardH}px`, background: frontBg, display: 'flex', 'align-items': 'center', 'justify-content': 'center', padding: '40px', 'box-sizing': 'border-box' })};${lift}">${logoOn(frontBg, { w: 240, h: 80 }, 'center center')}</div>`;
      const back = message ? `<div style="${css({ width: `${cardW}px`, height: `${cardH}px`, background: G, display: 'flex', 'flex-direction': 'column', 'justify-content': 'flex-end', gap: '14px', padding: '34px 36px', 'box-sizing': 'border-box' })};${lift}"><span style="${css({ width: '40px', height: '6px', background: A2 === G ? I : A2 })}"></span><span style="${css({ '--bb-sample': 'headline', 'font-size': '24px', 'line-height': 1.2, 'font-family': headFace(message, 24, 360), 'font-weight': headingWeight, color: textOn(G), 'text-wrap': 'balance' })}" dir="auto">${esc(message)}</span></div>` : '';
      const side = (x: string) => (lang === 'de' ? t(x) : x.toLowerCase());
      const cards = stack(18, `${stack(8, `${front}${caption(`${t('Business card')}, ${side('Front')}`)}`)}${back ? stack(8, `${back}${caption(`${t('Business card')}, ${side('Back')}`)}`) : ''}`);
      // A letter with one clear message: the logo once, the date, the line, the brand's own sentences.
      const letter = letterBody.length && message && fitsLetter(message) ? `<div style="${css({ width: '384px', height: '540px', background: LP, padding: '38px 42px', 'box-sizing': 'border-box', display: 'flex', 'flex-direction': 'column', gap: '18px', overflow: 'hidden' })};${lift}"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">${logoOn(LP, { w: 150, h: 34 })}${opts.date ? `<span style="${css({ 'font-size': '11px', 'font-family': bodyFont, color: mixHex(LI, LP, 0.3), 'padding-top': '6px' })}">${esc(opts.date)}</span>` : ''}</div><div style="height:28px"></div><span style="${css({ '--bb-sample': 'headline', 'font-size': '17px', 'line-height': 1.3, 'font-family': headFace(message, 17, 312), 'font-weight': headingWeight, color: LI })}" dir="auto">${esc(message)}</span>${letterBody.map((x) => `<span style="${css({ '--bb-sample': 'letter', 'font-size': '12px', 'line-height': 1.6, 'font-family': bodyFont, color: LI })}" dir="auto">${esc(x)}</span>`).join('')}<div style="margin-top:auto;height:4px;width:48px;background:${A2 === LP ? LI : A2}"></div></div>` : '';
      if (back || letter) pages.push(stack(20, `${h3(esc(t('Stationery')))}<div style="${css({ display: 'flex', gap: '56px', 'justify-content': 'center', 'align-items': 'flex-start' })}">${cards}${letter ? stack(8, `${letter}${caption(t('Letter, A4'))}`) : ''}</div>`));
      // One message for social media, square and upright: the same line, the logo once.
      const social = message || voiceLines.find((x) => x.length <= 60) || '';
      if (social) {
        // A colour the brand gives a job ("Pink for events, blue for buying and selling") carries copy about that job.
        const STOP = new Set(['and', 'und', 'the', 'der', 'die', 'das', 'for', 'für', 'with', 'mit', 'only', 'nur']);
        const jobs = data.colors.flatMap((c) => data.rules.flatMap((r) => r.text.split(/[,;.]/)).map((clause) => new RegExp(`(?<!\\p{L})${c.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})\\s+(?:is\\s+)?(?:for|für)\\s+(.+)`, 'iu').exec(clause)).filter((m): m is RegExpExecArray => !!m && c.name.trim().length > 2).map((m) => ({ c, stems: (m[1]!.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 3)) })));
        const words = (social.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
        const job = jobs.find((j) => j.stems.some((st) => words.some((w) => w.startsWith(st))) && contrastRatio(textOn(j.c.value), j.c.value) >= 4.5);
        const postBg = job ? job.c.value : A;
        const fg = textOn(postBg);
        const msg = (w: number, max: number) => {
          let size = max;
          const longest = Math.max(...social.split(/\s+/).map((x) => x.length));
          while (size > 24 && (linesFor(social, w, size, displayGlyph) > 4 || longest * size * displayGlyph > w * 0.96)) size -= 2;
          return `<span style="${css({ '--bb-sample': 'headline', 'font-size': `${size}px`, 'line-height': 1.05, 'letter-spacing': '-0.02em', 'font-family': displayFont, 'font-weight': displayWeight, color: fg, 'text-wrap': 'balance' })}" dir="auto">${esc(social)}</span>`;
        };
        const post = `<div style="${css({ width: '540px', height: '540px', background: postBg, padding: '52px', 'box-sizing': 'border-box', display: 'flex', 'flex-direction': 'column', 'justify-content': 'space-between' })};${lift}">${msg(436, 64)}<div>${logoOn(postBg, { w: 150, h: 44 })}</div></div>`;
        // The upright story on the brand's second colour when it has one that carries text, else on its ink.
        const storyBg = A2 !== A && contrastRatio(textOn(A2), A2) >= 4.5 ? A2 : I !== postBg ? I : G;
        const story = `<div style="${css({ width: '304px', height: '540px', background: storyBg, padding: '36px 30px', 'box-sizing': 'border-box', display: 'flex', 'flex-direction': 'column', 'justify-content': 'space-between' })};${lift}"><span style="${css({ width: '36px', height: '6px', background: A !== storyBg ? A : A2 !== storyBg ? A2 : textOn(storyBg) })}"></span>${msg(244, 38).replace(`color:${fg}`, `color:${textOn(storyBg)}`)}<div>${logoOn(storyBg, { w: 120, h: 36 })}</div></div>`;
        pages.push(stack(20, `${h3(esc(t('Social media')))}<div style="${css({ display: 'flex', gap: '48px', 'justify-content': 'center', 'align-items': 'flex-start' })}">${stack(8, `${post}${caption(t('Post, 1:1'))}`)}${stack(8, `${story}${caption('Story, 9:16')}`)}</div>`));
      }
      // The first screen of a home page, drawn only when the brand has none of its own to show: logo, line, the rest of
      // its positioning; no navigation or button the brand never wrote, and a plain frame without fake window chrome.
      const sub = sentencesOf(rest).find((x) => x.length <= 160 && !statement.includes(x.slice(0, 30))) ?? '';
      if (!hasWebPage && statement) {
        const G = data.logos.length && !data.logos.some((x) => madeFor(x, G0)) && primaryLockup ? logoGround(primaryLockup) : G0;
        const heroImage = data.assets.find((x) => x.kind === 'image' && !otherBrandShot(x) && !/screen|shot|referenz|reference|website|seite|og\b|social/i.test(`${x.name} ${x.tags.join(' ')}`));
        const web = `<div style="${css({ width: '100%', height: '540px', background: G, display: 'flex', 'flex-direction': 'column', overflow: 'hidden', border: `1px solid ${RULE}`, 'box-sizing': 'border-box' })}"><div style="${css({ padding: '26px 56px', flex: 'none', 'border-bottom': `1px solid ${mixHex(I, G, 0.85)}` })}">${logoOn(G, { w: 140, h: 38 })}</div><div style="${css({ display: 'grid', 'grid-template-columns': heroImage ? '1.2fr 1fr' : '1fr', gap: '48px', padding: '56px 56px 40px', flex: '1 1 auto', 'min-height': 0, 'align-items': 'center' })}"><div style="display:flex;flex-direction:column;gap:24px;min-width:0">${displayOrLead(ownStatement && headlineOk(ownStatement, true) ? ownStatement : statement, 64, heroImage ? 560 : 900, 3, textOn(G), 40, 'home')}${sub ? `<span style="${css({ 'font-size': '19px', 'line-height': 1.5, 'font-family': bodyFont, color: textOn(G), 'max-width': '600px' })}" dir="auto">${esc(sub)}</span>` : ''}<span style="${css({ width: '64px', height: '6px', background: [A, A2, I, textOn(G)].find((c) => contrastRatio(c, G) >= 3) ?? textOn(G) })}"></span></div>${heroImage ? `<img src="${escapeAttr(heroImage.asset)}" alt="${escapeAttr(heroImage.alt || heroImage.name)}" style="width:100%;height:100%;max-height:380px;object-fit:cover;display:block;min-height:0">` : ''}</div></div>`;
        pages.push(stack(20, `${h3(esc(t('Website')))}${stack(8, `${web}${caption(t('Home page, first screen, drawn from the brand'))}`)}`));
      }
    }
    // The brand's own work, cropped to its first screen so that it can be read: wide pages one to a page, narrow ones
    // three in a row.
    const good = (opts.examples ?? []).filter((e) => e.verdict === 'good');
    // A wrong use of the mark is already drawn on the misuse page; the brand's own sheet of it is not shown twice.
    const bad = (opts.examples ?? []).filter((e) => e.verdict === 'bad' && !(data.logos.length && /(?<!\p{L})(mark|logo|zeichen|marke|wordmark|wortmarke|bildmarke|signet)(?!\p{L})/iu.test(e.name)));
    const narrow = (e: BrandBookExample) => !!e.width && e.width <= 800;
    /** The frame as tall as the picture at its width (never taller than `h`), so that no part of it is blank. */
    const frameH = (e: BrandBookExample, fw: number, h: number) => (e.width && e.height ? Math.min(h, Math.round((fw * e.height) / e.width)) : h);
    /** The smallest text of the picture as the page shows it: under 9px it cannot be read, and the picture is left out. */
    const shownText = (e: BrandBookExample, fw: number) => (e.minTextPx && e.cssWidth ? (e.minTextPx * fw) / e.cssWidth : undefined);
    const frameW = (w: number) => (policy.hardShadow ? w - policy.hardShadow : w);
    /** The frame's size: the picture at the column's width, or, for one taller than `h`, at `h` high and narrower. */
    const frameSize = (e: BrandBookExample, w: number, h: number) => {
      const fw = frameW(w);
      if (e.width && e.height && (fw * e.height) / e.width > h) return { fw: Math.round((h * e.width) / e.height), fh: h };
      return { fw, fh: frameH(e, fw, h) };
    };
    const frame = (e: BrandBookExample, w: number, h: number, isBad = false) => {
      const { fw, fh } = frameSize(e, w, h);
      const tx = shownText(e, fw);
      // The caption names the piece; a note on a picture cut to its first screen would describe what is not shown.
      const note = !e.cut && e.note && P(e.note) ? upTo(P(e.note), 120) : '';
      const what = `${cleanName(e.name)}${e.cut ? `, ${t('first screen')}` : ''}`;
      return `<figure style="margin:0;display:flex;flex-direction:column;gap:10px;min-width:0;width:${fw}px;align-self:${fw >= frameW(CONTENT) - 1 ? 'flex-start' : 'center'}"><div style="${css({ position: 'relative', height: `${fh}px`, background: '#ffffff', overflow: 'hidden' })};${lift}"><img src="${escapeAttr(e.src)}" alt="${escapeAttr(e.name)}" style="${css({ '--bb-kind': 'example', ...(tx ? { '--bb-min-text': `${Math.round(tx * 10) / 10}px` } : {}), width: '100%', height: '100%', 'object-fit': 'cover', 'object-position': 'top center', display: 'block' })}">${isBad ? `<span aria-hidden="true" style="${css({ position: 'absolute', top: '12px', right: '12px', width: '28px', height: '28px', 'border-radius': '14px', background: BAD, color: textOn(BAD), border: `2px solid ${PAPER}`, 'box-sizing': 'border-box', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-size': '18px', 'line-height': 1, 'font-family': 'system-ui, sans-serif', 'font-weight': 700 })}">×</span>` : ''}</div><figcaption style="${css({ 'font-size': '13px', 'line-height': '18px', color: DIM, 'font-family': bodyFont })}">${esc(what)}${note && !sameText(note, cleanName(e.name)) ? `. ${esc(note)}` : ''}</figcaption></figure>`;
    };
    const readable = (e: BrandBookExample, w: number, h = 540) => (shownText(e, frameSize(e, w, h).fw) ?? 99) >= 9;
    const wide = good.filter((e) => !narrow(e) && readable(e, CONTENT)).slice(0, 3);
    const tall = good.filter((e) => narrow(e) && readable(e, 340)).slice(0, 6);
    const work: string[] = [];
    for (const e of wide) work.push(stack(16, `${h3(esc(t('In use')))}${frame(e, CONTENT, 540)}`));
    for (let i = 0; i < tall.length; i += 3) work.push(stack(16, `${h3(esc(t('In use')))}<div style="display:flex;gap:32px;justify-content:center">${tall.slice(i, i + 3).map((e) => frame(e, 340, 540)).join('')}</div>`));
    // The brand's real work leads the chapter; the pieces drawn from it follow.
    pages.unshift(...work);
    // Wrong examples at the width that keeps their text readable: a wide one alone on its page.
    const badShown = bad.filter((e) => readable(e, narrow(e) ? 340 : CONTENT)).slice(0, 2);
    const badWide = badShown.filter((e) => !narrow(e)), badTall = badShown.filter(narrow);
    for (const e of badWide) pages.push(stack(16, `${h3(esc(t('Not like this')))}${frame(e, CONTENT, 520, true)}`));
    if (badTall.length) pages.push(stack(16, `${h3(esc(t('Not like this')))}<div style="display:flex;gap:32px">${badTall.map((e) => frame(e, 340, 520, true)).join('')}</div>`));
    const c = chapter('applications');
    add({ id: 'applications', title: t('Applications'), intro: introOf(c?.markdown), introLang: langAttr(c), pages, bg: mixHex(INK, PAPER, 0.93), tint: true }, 'Applications');
  }

  // ------------------------------------------------------------ assembling the pages
  const out: BrandBookPage[] = [];
  const version = opts.version ? `${t('Version')} ${opts.version}` : t('Not published yet');
  if (appendix.length) sections.push({ id: 'appendix', title: t('Appendix'), pages: appendix, appendix: true });
  const main = sections.filter((s) => !s.appendix);
  // The mark in the running head: the compact mark made for the page's paper, else the lockup made for it.
  const headMark = data.logos.find((l) => compactName.test(l.name) && !/revers|negativ|dark|dunkel/i.test(l.name) && madeFor(l, PAPER)) ?? data.logos.find((l) => madeFor(l, PAPER));
  const sheet = (n: number, section: string, title: string, inner: string, opt: { bg?: string; tint?: boolean; chrome?: boolean; head?: boolean; chapter?: { num: string; title: string } } = {}) => {
    const bg = opt.bg ?? PAPER;
    // A page on a tint of the paper (the applications' desk) keeps the paper's chrome: the mark, the accent rule.
    const paper = bg === PAPER || !!opt.tint;
    const fg = paper ? INK : textOn(bg);
    const dim = paper ? DIM : mixHex(fg, bg, 0.22);
    const chrome = opt.chrome !== false;
    // A mark made for no light ground stands on a small tile of the ground it is made for, so every book has one.
    const tileMark = !headMark ? data.logos.find((l) => (logoAspect(l) ?? 3) < 1.6) ?? primaryLockup : undefined;
    const markHtml = headMark && !paper ? '' : headMark ? `<span style="display:inline-flex;height:18px;align-items:center">${logoPicture(headMark, { w: Math.round(18 * Math.min(6, headMark.aspect || 1)), h: 18 }, 'object-position:left center')}</span>` : tileMark && paper ? `<span style="${css({ display: 'inline-flex', height: '18px', 'align-items': 'center', 'justify-content': 'center', background: logoGround(tileMark), padding: '0 3px', 'box-sizing': 'border-box' })}">${logoPicture(tileMark, { w: Math.round(14 * Math.min(5, logoAspect(tileMark) ?? 1)), h: 14 }, 'object-position:center center')}</span>` : '';
    const head = chrome && opt.head !== false ? `<header class="bb-head" style="${css({ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', gap: '24px', 'font-size': '13px', 'line-height': '18px', color: dim, 'font-family': bodyFont, 'border-bottom': `2px solid ${paper ? ACCENT : fg}`, 'padding-bottom': '10px' })}">${opt.chapter ? `<h2 style="${css({ margin: 0, display: 'flex', 'align-items': 'baseline', gap: '14px', 'white-space': 'nowrap', 'font-size': '20px', 'line-height': '18px', 'font-weight': headingWeight, color: fg, 'font-family': headingFont })}"><span style="${css({ color: paper ? ACCENT : fg, 'font-family': bodyFont, 'font-size': '14px', 'font-weight': 600 })}">${esc(opt.chapter.num)}</span>${esc(opt.chapter.title)}</h2><span style="display:flex;align-items:center;gap:12px">${markHtml}<span dir="auto">${esc(name)}</span></span>` : `<span style="display:flex;align-items:center;gap:12px">${markHtml}<span dir="auto">${esc(name)}\u00a0·\u00a0${esc(t('Brand guidelines'))}</span></span><span style="${css({ color: fg, 'font-weight': 600 })}">${esc(section)}</span>`}</header>` : '';
    const foot = chrome ? `<footer class="bb-foot" style="${css({ display: 'flex', 'justify-content': 'space-between', 'align-items': 'baseline', 'font-size': '13px', 'line-height': '18px', color: dim, 'font-family': bodyFont })}"><span>${esc(version)}${opts.date ? ` · ${esc(opts.date)}` : ''}</span><span style="${css({ color: paper ? ACCENT : fg, 'font-weight': 600 })}">${String(n).padStart(2, '0')}</span></footer>` : '';
    out.push({ section, title, html: typeset(applyPolicy(`<section class="bb-page" data-name="${escapeAttr(`${String(n).padStart(2, '0')} ${title}`)}" lang="${escapeAttr(langs.primary ?? lang)}" style="${css({ width: `${W}px`, height: `${H}px`, flex: 'none', background: bg, color: fg, padding: `40px ${M}px 32px`, display: 'flex', 'flex-direction': 'column', gap: '28px', overflow: 'hidden', 'box-sizing': 'border-box', 'font-family': bodyFont })}">${head}<div class="bb-body" style="display:flex;flex-direction:column;flex:1 1 auto;min-height:0">${inner}</div>${foot}</section>`, data, policy), lang, name) });
  };

  // Cover: the primary lockup on the ground it was made for, the name large in a colour that passes the book's own
  // contrast check, the short statement; never a cut sentence. On a plain ground a field of the accent carries it.
  {
    const lockBg = primaryLockup ? logoGround(primaryLockup) : undefined;
    const bg = lockBg ?? primary?.value ?? INK;
    const plain = !!ground && bg === ground.value || luminance(bg) > 0.8;
    const fg = textOn(bg);
    // The field carries the brand's mark at bleed: its compact mark when one is made for the field's colour, else the
    // first letter of its name in its display face, cropped by the page's edge.
    const fieldBg = plain && primary && primary.value !== bg ? primary.value : '';
    const fieldMark = fieldBg ? data.logos.find((l) => madeFor(l, fieldBg) && (logoAspect(l) ?? 3) < 1.4) : undefined;
    // Drawn as one picture the size of the field, so that what reaches past the page's edge is cropped inside it: the
    // mark at bleed, or the letter, never a layer hanging out of its frame.
    const FW = Math.round(W * 0.34), FH = H;
    const markSrc = fieldMark ? fieldMark.asset ?? `data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(fieldMark.svg ?? ''))) : ''}` : '';
    const markA = fieldMark ? Math.min(1.6, logoAspect(fieldMark) ?? 1) : 1;
    // The letter whole inside the field, standing on the page's bottom margin: no sliver of a cropped glyph at the edge.
    const letterSize = Math.min(560, Math.floor((FW - 64) / (displayGlyph + 0.12)));
    const fieldArt = !fieldBg ? '' : `<svg viewBox="0 0 ${FW} ${FH}" width="100%" height="100%" preserveAspectRatio="xMaxYMax slice" style="display:block">${fieldMark
      ? `<image href="${escapeAttr(markSrc)}" x="${FW - Math.round(440 * markA) + 48}" y="${FH - 400}" width="${Math.round(440 * markA)}" height="440" preserveAspectRatio="xMidYMid meet"/>`
      : `<text x="${Math.round(FW / 2)}" y="${FH - 64}" text-anchor="middle" font-size="${letterSize}" font-family="${escapeAttr(displayFont)}" font-weight="${displayWeight}" fill="${escapeAttr(textOn(fieldBg, 3))}"${policy.displayStretch ? ` style="font-stretch:${policy.displayStretch}%"` : ''}>${esc((name.trim()[0] ?? '').toUpperCase())}</text>`}</svg>`;
    const field = fieldBg ? `<div aria-hidden="true" style="${css({ position: 'absolute', top: '0', right: '0', bottom: '0', width: '34%', background: fieldBg, overflow: 'hidden' })}">${fieldArt}</div>` : '';
    const textW = field ? 700 : 1000;
    // The lockup or the name, never both: a lockup with a wordmark is the cover's hero; a mark alone stands small over
    // the name set in the display face.
    const wordmark = primaryLockup && (logoAspect(primaryLockup) ?? 1) >= 1.4 && madeFor(primaryLockup, bg) ? primaryLockup : undefined;
    const markOnly = !wordmark ? data.logos.find((l) => madeFor(l, bg)) : undefined;
    const longestWord = Math.max(...name.split(/\s+/).map((w) => w.length));
    const wide = displayGlyph + 0.06;
    const nameSize = Math.max(48, Math.min(176, Math.floor(textW / (longestWord * wide)), name.length > 22 ? 96 : name.length > 12 ? 132 : 176));
    const wa = wordmark ? logoAspect(wordmark) ?? 3 : 3;
    const heroW = Math.min(textW, Math.round(300 * wa)), heroH = Math.round(heroW / wa);
    const hero = wordmark
      ? `<h1 style="margin:0">${logoPicture(wordmark, { w: heroW, h: heroH }, 'object-position:left center')}</h1>`
      : `<h1 class="bb-display" style="${css({ margin: 0, 'font-size': `${nameSize}px`, 'line-height': 0.92, 'letter-spacing': '-0.03em', 'font-family': displayFont, 'font-weight': displayWeight, color: fg, 'max-width': `${textW}px` })}" dir="auto">${esc(name)}</h1>`;
    const top = wordmark ? '<div></div>' : markOnly ? `<div style="padding-top:24px">${logoPicture(markOnly, { w: Math.round(168 * Math.min(4, logoAspect(markOnly) ?? 1)), h: 168 }, 'object-position:left center')}</div>` : '<div></div>';
    sheet(1, t('Cover'), 'Cover', `${field}<div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;flex:1 1 auto;gap:32px;max-width:${field ? '720px' : 'none'}">${top}<div style="display:flex;flex-direction:column;gap:36px">${hero}${statement ? `<p style="${css({ '--bb-sample': 'headline', margin: 0, 'font-size': statement.length > 80 ? '24px' : '30px', 'line-height': 1.3, color: fg, 'font-family': bodyFont, 'max-width': `${textW}px`, 'text-wrap': 'balance' })}" dir="auto">${esc(statement)}</p>` : ''}</div><div style="${css({ display: 'flex', 'justify-content': 'space-between', gap: '24px', 'font-size': '13px', color: fg, 'font-family': bodyFont, 'border-top': `1px solid ${mixHex(fg, bg, 0.6)}`, 'padding-top': '14px' })}"><span>${esc(t('Brand guidelines'))}</span><span>${esc(version)}${opts.date ? ` · ${esc(opts.date)}` : ''}</span></div></div>`, { bg, chrome: false });
    out[out.length - 1]!.html = out[out.length - 1]!.html.replace('class="bb-page"', 'class="bb-page" data-cover="1"').replace('overflow:hidden;', 'overflow:hidden;position:relative;');
  }

  const CHAPTERS_OF: Record<string, BrandBookChapterId[]> = { idea: ['strategy', 'audience', 'principles'], logo: ['logo'], colour: ['color'], type: ['type'], layout: ['layout'], voice: ['voice'], imagery: ['imagery', 'icons'], applications: ['applications'] };
  // The chapters counted are the ones the contents lists. A chapter is a draft when a written chapter behind it is;
  // one with no written chapter stands on the brand's values.
  const suggestions = [...data.colors, ...data.families, ...data.typeScale, ...data.logos, ...data.rules, ...data.words, ...data.voiceExamples].filter((x) => x.suggested).length;
  const isDraft = (x: Section) => {
    const behind = (CHAPTERS_OF[x.id] ?? []).map((id) => data.book?.chapters.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c && c.status !== 'not-applicable' && !!c.markdown.trim());
    return behind.length ? behind.some((c) => c.status !== 'confirmed') : suggestions > 0;
  };
  // Contents: the chapters large, with the page each opens on, and a draft said as such.
  const thinBook = sparse || main.reduce((sum, s) => sum + s.pages.length, 0) <= 10;
  {
    let at = 3;
    const rows = sections.map((s, i) => { const row = `<li style="${css({ '--bb-grid': 'free', display: 'grid', 'grid-template-columns': `${span(1)}px minmax(0, 1fr) auto 32px`, 'align-items': 'baseline', 'column-gap': '16px', 'border-top': `1px solid ${RULE}`, padding: '12px 0' })}"><span style="${css({ 'font-size': '16px', color: ACCENT, 'font-weight': 600, 'font-family': bodyFont })}">${s.appendix ? 'A' : String(i + 1).padStart(2, '0')}</span><span style="${css({ 'font-size': '30px', 'line-height': 1.15, color: INK, 'font-family': headingFont, 'font-weight': headingWeight })}">${esc(s.title)}</span><span style="${css({ 'font-size': '13px', color: DIM, 'font-family': bodyFont, 'white-space': 'nowrap' })}">${!s.appendix && isDraft(s) ? esc(t('Draft')) : ''}</span><span style="${css({ 'font-size': '16px', color: DIM, 'font-family': bodyFont, 'text-align': 'right', 'font-variant-numeric': 'tabular-nums' })}">${at}</span></li>`; at += s.pages.length + (s.appendix || thinBook ? 0 : 1); return row; }).join('');
    const two = sections.length > 7;
    const half = Math.ceil(sections.length / 2);
    const list = two ? grid('1fr 1fr', `<ol style="margin:0;padding:0;list-style:none">${rows.split('</li>').slice(0, half).join('</li>')}</li></ol><ol style="margin:0;padding:0;list-style:none">${rows.split('</li>').slice(half, -1).join('</li>')}</li></ol>`, 56, { 'align-items': 'start' }) : `<ol style="margin:0;padding:0;list-style:none">${rows}</ol>`;
    sheet(2, t('Contents'), 'Contents', stack(36, `<h2 class="bb-display-2" style="${css({ margin: 0, 'font-size': '72px', 'line-height': 1, 'letter-spacing': '-0.02em', 'font-family': displayFont, 'font-weight': displayWeight, color: INK })}">${esc(t('Contents'))}</h2>${list}`));
  }

  // The chapters: an opener in the brand's colour, then its pages across the full width. Openers alternate the accent
  // and the ink only when the two are clearly different colours; otherwise every opener has the one colour. A thin
  // book, with little to say, has no openers: each chapter starts with its number and title on its first page.
  {
    let n = 3;
    const contentPages = main.reduce((sum, s) => sum + s.pages.length, 0);
    const thin = sparse || contentPages <= 10;
    const accentBg = primary && contrastRatio(textOn(primary.value), primary.value) >= 4.5 ? primary.value : INK;
    const inkBg = ink?.value ?? INK;
    const alternate = colorDistance(accentBg, inkBg) > 30 && contrastRatio(accentBg, inkBg) >= 1.6;
    main.forEach((s, i) => {
      const num = String(i + 1).padStart(2, '0');
      if (thin) {
        // The same running head as every other page; the chapter's number and title stand in it.
        s.pages.forEach((inner2, j) => sheet(n++, `${num} ${s.title}${isDraft(s) ? `\u00a0·\u00a0${t('Draft')}` : ''}`, j === 0 ? `${s.title}, ${t('page')} 1` : `${s.title}, ${t('continued')}`, inner2, { bg: s.bg, tint: s.tint }));
        return;
      }
      // A brand that states how much of a page its accent takes (60/30/10) opens its chapters on ink, with the accent in
      // the number only, so that the book keeps the ratio it prints.
      const statedRatio = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*\/)/.test(data.rules.filter((r) => r.topic === 'color').map((r) => r.text).join(' '));
      const bg = statedRatio ? inkBg : alternate && i % 2 === 1 ? inkBg : accentBg;
      const fg = textOn(bg);
      // The opener says one idea in prose: no figures, token names, lists after a colon or colour values.
      // The chapter's own introduction first; without one, a rule of the brand's about the same subject, said as prose.
      const TOPIC: Record<string, string[]> = { logo: ['logo'], colour: ['color'], type: ['type'], layout: ['layout'], voice: ['voice'], imagery: ['imagery', 'iconography'], rules: ['general'] };
      const prose = (x: string) => x.length >= 30 && x.length <= 170 && !/\d+\s*(px|rem|em|%|ms)\b|#|:|;|\b[a-z]+-[a-z0-9-]+\b|[()]|--/.test(x) && quoteDebt(x) === 0 && sentenceLanguage(x) !== (lang === 'de' ? 'en' : 'de');
      // The chapter's thesis: a binding rule of its subject said whole, before a sentence taken out of one.
      const topicRules = data.rules.filter((r) => (TOPIC[s.id] ?? []).includes(r.topic) && r.kind === 'do').sort((a, b) => (a.severity === 'hard' ? 0 : 1) - (b.severity === 'hard' ? 0 : 1));
      const fromRules = [...topicRules.map((r) => PI(r)), ...topicRules.flatMap((r) => sentencesOf(PI(r)))];
      const sentences = [...(s.intro ? sentencesOf(s.intro) : []), ...(s.id === 'voice' ? sentencesOf(P(f.tone)) : []), ...fromRules].filter(prose);
      const principle = sentences.length ? wholeUpTo(sentences[0]!, 170) : '';
      // The title fits its half of the page: its longest word sets the size.
      const titleLongest = Math.max(...s.title.split(/\s+/).map((w) => w.length));
      const titleSize = Math.max(40, Math.min(s.title.length > 16 ? 76 : 96, Math.floor((span(6) * 0.96) / (titleLongest * (displayGlyph + 0.04)))));
      // One grid for every opener: the number large at the top left, the title at the foot on the left, the idea at
      // the foot on the right.
      const big = `<span aria-hidden="true" style="${css({ display: 'block', 'font-size': '260px', 'line-height': 0.86, 'letter-spacing': '-0.04em', 'font-family': displayFont, 'font-weight': displayWeight, color: statedRatio && primary && contrastRatio(primary.value, bg) >= 3 ? primary.value : fg })}">${num}</span>`;
      const titleHtml = `<h2 class="bb-display-2" style="${css({ margin: 0, 'font-size': `${titleSize}px`, 'line-height': 1, 'letter-spacing': '-0.025em', 'font-family': displayFont, 'font-weight': displayWeight, color: fg, 'text-wrap': 'balance' })}">${esc(s.title)}</h2>`;
      const words = principle ? `<p${s.introLang ?? ''} style="${css({ margin: 0, 'font-size': '24px', 'line-height': 1.35, color: fg, 'font-family': bodyFont, 'max-width': '520px', 'text-wrap': 'pretty' })}">${esc(principle)}</p>` : '';
      // Each opener carries its chapter's own thing at the top right, in the brand's material: the mark, the colours,
      // the letters of the display face, the spacing, a picture, the tokens, the brand's real work.
      const art = (() => {
        const AW = span(6), AH = 340;
        if (s.id === 'logo') { const l = data.logos.find((x) => madeFor(x, bg) && x === primaryLockup) ?? data.logos.find((x) => madeFor(x, bg)); return l ? logoPicture(l, { w: Math.min(AW, 460), h: 220 }, 'object-position:right center') : ''; }
        if (s.id === 'colour') {
          const list = [ground, ink, primary, second].filter((c, k, a): c is BrandColor => !!c && a.indexOf(c) === k && !policy.noField.includes(c.value.toLowerCase()));
          return `<div style="${css({ display: 'flex', gap: '12px', height: `${AH}px` })}">${list.map((c) => `<span style="${css({ '--bb-kind': 'swatch', display: 'block', width: '96px', height: '100%', background: c.value, 'box-shadow': colorDistance(c.value, bg) < 10 ? `inset 0 0 0 3px ${fg}` : `inset 0 0 0 1px ${mixHex(fg, bg, 0.6)}` })}"></span>`).join('')}</div>`;
        }
        if (s.id === 'type') return `<span aria-hidden="true" style="${css({ display: 'block', 'font-size': '300px', 'line-height': 0.86, 'letter-spacing': '-0.03em', 'font-family': displayFont, 'font-weight': displayWeight, color: fg })}">Aa</span>`;
        if (s.id === 'layout' && data.spacing.length) {
          const vals = [...new Set(data.spacing.map((x) => x.value))].sort((a, b) => a - b).filter((v) => v >= 4).slice(-6);
          const k = Math.min(4, 200 / Math.max(...vals), (AW - 16 * (vals.length - 1)) / vals.reduce((a, b) => a + b, 0));
          return `<div style="${css({ display: 'flex', gap: '16px', 'align-items': 'flex-end', height: `${AH}px` })}">${vals.map((v) => `<span style="${css({ display: 'block', width: `${Math.round(v * k)}px`, height: `${Math.round(v * k)}px`, background: fg })}"></span>`).join('')}</div>`;
        }
        if (s.id === 'imagery') {
          const pic = data.assets.find((a) => a.kind === 'image' && !otherBrandShot(a) && !/screen|shot|website|webseite|referenz|reference|open-graph|og-|\bui\b/i.test(`${a.name} ${a.tags.join(' ')}`));
          if (!pic) return '';
          const portrait = /porträt|portrait|person|headshot|team|gesicht|face/i.test(`${pic.name} ${pic.tags.join(' ')}`);
          const gray = policy.grayscale === 'photos' || (policy.grayscale === 'portraits' && portrait);
          return `<img src="${escapeAttr(pic.asset)}" alt="${escapeAttr(pic.alt || pic.name)}" style="${css({ '--bb-kind': portrait ? 'portrait' : 'photo', width: '420px', height: `${AH}px`, 'object-fit': 'contain', 'object-position': 'right top', display: 'block', ...(gray ? { filter: 'grayscale(1)' } : {}) })}">`;
        }
        if (s.id === 'voice') {
          // One line the brand would say, in its own display face.
          const line = data.voiceExamples.map((e) => P(e.good)).find((x) => x && x.length <= 60 && headlineOk(x) && quoteDebt(x) === 0 && sentenceLanguage(x) !== (lang === 'de' ? 'en' : 'de') && !statement.includes(x));
          return line ? `<p style="${css({ '--bb-sample': 'headline', margin: 0, 'max-width': `${AW}px`, 'font-size': '48px', 'line-height': 1.08, 'letter-spacing': '-0.02em', 'font-family': displayFont, 'font-weight': displayWeight, color: fg, 'text-align': 'right', 'text-wrap': 'balance' })}" dir="auto">${esc(line)}</p>` : '';
        }
        if (s.id === 'tokens') {
          const list = [ground, ink, primary].filter((c): c is BrandColor => !!c && honestToken(c.token, c.value)).map((c) => `--${c.token}`).concat(data.spacing.slice(0, 3).map((x) => `--${x.token}`)).slice(0, 6);
          return list.length ? `<div style="${css({ display: 'flex', 'flex-direction': 'column', gap: '6px', 'font-family': monoFont, 'font-size': '24px', 'line-height': '32px', color: fg, 'text-align': 'right' })}">${list.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : '';
        }
        if (s.id === 'applications') {
          const e = (opts.examples ?? []).find((x) => x.verdict === 'good' && (!x.width || x.width > 800));
          return e ? `<img src="${escapeAttr(e.src)}" alt="${escapeAttr(e.name)}" style="${css({ '--bb-kind': 'example', width: `${AW}px`, height: `${Math.min(AH, e.width && e.height ? Math.round((AW * e.height) / e.width) : AH)}px`, 'object-fit': 'cover', 'object-position': 'top center', display: 'block', border: `1px solid ${mixHex(fg, bg, 0.6)}`, 'box-sizing': 'border-box' })}">` : '';
        }
        return '';
      })();
      const inner = `<div style="display:flex;flex-direction:column;justify-content:space-between;flex:1 1 auto"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:${GUTTER}px">${big}${art}</div><div style="display:grid;grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);column-gap:${GUTTER}px;align-items:end">${titleHtml}<div>${words}</div></div></div>`;
      sheet(n++, s.title, s.title, inner, { bg, head: false });
      s.pages.forEach((inner2, j) => sheet(n++, `${num} ${s.title}${isDraft(s) ? `\u00a0·\u00a0${t('Draft')}` : ''}`, j === 0 ? `${s.title}, ${t('page')} 1` : `${s.title}, ${t('continued')}`, inner2, { bg: s.bg, tint: s.tint }));
    });
    sections.filter((s) => s.appendix).forEach((s) => s.pages.forEach((inner, j) => sheet(n++, s.title, j === 0 ? s.title : `${s.title}, ${t('continued')}`, inner)));

    // Colophon: how the book is made, its version, and the state of approval in one place.
    // The state of what this book shows: the written chapters behind its sections, counted only when the book has
    // them, and the values; said once, without contradicting itself.
    const drafts = main.filter(isDraft).length;
    const de = lang === 'de';
    const chapterState = drafts === 0 ? t('Every chapter in this book is confirmed.')
      : drafts === main.length ? (de ? `Alle ${main.length} Kapitel sind Entwürfe.` : `All ${main.length} chapters are drafts.`)
      : de ? `${main.length - drafts} von ${main.length} Kapiteln sind bestätigt, die übrigen ${drafts} sind Entwürfe.` : `${main.length - drafts} of ${main.length} chapters are confirmed, the other ${drafts} are drafts.`;
    const state = [
      chapterState,
      suggestions ? `${suggestions} ${t('values are proposals and bind nobody until confirmed.')}` : t('Every value is confirmed.'),
      leftOutExamples ? (de ? `${leftOutExamples === 1 ? 'Ein Beispiel' : `${leftOutExamples} Beispiele`} der Marke ${leftOutExamples === 1 ? 'ist' : 'sind'} ausgelassen, weil ${leftOutExamples === 1 ? 'es' : 'sie'} den eigenen Sprachregeln ${leftOutExamples === 1 ? 'widerspricht' : 'widersprechen'}.` : `${leftOutExamples === 1 ? 'One example' : `${leftOutExamples} examples`} of the brand ${leftOutExamples === 1 ? 'is' : 'are'} left out, as ${leftOutExamples === 1 ? 'it breaks' : 'they break'} its own voice rules.`) : '',
      missing.length ? `${t('Still to add')}: ${(lang === 'de' ? missing : missing.map((x) => x.charAt(0).toLowerCase() + x.slice(1))).join(', ')}.` : '',
    ].filter(Boolean);
    const block = (k: string, v: string, first = false) => stack(6, `${label(esc(k), { 'font-size': '13px' })}${small(v, { 'font-size': '17px', 'line-height': '26px' })}`, first ? { 'padding-top': '4px' } : { 'border-top': `2px solid ${ACCENT}`, 'padding-top': '12px' });
    sheet(n, t('About this book'), 'About this book', grid('1fr 1fr', `${stack(24, `<h2 class="bb-display-2" style="${css({ margin: 0, 'font-size': '64px', 'line-height': 1.02, 'letter-spacing': '-0.02em', 'font-family': displayFont, 'font-weight': displayWeight, color: INK })}">${esc(t('About this book'))}</h2>${small(esc(t('Made from the brand\'s data in Bogen, so it always shows the brand as it is now. The full text, with sources and working notes, is in the Markdown export.')), { 'font-size': '18px', 'line-height': '28px', 'max-width': '480px' })}`)}${stack(28, `${block(t('Edition'), `${esc(version)}${opts.date ? ` · ${esc(opts.date)}` : ''}`, true)}${block(t('State'), state.map(esc).join('<br>'))}${block(t('Brand'), `${esc(name)}${statement ? `<br><span style="color:${DIM}">${esc(statement)}</span>` : ''}`)}`)}`, 72, { 'align-items': 'start' }));
  }
  return out;
}

/** A share as a reader says it: 1/2, 1/3, 1/4, else a percentage. */
function shareWords(x: number, lang: 'de' | 'en' = 'en'): string {
  for (const n of [1, 2, 3, 4, 5]) if (Math.abs(x - 1 / n) < 0.04) return n === 1 ? '1 ×' : `1/${n}`;
  return lang === 'de' ? `${Math.round(x * 100)} %` : `${Math.round(x * 100)}%`;
}

/** "- **Title.** text" bullets as principles. */
function principlesOf(text: string | undefined): { title: string; text: string }[] {
  if (!text) return [];
  return text.split('\n').map((l) => /^\s*[-*] \*\*([^*]+)\*\*\s*(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ title: m[1]!.replace(/[.:]\s*$/, ''), text: m[2]!.trim() }));
}

/** Media rules for a narrow screen: the pages lose their fixed size and the grids become one column. */
const PHONE = `<style>@media (max-width: 700px) {
.bb-book { width: 100% !important; padding: 0 !important; gap: 0 !important; }
.bb-page { width: 100% !important; height: auto !important; padding: 24px 16px !important; gap: 20px !important; border-bottom: 12px solid ${DESK}; }
.bb-grid { grid-template-columns: minmax(0, 1fr) !important; gap: 20px !important; }
.bb-row { flex-direction: column !important; gap: 4px !important; }
.bb-cols { column-count: 1 !important; }
.bb-display { font-size: 56px !important; }
.bb-display-2 { font-size: 34px !important; }
.bb-xl { font-size: 26px !important; }
.bb-shrink { font-size: 40px !important; }
.bb-head { display: none !important; }
}</style>`;

/** The whole book as one artboard: the pages one under another on a desk. */
export function brandBookHtml(data: BrandData, opts: BrandBookOptions = {}): string {
  const pages = brandBookPages(data, opts);
  const policy = bookPolicy(data);
  return `<main class="bb-book" data-name="Brand book" data-policy="${escapeAttr(JSON.stringify(policy))}" style="${css({ width: `${W + 64}px`, padding: '32px', display: 'flex', 'flex-direction': 'column', gap: '32px', background: DESK })}">${PHONE}${pages.map((p) => p.html).join('')}</main>`;
}
