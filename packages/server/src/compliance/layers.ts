import { contentLanguageOf, declaredLanguageOf, normalizeLanguageTag, textLanguage, baseLanguage, type BogenDoc, type BogenNode } from '@bogen/core';

/**
 * Checks that read the layers themselves rather than a render: the language of the page and of its parts, how forms
 * name required fields, errors and personal data, sign-in fields, tab order, accessible names that hide visible words,
 * duplicate ids, sticky layers that can cover focus, endless motion, the page title and media. Each finding names
 * its criterion and its layer. `fail` is a failure of the criterion; `review` is something a person has to look at.
 */

export interface LayerFinding {
  rule: string;
  criterion: string;
  outcome: 'fail' | 'review';
  node_id: string;
  layer: string;
  message: string;
  fix?: string;
}

export interface LayerFacts {
  /** Video, audio or embedded players in the design. */
  media: number;
  audio: number;
  fields: number;
  timed: number;
  moving: number;
  /** The page's language and where it comes from. */
  language: { tag: string | null; from: 'board' | 'file' | null };
}

const PERSONAL: [RegExp, string][] = [
  [/\b(e-?mail|email)\b/i, 'email'], [/\b(phone|telefon|tel|mobil|handy)\b/i, 'tel'], [/\b(first ?name|vorname|given)\b/i, 'given-name'],
  [/\b(last ?name|surname|nachname|family)\b/i, 'family-name'], [/\b(full ?name|your name|ihr name|name)\b/i, 'name'], [/\b(street|stra(ss|ß)e|address|adresse)\b/i, 'street-address'],
  [/\b(postal|zip|postleitzahl|plz)\b/i, 'postal-code'], [/\b(city|stadt|ort)\b/i, 'address-level2'], [/\b(country|land)\b/i, 'country-name'],
];
const GENERIC_TITLE = /^(?:artboard|frame|page|seite|desktop|mobile|tablet|phone|untitled|unbenannt|screen|board)(?:[\s,_-]*\d+)?(?:\s*[,-]\s*\d+)?$/i;
const STATEMENT = /barrierefreiheit|accessibility statement|erkl(ä|ae)rung zur barrierefreiheit|accessibility|zugänglichkeit/i;

const textOf = (doc: BogenDoc, id: string): string => {
  const n = doc.getNode(id);
  if (!n) return '';
  return [n.text ?? '', ...doc.getChildren(id).map((c) => textOf(doc, c.id))].join(' ').replace(/\s+/g, ' ').trim();
};

/** A field's visible label: a label element around it or pointing at it, or the text just before it in its parent. */
function labelText(doc: BogenDoc, field: BogenNode, all: BogenNode[]): string {
  const up = doc.ancestors(field.id).map((a) => doc.getNode(a)).find((a) => a?.tag === 'label');
  if (up) return textOf(doc, up.id);
  const id = field.attrs?.id;
  if (id) {
    const pointing = all.find((n) => n.tag === 'label' && n.attrs?.for === id);
    if (pointing) return textOf(doc, pointing.id);
  }
  return field.attrs?.['aria-label'] ?? '';
}

export function layerChecks(doc: BogenDoc, boards: string[], nodes: BogenNode[]): { findings: LayerFinding[]; facts: LayerFacts } {
  const findings: LayerFinding[] = [];
  const add = (f: Omit<LayerFinding, 'layer'>) => findings.push({ ...f, layer: doc.getNode(f.node_id)?.name ?? '' });
  const live = nodes.filter((n) => !n.hidden);
  const facts: LayerFacts = { media: 0, audio: 0, fields: 0, timed: 0, moving: 0, language: { tag: null, from: null } };

  // 3.1.1: the board, as the web page it exports, or the file says the language.
  const fileLang = contentLanguageOf(doc);
  for (const b of boards) {
    const node = doc.getNode(b);
    if (!node) continue;
    const own = node.attrs?.lang;
    if (own !== undefined) {
      const tag = normalizeLanguageTag(own);
      if (!tag) add({ rule: 'bogen:lang-page', criterion: '3.1.1', outcome: 'fail', node_id: b, message: `The page's lang "${own.slice(0, 30)}" is not a language tag.`, fix: 'Set lang to a tag such as de, de-AT or en.' });
      else facts.language = { tag, from: 'board' };
    } else if (fileLang) facts.language = { tag: fileLang, from: 'file' };
    else add({ rule: 'bogen:lang-page', criterion: '3.1.1', outcome: 'fail', node_id: b, message: 'Neither this page nor the file says which language it is in, so the export has no lang and a screen reader guesses the pronunciation.', fix: 'Set the file\'s design language, or lang on the page.' });
    // 2.4.2: the page's name becomes its title on the web.
    const name = node.name.trim();
    if (!name || GENERIC_TITLE.test(name.replace(/,?\s*\d{3,4}(?:\s*px)?$/i, '').trim())) add({ rule: 'bogen:page-title', criterion: '2.4.2', outcome: 'review', node_id: b, message: `The page is called "${name.slice(0, 40)}", which says nothing about it. Its name becomes the title on the web; the title in the code is the developer's.`, fix: 'Name the page after what it is, such as "Pricing" or "Kontakt".' });
  }

  const ids = new Map<string, string[]>();
  for (const n of live) {
    const attrs = n.attrs ?? {};
    if (attrs.id) ids.set(attrs.id, [...(ids.get(attrs.id) ?? []), n.id]);
    // 3.1.2: copy whose words are clearly in the other of German and English than the language that applies to it.
    if (n.type === 'text' && n.text && n.text.split(/\s+/).length >= 6) {
      const declared = declaredLanguageOf(doc, n.id) ?? facts.language.tag;
      const guess = textLanguage(n.text);
      if (attrs.lang !== undefined && !normalizeLanguageTag(attrs.lang)) add({ rule: 'bogen:lang-parts', criterion: '3.1.2', outcome: 'fail', node_id: n.id, message: `lang "${attrs.lang.slice(0, 30)}" is not a language tag.`, fix: 'Use a tag such as de or en.' });
      else if (declared && guess && ['de', 'en'].includes(baseLanguage(declared)) && guess !== baseLanguage(declared)) add({ rule: 'bogen:lang-parts', criterion: '3.1.2', outcome: 'review', node_id: n.id, message: `This text reads as ${guess === 'de' ? 'German' : 'English'} in a part marked ${declared}: "${n.text.slice(0, 50)}".`, fix: `If it is, set lang="${guess}" on it.` });
    }
    const tag = n.tag.toLowerCase();
    if (n.type === 'video' || tag === 'video' || tag === 'audio' || (n.type === 'embed' && /youtube|vimeo|player|spotify|soundcloud/i.test(n.src ?? ''))) {
      facts.media++;
      if (tag === 'audio' || /spotify|soundcloud/i.test(n.src ?? '')) facts.audio++;
    }
    const field = /^(input|select|textarea)$/.test(tag) && !/^(hidden|submit|button|reset|image)$/i.test(attrs.type ?? '');
    if (field) {
      facts.fields++;
      const label = labelText(doc, n, live);
      const hint = `${label} ${attrs.name ?? ''} ${attrs.placeholder ?? ''} ${attrs.id ?? ''}`;
      // 1.3.5: a field for the person's own data says so with autocomplete.
      const type = (attrs.type ?? '').toLowerCase();
      const purpose = type === 'email' ? 'email' : type === 'tel' ? 'tel' : PERSONAL.find(([re]) => re.test(hint))?.[1];
      if (purpose && !attrs.autocomplete && type !== 'password' && type !== 'search') add({ rule: 'bogen:autocomplete', criterion: '1.3.5', outcome: 'fail', node_id: n.id, message: `This field asks for the person's ${purpose.replace(/-/g, ' ')} and has no autocomplete, so browsers and assistive tools cannot fill it in.`, fix: `Set autocomplete="${purpose}".` });
      // 3.3.2 and 1.3.1: a required field says so in its label, not only with a star in colour or the attribute.
      if ((attrs.required !== undefined || attrs['aria-required'] === 'true') && label && !/\*|required|pflicht|erforderlich|benötigt|muss/i.test(label)) add({ rule: 'bogen:required-label', criterion: '3.3.2', outcome: 'fail', node_id: n.id, message: `This field is required, and its label "${label.slice(0, 40)}" does not say so.`, fix: 'Add "(required)" or "(Pflichtfeld)" to the label, or explain a star at the start of the form.' });
      // 3.3.1: a field marked invalid points to a message in words.
      if (attrs['aria-invalid'] === 'true') {
        const refs = `${attrs['aria-describedby'] ?? ''} ${attrs['aria-errormessage'] ?? ''}`.split(/\s+/).filter(Boolean);
        const said = refs.map((r) => live.find((m) => m.attrs?.id === r)).filter((m): m is BogenNode => Boolean(m)).map((m) => textOf(doc, m.id)).join(' ').trim();
        if (!said) add({ rule: 'bogen:error-identification', criterion: '3.3.1', outcome: 'fail', node_id: n.id, message: 'This field is marked invalid, and no message in words is tied to it, so the error may be shown by colour alone.', fix: 'Write the error next to the field, give it an id, and point aria-describedby at it.' });
      }
      // 3.3.8: sign-in must allow password managers and pasting.
      if (type === 'password' && /^(off|false)$/i.test(attrs.autocomplete ?? '')) add({ rule: 'bogen:password', criterion: '3.3.8', outcome: 'fail', node_id: n.id, message: 'This password field turns autocomplete off, which keeps password managers from filling it.', fix: 'Use autocomplete="current-password", or "new-password" when signing up.' });
    }
    if (attrs['aria-invalid'] === 'true' && !field) facts.fields++;
    // 2.4.3: a positive tabindex puts a layer before everything else in the tab order.
    const tabindex = Number(attrs.tabindex);
    if (Number.isFinite(tabindex) && tabindex > 0) add({ rule: 'bogen:tabindex', criterion: '2.4.3', outcome: 'fail', node_id: n.id, message: `tabindex="${attrs.tabindex}" moves this layer ahead of the reading order for keyboard users.`, fix: 'Use tabindex="0", and order the layers instead.' });
    // 2.5.3: an aria-label must contain the words people see.
    const visibleText = textOf(doc, n.id);
    const aria = attrs['aria-label'];
    if (aria && visibleText && /^(a|button|input|select|summary)$/.test(tag) && visibleText.length <= 60) {
      const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
      if (norm(visibleText) && !norm(aria).includes(norm(visibleText))) add({ rule: 'bogen:label-in-name', criterion: '2.5.3', outcome: 'fail', node_id: n.id, message: `It shows "${visibleText.slice(0, 40)}" and is named "${aria.slice(0, 40)}", so someone who says what they see cannot reach it by voice.`, fix: `Start the aria-label with the visible words, or remove it.` });
    }
    // 2.4.11: what stays on screen while the page scrolls can cover the element in focus.
    const position = (n.style.position ?? '').trim();
    if ((position === 'sticky' || position === 'fixed') && !n.artboard) add({ rule: 'bogen:sticky', criterion: '2.4.11', outcome: 'review', node_id: n.id, message: `This layer is position: ${position}, so it can cover what has keyboard focus.`, fix: 'Give the page scroll-padding for its height, and check with the keyboard that focus is never completely covered.' });
    // 2.2.2: motion that does not stop by itself needs a way to pause it.
    const anim = `${n.style.animation ?? ''} ${n.style.animationIterationCount ?? ''}`;
    if (/\binfinite\b/.test(anim) && !/^none\b/.test((n.style.animationName ?? n.style.animation ?? '').trim())) {
      facts.moving++;
      add({ rule: 'bogen:endless-motion', criterion: '2.2.2', outcome: 'review', node_id: n.id, message: 'This layer moves without end. Motion that starts by itself and lasts more than 5 seconds needs a way to pause, stop or hide it.', fix: 'Add a pause button, or stop it after 5 seconds and in @media (prefers-reduced-motion: reduce).' });
    }
    if (attrs['http-equiv'] === 'refresh' || /countdown|timer|session/i.test(n.name)) facts.timed++;
  }
  // 4.1.1 in EN 301 549 V3.2.1: ids are unique.
  for (const [id, list] of ids) if (list.length > 1) for (const nid of list) add({ rule: 'bogen:duplicate-id', criterion: '4.1.1', outcome: 'fail', node_id: nid, message: `id="${id}" is used by ${list.length} layers. Labels and descriptions pointing at it reach only the first.`, fix: 'Give each one its own id.' });
  return { findings, facts };
}

/** Whether a page links an accessibility statement, as the WZG asks of public bodies (and the BaFG of information). */
export function statementLink(doc: BogenDoc, nodes: BogenNode[]): BogenNode | null {
  return nodes.find((n) => !n.hidden && (n.tag === 'a' || n.attrs?.href) && STATEMENT.test(`${textOf(doc, n.id)} ${n.attrs?.href ?? ''}`)) ?? null;
}
