import { bookPolicy, normalizeColor, type BogenDoc, type BogenNode, type BrandData } from '@bogen/core';
import type { LintIssue } from './lint.ts';

/**
 * Rule checks a reviewer would catch by reading, cheap enough to run on every lint: a double negative, a quotation that
 * is opened and never closed, the danger colour on something that is not a danger, one label spelled two ways across
 * screens, and text that breaks a rule its brand states (capitals, italic headings, the heading family, shadows).
 * Each is an objective defect, so each is hard. They also go to design_critique's reviewer as input.
 */

type Issue = LintIssue & { rule: 'consistency' };
const issue = (n: BogenNode, check: string, message: string, severity: 'hard' | 'advisory' = 'hard'): Issue => ({
  rule: 'consistency', check, severity, nodeId: n.id, name: n.name, message,
  ...(severity === 'advisory' ? { why: 'Two words for one action make people wonder whether they do different things.' } : {}),
});

const DOUBLE_NEG = [
  /(?<!\p{L})(never|not|no)\s+(do\s+not|don['’]t|not|never|no|none)(?!\p{L})/iu,
  /(?<!\p{L})(nie|niemals|nicht)\s+(nicht|kein\p{L}*|nie|niemals)(?!\p{L})/iu,
  /(?<!\p{L})(kein\p{L}*)\s+(nicht|kein\p{L}*|nie)(?!\p{L})/iu,
];

/** "Never Do not state…", "Nie Keine erfundenen Zahlen": a label stacked on a rule that already says no. */
export function doubleNegative(text: string): string | null {
  for (const re of DOUBLE_NEG) { const m = re.exec(text); if (m) return m[0]; }
  return null;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;
/** A quotation opened and never closed, or closed and never opened, in German, English or French marks. */
export function unbalancedQuote(text: string): string | null {
  const low9 = count(text, '„'), left = count(text, '“'), right = count(text, '”');
  if (low9 > 0 ? low9 !== left + right : left !== right) return low9 > 0 ? '„' : left > right ? '“' : '”';
  if (count(text, '«') !== count(text, '»')) return count(text, '«') > count(text, '»') ? '«' : '»';
  // Straight double quotes come in pairs; inch marks after a digit are not quotes.
  if (count(text.replace(/\d"/g, ''), '"') % 2 === 1) return '"';
  return null;
}

const DANGER_TOKEN = /(danger|error|destruct|alert|critical|negative|hang-?up|fehler)/i;
const DANGER_OK = /(?<!\p{L})(end|ends|hang|hang up|delete|remove|destroy|discard|error|errors|fail|failed|failure|danger|warning|warn|blocked|denied|stop|cancel|leave|sign out|log out|missed|offline|disconnected|invalid|required|beenden|auflegen|löschen|entfernen|fehler|abbrechen|verwerfen|blockiert|verpasst|ungültig|stopp)(?!\p{L})/iu;
const POSITIVE = /(?<!\p{L})(working|busy|progress|loading|speaking|listening|drawing|thinking|active|success|done|saved|ready|online|connected|live|arbeitet|zeichnet|lädt|fertig|aktiv|gespeichert|bereit|verbunden|spricht|hört)(?!\p{L})/iu;
const COLOR_PROPS = ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor', 'outlineColor', 'fill', 'stroke', 'background', 'border', 'boxShadow'];

function dangerNames(doc: BogenDoc, nodes: BogenNode[]): { vars: Set<string>; values: Set<string> } {
  const vars = new Set<string>();
  const values = new Set<string>();
  for (const t of doc.getTokens()) if (DANGER_TOKEN.test(t.name) && t.kind === 'color') { vars.add(t.name.replace(/^--/, '')); const v = normalizeColor(String(t.value)); if (v) values.add(v); }
  // Custom properties set on frames, as editor chrome and kits do (--ui-danger on a column).
  for (const n of nodes) for (const [k, v] of Object.entries(n.style)) if (k.startsWith('--') && DANGER_TOKEN.test(k)) { vars.add(k.slice(2)); const c = normalizeColor(String(v)); if (c) values.add(c); }
  return { vars, values };
}

function contextText(doc: BogenDoc, n: BogenNode, depth = 4): string {
  const parts: string[] = [];
  let cur: BogenNode | undefined = n;
  for (let i = 0; cur && i < depth; i++) {
    parts.push(cur.name ?? '', cur.text ?? '', String(cur.attrs?.['aria-label'] ?? ''), String(cur.attrs?.title ?? ''));
    cur = cur.parent ? doc.getNode(cur.parent) : undefined;
  }
  return parts.join(' ');
}

const LABEL_TAGS = new Set(['button', 'a', 'label', 'legend', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'option']);
const SYNONYMS: [string, string][] = [['end', 'hang up'], ['close', 'dismiss'], ['delete', 'remove'], ['settings', 'preferences'], ['sign in', 'log in'], ['sign out', 'log out'], ['beenden', 'auflegen'], ['löschen', 'entfernen'], ['einstellungen', 'optionen'], ['anmelden', 'einloggen']];
const keyOf = (s: string) => s.toLowerCase().replace(/[\s\-‐–_·.:…]+/g, '');

function artboardOf(doc: BogenDoc, n: BogenNode): string {
  let cur: BogenNode | undefined = n;
  while (cur) { if (cur.artboard) return cur.id; cur = cur.parent ? doc.getNode(cur.parent) : undefined; }
  return '';
}

function isLabel(n: BogenNode): boolean {
  const t = n.text?.trim() ?? '';
  if (!t || t.length > 32 || t.split(/\s+/).length > 4) return false;
  const role = String(n.attrs?.role ?? '');
  return LABEL_TAGS.has(n.tag ?? '') || role === 'button' || role === 'tab' || role === 'menuitem';
}

/** Rule checks over the layers, without a render. */
export function consistencyIssues(doc: BogenDoc, nodes: BogenNode[]): Issue[] {
  const out: Issue[] = [];
  const live = nodes.filter((n) => !n.virtual && !n.hidden);
  for (const n of live) {
    const t = n.text?.trim();
    if (!t) continue;
    const neg = doubleNegative(t);
    if (neg) out.push(issue(n, 'double-negative', `"${neg}" says no twice, so it reads as the opposite or as a slip. Keep one negation: drop the label when the rule already starts with no, not or never.`));
    const q = unbalancedQuote(t);
    if (q) out.push(issue(n, 'quote', `A quotation mark ${q} has no partner in "${t.slice(0, 60)}${t.length > 60 ? '…' : ''}". Close it, or remove it when the text is not a quotation.`));
  }
  // The danger colour on a working, speaking or done state reads as an alarm.
  const danger = dangerNames(doc, live);
  if (danger.vars.size || danger.values.size) {
    for (const n of live) {
      const hit = COLOR_PROPS.some((p) => {
        const v = n.style[p];
        if (typeof v !== 'string') return false;
        for (const name of danger.vars) if (v.includes(`var(--${name})`)) return true;
        const c = normalizeColor(v);
        return Boolean(c && danger.values.has(c));
      });
      if (!hit) continue;
      const ctx = contextText(doc, n);
      if (!DANGER_OK.test(ctx) && POSITIVE.test(ctx)) out.push(issue(n, 'danger-colour', `This layer uses the danger colour, but it shows a state that is not a danger ("${(POSITIVE.exec(ctx)?.[0] ?? '').trim()}"). Keep the danger colour for destructive actions and errors; give this state its own colour.`));
    }
  }
  // One label, spelled two ways across the screens.
  const byKey = new Map<string, { n: BogenNode; text: string; board: string }[]>();
  for (const n of live) if (isLabel(n)) {
    const text = n.text!.trim();
    const k = keyOf(text);
    if (!k) continue;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push({ n, text, board: artboardOf(doc, n) });
  }
  for (const group of byKey.values()) {
    const forms = [...new Set(group.map((g) => g.text))];
    if (forms.length < 2) continue;
    const first = group.find((g) => g.text === forms[1])!;
    out.push(issue(first.n, 'naming', `The same label is spelled ${forms.length} ways: ${forms.map((f) => `"${f}"`).join(', ')} (${group.length} layers). Pick one spelling and use it everywhere.`));
  }
  const labelsOn = new Map<string, BogenNode>();
  for (const n of live) if (isLabel(n)) labelsOn.set(n.text!.trim().toLowerCase(), n);
  for (const [a, b] of SYNONYMS) {
    const na = labelsOn.get(a), nb = labelsOn.get(b);
    if (na && nb) out.push(issue(nb, 'synonym', `"${na.text!.trim()}" and "${nb.text!.trim()}" both appear as controls. If they do the same thing, use one word.`, 'advisory'));
  }
  return out;
}

export interface ComputedText { fontFamily: string; fontStyle: string; textTransform: string; boxShadow?: string; textShadow?: string; borderStyle?: string }
const firstFamily = (f: string) => (f.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase();

/** Text and frames that break what the linked brand states about capitals, italic headings, families and shadows. */
export function brandRuleIssues(doc: BogenDoc, nodes: BogenNode[], brand: BrandData, computed: Map<string, ComputedText>): Issue[] {
  const policy = bookPolicy(brand);
  const out: Issue[] = [];
  const heading = (n: BogenNode) => /^h[1-3]$/.test(n.tag ?? '');
  for (const n of nodes) {
    if (n.virtual || n.hidden) continue;
    const c = computed.get(n.id);
    if (!c) continue;
    const fam = firstFamily(c.fontFamily);
    const t = n.text?.trim() ?? '';
    if (t) {
      if (policy.upperFamily && fam === policy.upperFamily.toLowerCase() && /\p{Ll}/u.test(t) && c.textTransform !== 'uppercase') {
        out.push(issue(n, 'brand-case', `The brand sets ${policy.upperFamily} in capitals only, and this text is in lower case. Set it in capitals or in the body family.`));
      }
      if (policy.noUpper && c.textTransform === 'uppercase' && !(policy.capsWordmark && t.toUpperCase() === policy.capsWordmark)) {
        out.push(issue(n, 'brand-case', 'The brand says no capitals, and this text is set in capitals. Remove text-transform: uppercase.'));
      }
      if (heading(n) && policy.italicFamily && fam === policy.italicFamily.toLowerCase() && c.fontStyle !== 'italic') {
        out.push(issue(n, 'brand-italic', `The brand sets headlines in ${policy.italicFamily} italic, and this ${n.tag} is upright.`));
      }
      // The display family set as the brand says (in capitals, say) is a heading choice too, not a break.
      const display = brand.families.find((f) => /display/i.test(f.role))?.family;
      const headingOk = new Set([policy.headingFamily, display].filter((f): f is string => Boolean(f)).map((f) => f.toLowerCase()));
      if (heading(n) && policy.headingFamily && !headingOk.has(fam)) {
        out.push(issue(n, 'brand-family', `The brand names ${policy.headingFamily} for headings, and this ${n.tag} is set in ${c.fontFamily.split(',')[0]}.`));
      }
    }
    if (policy.noShadow && ((c.boxShadow && c.boxShadow !== 'none') || (c.textShadow && c.textShadow !== 'none'))) {
      out.push(issue(n, 'brand-shadow', 'The brand uses no shadows, and this layer has one.'));
    }
    if (policy.noDashed && c.borderStyle?.includes('dashed')) out.push(issue(n, 'brand-dashed', 'The brand uses no dashed lines, and this layer has a dashed border.'));
  }
  return out;
}

/** The computed properties brandRuleIssues reads. */
export const BRAND_RULE_PROPERTIES = ['font-family', 'font-style', 'text-transform', 'box-shadow', 'text-shadow', 'border-top-style'];

export function toComputedText(style: Record<string, string>): ComputedText {
  return { fontFamily: style['font-family'] ?? '', fontStyle: style['font-style'] ?? '', textTransform: style['text-transform'] ?? '', boxShadow: style['box-shadow'], textShadow: style['text-shadow'], borderStyle: style['border-top-style'] };
}
