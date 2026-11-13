/**
 * Every WCAG 2.1 and 2.2 success criterion of level A and AA, with the clause of EN 301 549 V3.2.1 chapter 9 that
 * takes it over, how far Bogen can check it from a design, the rules that do, and a short test for a person.
 *
 * - `auto`: Bogen measures the criterion itself. A pass still holds only for what is in the design.
 * - `partial`: Bogen finds some failures; finding none is not a pass, so a person decides.
 * - `manual`: only a person can decide, usually by using the built page.
 *
 * Sources: WCAG 2.2, W3C Recommendation of 12 December 2024 (https://www.w3.org/TR/WCAG22/), WCAG 2.1 of 6 May 2025
 * (https://www.w3.org/TR/WCAG21/), ETSI EN 301 549 V3.2.1 (2021-03), clauses 9.1.1.1 to 9.4.1.3 and 9.6, the version
 * cited in the Official Journal by Implementing Decision (EU) 2021/1339, and EN 301 549 V4.1.1 (2026-09), which takes
 * over WCAG 2.2 and is not cited in the Official Journal yet. Checked on 2026-11-13.
 */

export type Level = 'A' | 'AA';
export type Coverage = 'auto' | 'partial' | 'manual';
/** What a criterion is about, so that a design without such content can say so. */
export type Needs = 'media' | 'audio' | 'time' | 'forms' | 'motion';

export interface Criterion {
  /** `wcag:1.4.3`, or `en:9.6` for the EN clause that is not a WCAG criterion. */
  key: string;
  id: string;
  name: string;
  level: Level;
  /** The WCAG version that added it. */
  since: '2.0' | '2.1' | '2.2';
  /** Obsolete and removed in WCAG 2.2; still a clause of EN 301 549 V3.2.1. */
  removedIn22?: boolean;
  /** The clause of EN 301 549 V3.2.1, or null for a WCAG 2.2 addition that it does not contain. */
  en: string | null;
  /** The clause of EN 301 549 V4.1.1 (2026-09), or null where it is void (4.1.1). */
  en4: string | null;
  coverage: Coverage;
  /** Bogen's rules that report on it: `a11y:*` (a11y_audit), `bogen:*` (compliance checks), `axe` (axe-core by its WCAG tag). */
  rules: string[];
  /** How a person tests it, in one or two sentences. */
  test: string;
  /** Content the criterion is about; a design with none of it has nothing to check here. */
  needs?: Needs;
}

const W = (id: string, name: string, level: Level, since: Criterion['since'], coverage: Coverage, rules: string[], test: string, extra: Partial<Criterion> = {}): Criterion => ({
  key: `wcag:${id}`, id, name, level, since, en: since === '2.2' ? null : `9.${id}`, en4: id === '4.1.1' ? null : `9.${id}`, coverage, rules, test, ...extra,
});

export const CRITERIA: readonly Criterion[] = [
  W('1.1.1', 'Non-text Content', 'A', '2.0', 'partial', ['a11y:alt', 'a11y:name', 'axe'], 'For every image, icon and chart, read its text alternative without looking at it: it says what the picture says or does, and a decorative one has alt="".'),
  W('1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A', '2.0', 'manual', ['bogen:media'], 'For every recording with only sound or only pictures, there is a transcript or an audio track that says the same.', { needs: 'media' }),
  W('1.2.2', 'Captions (Prerecorded)', 'A', '2.0', 'manual', ['bogen:media', 'axe'], 'Play each video with the sound off. Every spoken word and important sound has a caption.', { needs: 'media' }),
  W('1.2.3', 'Audio Description or Media Alternative (Prerecorded)', 'A', '2.0', 'manual', ['bogen:media'], 'Watch each video without looking: what is only shown is also said, in an audio description or a full text alternative.', { needs: 'media' }),
  W('1.2.4', 'Captions (Live)', 'AA', '2.0', 'manual', ['bogen:media'], 'A live stream with sound has live captions.', { needs: 'media' }),
  W('1.2.5', 'Audio Description (Prerecorded)', 'AA', '2.0', 'manual', ['bogen:media'], 'Each video has an audio description of what is only shown.', { needs: 'media' }),
  W('1.3.1', 'Info and Relationships', 'A', '2.0', 'partial', ['a11y:heading-order', 'a11y:landmarks', 'bogen:required-label', 'axe'], 'Turn off the styles, or use a screen reader: headings, lists, tables, labels and groups still read as what they look like.'),
  W('1.3.2', 'Meaningful Sequence', 'A', '2.0', 'manual', [], 'Read the page in the order of its layers, as a screen reader does (see focus_order): the order still makes sense.'),
  W('1.3.3', 'Sensory Characteristics', 'A', '2.0', 'manual', [], 'No instruction relies only on shape, colour, size, place or sound, such as "press the round button on the right".'),
  W('1.3.4', 'Orientation', 'AA', '2.1', 'partial', ['axe'], 'Turn the phone or tablet: the page works upright and sideways, unless one orientation is essential.'),
  W('1.3.5', 'Identify Input Purpose', 'AA', '2.1', 'partial', ['bogen:autocomplete', 'axe'], 'Each field that asks for the person\'s own data (name, e-mail, address, phone) has the right autocomplete value.', { needs: 'forms' }),
  W('1.4.1', 'Use of Color', 'A', '2.0', 'partial', ['axe'], 'Look at the page in greyscale: links, errors, required fields and chart series can still be told apart.'),
  W('1.4.2', 'Audio Control', 'A', '2.0', 'manual', ['bogen:media'], 'Sound that plays by itself for more than 3 seconds can be paused or turned down on its own.', { needs: 'audio' }),
  W('1.4.3', 'Contrast (Minimum)', 'AA', '2.0', 'auto', ['axe'], 'Text has a contrast of 4.5:1 with its background, large text 3:1. Text over pictures and gradients is checked by eye.'),
  W('1.4.4', 'Resize Text', 'AA', '2.0', 'partial', ['bogen:resize-text'], 'Zoom the browser to 200 %: all text grows, nothing is cut off or overlaps, and every function still works.'),
  W('1.4.5', 'Images of Text', 'AA', '2.0', 'manual', [], 'Text is real text, not a picture of text, except a logo or where the look is essential.'),
  W('1.4.10', 'Reflow', 'AA', '2.1', 'auto', ['bogen:reflow'], 'At 320 CSS px wide (1280 px at 400 % zoom) nothing needs scrolling sideways, except tables, maps and similar content.'),
  W('1.4.11', 'Non-text Contrast', 'AA', '2.1', 'partial', ['bogen:non-text-contrast', 'a11y:focus-visible'], 'Field borders, icons, focus rings, chart lines and the states of controls reach 3:1 against what is around them.'),
  W('1.4.12', 'Text Spacing', 'AA', '2.1', 'auto', ['bogen:text-spacing'], 'With line height 1.5, paragraph spacing 2, letter spacing 0.12 and word spacing 0.16 times the font size, no text is cut off or overlaps.'),
  W('1.4.13', 'Content on Hover or Focus', 'AA', '2.1', 'manual', [], 'Tooltips and menus that appear on hover or focus can be closed with Escape, can be hovered themselves, and stay until moved away from.'),
  W('2.1.1', 'Keyboard', 'A', '2.0', 'partial', ['axe'], 'Put the mouse away. Reach and use every link, button, field and menu with Tab, Shift+Tab, Enter, Space and the arrow keys.'),
  W('2.1.2', 'No Keyboard Trap', 'A', '2.0', 'manual', [], 'Tab through the whole page, into and out of every widget, dialog and embed: focus never gets stuck.'),
  W('2.1.4', 'Character Key Shortcuts', 'A', '2.1', 'manual', [], 'Shortcuts of a single letter or number can be turned off or changed, or work only while their control has focus.'),
  W('2.2.1', 'Timing Adjustable', 'A', '2.0', 'manual', ['axe'], 'Every time limit can be turned off, adjusted or extended, unless it is real-time or essential.', { needs: 'time' }),
  W('2.2.2', 'Pause, Stop, Hide', 'A', '2.0', 'partial', ['bogen:endless-motion', 'axe'], 'Anything that moves, blinks or scrolls by itself for more than 5 seconds, and anything that updates itself, can be paused, stopped or hidden.'),
  W('2.3.1', 'Three Flashes or Below Threshold', 'A', '2.0', 'manual', [], 'Nothing flashes more than three times in any second.'),
  W('2.4.1', 'Bypass Blocks', 'A', '2.0', 'partial', ['a11y:landmarks', 'axe'], 'There is a way past repeated blocks such as the navigation: a skip link, landmarks or headings.'),
  W('2.4.2', 'Page Titled', 'A', '2.0', 'partial', ['bogen:page-title'], 'Each page has a title in the browser tab that says what it is about.'),
  W('2.4.3', 'Focus Order', 'A', '2.0', 'partial', ['bogen:tabindex'], 'Tab through the page (see focus_order): focus moves in an order that keeps the meaning and lets you work.'),
  W('2.4.4', 'Link Purpose (In Context)', 'A', '2.0', 'partial', ['a11y:link-text', 'a11y:name', 'axe'], 'Read each link with its sentence or list item: it is clear where it goes.'),
  W('2.4.5', 'Multiple Ways', 'AA', '2.0', 'manual', [], 'Each page of a site can be found in more than one way, such as navigation, search or a site map.'),
  W('2.4.6', 'Headings and Labels', 'AA', '2.0', 'partial', ['a11y:heading-order'], 'Headings and labels say what the section or the field is about.'),
  W('2.4.7', 'Focus Visible', 'AA', '2.0', 'partial', ['a11y:focus-visible'], 'Tab through the page: you can always see where focus is.'),
  W('2.4.11', 'Focus Not Obscured (Minimum)', 'AA', '2.2', 'partial', ['bogen:sticky'], 'Tab through the page: a focused element is never completely hidden by a sticky header, footer, banner or chat.'),
  W('2.5.1', 'Pointer Gestures', 'A', '2.1', 'manual', [], 'What needs a swipe, pinch or a path also works with a single tap or click, such as buttons for a carousel.'),
  W('2.5.2', 'Pointer Cancellation', 'A', '2.1', 'manual', [], 'Actions happen when the finger or button is released, and can be undone by moving away first.'),
  W('2.5.3', 'Label in Name', 'A', '2.1', 'partial', ['bogen:label-in-name', 'axe'], 'The accessible name of each control contains its visible words, so that people who speak commands can say what they see.'),
  W('2.5.4', 'Motion Actuation', 'A', '2.1', 'manual', [], 'What reacts to shaking or tilting the device also works with a control, and the motion can be turned off.'),
  W('2.5.7', 'Dragging Movements', 'AA', '2.2', 'manual', [], 'Everything that can be dragged, such as a slider or a sortable list, also works with single taps or clicks.'),
  W('2.5.8', 'Target Size (Minimum)', 'AA', '2.2', 'auto', ['a11y:target-size', 'axe'], 'Each target is at least 24 by 24 CSS px, or has room around it, or is a link in a sentence.'),
  W('3.1.1', 'Language of Page', 'A', '2.0', 'auto', ['bogen:lang-page', 'axe'], 'The page says its main language (lang on html), and it is the right one.'),
  W('3.1.2', 'Language of Parts', 'AA', '2.0', 'partial', ['bogen:lang-parts', 'axe'], 'Passages in another language than the page carry their own lang, except names and words that are part of the language.'),
  W('3.2.1', 'On Focus', 'A', '2.0', 'manual', [], 'Moving focus onto something never opens a new window, submits a form or moves you elsewhere by itself.'),
  W('3.2.2', 'On Input', 'A', '2.0', 'manual', [], 'Choosing an option or typing never changes the page in a big way unless you were told it would.', { needs: 'forms' }),
  W('3.2.3', 'Consistent Navigation', 'AA', '2.0', 'manual', [], 'Navigation that repeats across pages stays in the same order.'),
  W('3.2.4', 'Consistent Identification', 'AA', '2.0', 'manual', [], 'Things that do the same are named the same on every page, such as one search icon with one name.'),
  W('3.2.6', 'Consistent Help', 'A', '2.2', 'manual', [], 'Help that repeats across pages (contact, chat, FAQ) is in the same place each time.'),
  W('3.3.1', 'Error Identification', 'A', '2.0', 'partial', ['bogen:error-identification'], 'Send each form with mistakes: every error is named in text next to its field, not only by colour.', { needs: 'forms' }),
  W('3.3.2', 'Labels or Instructions', 'A', '2.0', 'partial', ['a11y:name', 'bogen:required-label', 'axe'], 'Each field has a visible label, and required fields and formats are said before someone types.', { needs: 'forms' }),
  W('3.3.3', 'Error Suggestion', 'AA', '2.0', 'manual', [], 'When an error is found and a fix is known, the message says how to fix it.', { needs: 'forms' }),
  W('3.3.4', 'Error Prevention (Legal, Financial, Data)', 'AA', '2.0', 'manual', [], 'Orders, contracts and changes to stored data can be checked and corrected before they are final, or undone.', { needs: 'forms' }),
  W('3.3.7', 'Redundant Entry', 'A', '2.2', 'manual', [], 'In a process with several steps, nobody has to type the same thing twice; it is filled in or can be chosen.', { needs: 'forms' }),
  W('3.3.8', 'Accessible Authentication (Minimum)', 'AA', '2.2', 'partial', ['bogen:password'], 'Signing in needs no puzzle or memory test: password managers and pasting work, or there is another way.', { needs: 'forms' }),
  W('4.1.1', 'Parsing', 'A', '2.0', 'auto', ['bogen:duplicate-id'], 'Obsolete in WCAG 2.2. In EN 301 549 V3.2.1 it still applies: the markup has no duplicate ids and well-formed elements.', { removedIn22: true }),
  W('4.1.2', 'Name, Role, Value', 'A', '2.0', 'partial', ['a11y:name', 'axe'], 'With a screen reader, every control says what it is, its name and its state, such as "Menu, button, collapsed".'),
  W('4.1.3', 'Status Messages', 'AA', '2.1', 'manual', [], 'Messages such as "Added to cart" or "3 results" are announced by a screen reader without moving focus (role="status" or "alert").'),
];

/** EN 301 549 V3.2.1 clause 9.6: what a WCAG conformance claim requires beyond the criteria. */
export const EN_96: Criterion = {
  key: 'en:9.6', id: '9.6', name: 'WCAG conformance requirements', level: 'AA', since: '2.1', en: '9.6', en4: '9.6', coverage: 'manual', rules: [],
  test: 'The whole page conforms, every page of a process conforms, technologies are used in an accessibility supported way, and nothing interferes with the rest of the page.',
};

/** A duty of a law that is not a success criterion, such as publishing an accessibility statement. */
export interface Procedure {
  key: string;
  name: string;
  /** Where it comes from, with its link. */
  source: string;
  test: string;
  /** A Bogen rule that finds some of it, such as a missing statement link. */
  rules: string[];
}

export type ProfileId = 'wcag-2.2-aa' | 'wcag-2.1-aa' | 'en-301-549' | 'eaa-bafg' | 'wzg';
export const PROFILE_IDS: readonly ProfileId[] = ['en-301-549', 'wcag-2.2-aa', 'wcag-2.1-aa', 'eaa-bafg', 'wzg'];

export interface Profile {
  id: ProfileId;
  name: string;
  description: string;
  criteria: Criterion[];
  /** WCAG 2.2 criteria that the standard behind the law does not contain yet: reported, but advisory. */
  advisory: Criterion[];
  procedures: Procedure[];
}

const wcag21 = () => CRITERIA.filter((c) => c.since !== '2.2');
const wcag22 = () => CRITERIA.filter((c) => !c.removedIn22);
const additions22 = () => CRITERIA.filter((c) => c.since === '2.2');

const WZG = 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20010727';
const BAFG = 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20012316';
const EAA = 'https://eur-lex.europa.eu/eli/dir/2019/882/oj';
const MODEL = 'https://eur-lex.europa.eu/eli/dec_impl/2018/1523/oj';

export const PROCEDURES: Record<string, Procedure> = {
  'wzg-statement': { key: 'proc:wzg-statement', name: 'Accessibility statement', source: `WZG § 4(1) and (2); Directive (EU) 2016/2102 art. 7; model in Implementing Decision (EU) 2018/1523. ${WZG}; ${MODEL}`, test: 'An Erklärung zur Barrierefreiheit in the model structure is published in an accessible format, kept up to date, and reachable from the start page (for an app: on the developer\'s site or at download).', rules: ['bogen:statement-link'] },
  'wzg-feedback': { key: 'proc:wzg-feedback', name: 'Feedback mechanism', source: `WZG § 4(3); Directive (EU) 2016/2102 art. 7(1)(b). ${WZG}`, test: 'The statement links a way to report barriers and to ask for content that is exempt; reports get an answer with the result and the measures within two months.', rules: [] },
  'wzg-enforcement': { key: 'proc:wzg-enforcement', name: 'Link to the complaint procedure', source: `WZG § 5; Directive (EU) 2016/2102 art. 7(1)(c) and art. 9. ${WZG}`, test: 'The statement links the complaint procedure: for federal bodies the FFG\'s complaint body (https://www.digitalbarrierefrei.at/de/beschwerdestelle/kontaktformular-beschwerdestelle); bodies of a Land name the complaint body of that Land.', rules: [] },
  'bafg-information': { key: 'proc:bafg-information', name: 'Information on how the service is accessible', source: `BaFG § 14(2) and Anlage 3 Z 1; Directive (EU) 2019/882 art. 13(2) and Annex V. ${BAFG}; ${EAA}`, test: 'The general terms or a similar document describe the service in accessible formats, explain how it works, and say how it meets the accessibility requirements, in writing and in an accessible way.', rules: ['bogen:statement-link'] },
  'eaa-scope': { key: 'proc:eaa-scope', name: 'In scope, or exempt', source: `BaFG § 2, § 3 Z 19, § 6 and § 18; Directive (EU) 2019/882 art. 2, art. 4(5) and art. 14. ${BAFG}; ${EAA}`, test: 'Decide whether the product or service is in scope (such as e-commerce, consumer banking, e-books, passenger transport or electronic communications), whether the micro-enterprise exemption for services applies (under 10 people and at most EUR 2 million turnover or balance sheet), or a documented disproportionate burden; write down why.', rules: [] },
};

export function profile(id: ProfileId): Profile {
  switch (id) {
    case 'wcag-2.2-aa':
      return { id, name: 'WCAG 2.2 AA', description: 'All 55 success criteria of level A and AA in WCAG 2.2.', criteria: wcag22(), advisory: [], procedures: [] };
    case 'wcag-2.1-aa':
      return { id, name: 'WCAG 2.1 AA', description: 'All 50 success criteria of level A and AA in WCAG 2.1.', criteria: wcag21(), advisory: [], procedures: [] };
    case 'en-301-549':
      return { id, name: 'EN 301 549 V3.2.1, web', description: 'Chapter 9 of EN 301 549 V3.2.1, the version cited in the Official Journal: the 50 WCAG 2.1 A and AA criteria as clauses 9.1.1.1 to 9.4.1.3, and 9.6. The six WCAG 2.2 additions, in V4.1.1 (2026-09) and not cited yet, are shown as advice.', criteria: [...wcag21(), EN_96], advisory: additions22(), procedures: [] };
    case 'eaa-bafg':
      return { id, name: 'EAA / BaFG (Austria)', description: 'Products and services under Directive (EU) 2019/882 and the Barrierefreiheitsgesetz: EN 301 549 chapter 9, the WCAG 2.2 additions as advice, and the duties of the law.', criteria: [...wcag21(), EN_96], advisory: additions22(), procedures: [PROCEDURES['eaa-scope']!, PROCEDURES['bafg-information']!] };
    case 'wzg':
      return { id, name: 'WZG (Austrian public bodies)', description: 'Websites and apps of public bodies under the Web-Zugänglichkeits-Gesetz: EN 301 549 chapter 9, the WCAG 2.2 additions as advice, and the accessibility statement with its feedback mechanism.', criteria: [...wcag21(), EN_96], advisory: additions22(), procedures: [PROCEDURES['wzg-statement']!, PROCEDURES['wzg-feedback']!, PROCEDURES['wzg-enforcement']!] };
  }
}

/** The criterion for a WCAG number such as `1.4.3`. */
export function criterionById(id: string): Criterion | undefined {
  return CRITERIA.find((c) => c.id === id);
}
