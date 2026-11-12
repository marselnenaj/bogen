/**
 * Finds the editor's interface messages in its source, for the catalogs and their audit.
 *
 * A message is the first argument of `t(...)`, `t.rich(...)` or `msg(...)` when it is a string literal, and the
 * `one`/`other` pair of `t.n(count, one, other)`. The English source text is the key (see
 * apps/editor/src/i18n/core.ts). Calls with a computed argument are counted as dynamic: they show a message that
 * is marked elsewhere with `msg`, or text that is not the interface's own (a layer's name, a server's error).
 *
 * The audit also lists *candidates*: JSX text and interface attributes (`title`, `aria-label`, `placeholder`,
 * `alt`, `label`) still written as plain English literals, so what is left untranslated is counted, not guessed.
 */
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Message {
  key: string;
  /** Present for plural messages: the English singular. */
  one?: string;
  refs: string[];
}

export interface Candidate {
  file: string;
  line: number;
  text: string;
  kind: 'jsx-text' | 'attribute' | 'string';
}

export interface Extraction {
  messages: Map<string, Message>;
  dynamic: { file: string; line: number; code: string }[];
  /** English literals not wrapped and not in untranslated.json: misses, or exceptions nobody has reviewed. */
  candidates: Candidate[];
  /** Literals reviewed as not interface text (apps/editor/src/i18n/untranslated.json), with the reason. */
  intentional: (Candidate & { reason: string })[];
  problems: string[];
  files: number;
}

export const EDITOR_SRC = join(import.meta.dirname, '../../apps/editor/src');

/**
 * Files whose words are knowingly not translated yet, with the reason. Reported, never hidden.
 * Preview.tsx and layer-rules.ts belong to other work in progress and must not be edited here.
 */
export const EXCLUDED_FILES: Record<string, string> = {
  'preview/Preview.tsx': 'protected in this change (other work in progress); its 30-odd words stay English',
  'canvas/layer-rules.ts': 'protected in this change (other work in progress)',
};

/** Words that are names or technical terms in every language: a candidate made only of these is not a miss. */
export const TECHNICAL_TERMS = [
  'Bogen', 'Omarchy', 'Claude', 'Codex', 'Claude Code', 'Gemini', 'OpenCode', 'Cursor', 'VS Code', 'Zed', 'Figma', 'GitHub', 'Git', 'Tailscale',
  'Hyprland', 'Waybar', 'Walker', 'Mako', 'SwayOSD', 'Hyprlock', 'macOS', 'iOS', 'iPhone', 'iPad', 'Android', 'Linux', 'Chromium', 'Tomacco',
  'CSS', 'HTML', 'SVG', 'PNG', 'JPEG', 'JPG', 'WebP', 'AVIF', 'GIF', 'MP4', 'WebM', 'PDF', 'JSON', 'TOML', 'YAML', 'ZIP', 'URL', 'API', 'MCP',
  'CLI', 'SSH', 'HTTP', 'HTTPS', 'React', 'Tailwind', 'Storybook', 'WebMCP', 'ffmpeg', 'npm', 'Node', 'TypeScript', 'JavaScript', 'JSX', 'TSX',
  'RGB', 'HSL', 'OKLCH', 'Hex', 'HEX', 'px', 'rem', 'em', 'vw', 'vh', 'fps', 'ms', 'WCAG', 'AA', 'AAA', 'APCA', 'OK', 'ID', 'UI', 'UX', 'QR',
  'Ctrl', 'Shift', 'Alt', 'Cmd', 'Esc', 'Enter', 'Tab', 'Space', 'Super', 'Fn', 'PWA', 'Lucide', 'Google Fonts', 'Inter', 'Archivo',
];

const termPattern = new RegExp(`^(?:[\\s\\d.,:;/×x%+\\-–—·()\\[\\]#@&|<>=…'"]|${[...TECHNICAL_TERMS].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})*$`, 'i');

/** True for text that is only names, technical terms, numbers and punctuation. */
export function onlyTechnical(text: string): boolean {
  return termPattern.test(text.trim());
}

const UI_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'hint', 'tip', 'confirm', 'heading', 'emptyText']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

function literal(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** The string literals a conditional or fallback expression can give, and whether it can also give something computed. */
function literalLeaves(node: ts.Expression | undefined): { literals: string[]; computed: boolean } {
  if (!node) return { literals: [], computed: true };
  const text = literal(node);
  if (text !== undefined) return { literals: [text], computed: false };
  if (ts.isParenthesizedExpression(node)) return literalLeaves(node.expression);
  // `t(ctx('font weight', 'Light'))`: the ctx call is a message of its own (found where it is called).
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ctx') return { literals: [], computed: false };
  if (ts.isConditionalExpression(node)) {
    const a = literalLeaves(node.whenTrue);
    const b = literalLeaves(node.whenFalse);
    return { literals: [...a.literals, ...b.literals], computed: a.computed || b.computed };
  }
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    const a = literalLeaves(node.left);
    const b = literalLeaves(node.right);
    return { literals: [...a.literals, ...b.literals], computed: a.computed || b.computed };
  }
  return { literals: [], computed: true };
}

/** `t`, or `x.t`: the translator's call. */
function translatorCall(expr: ts.Expression): 't' | 'n' | 'rich' | 'msg' | null {
  if (ts.isIdentifier(expr)) return expr.text === 't' ? 't' : expr.text === 'msg' ? 'msg' : null;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 't') {
    return expr.name.text === 'n' ? 'n' : expr.name.text === 'rich' ? 'rich' : null;
  }
  return null;
}

function insideTranslatorCall(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && (translatorCall(p.expression) || (ts.isIdentifier(p.expression) && p.expression.text === 'ctx'))) return true;
    if (ts.isJsxElement(p) || ts.isSourceFile(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

/** Text inside <code>, <kbd>, <pre> or <samp>: commands, shortcuts and code, the same in every language. */
function inCodeElement(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isJsxElement(parent)) return false;
  return /^(code|kbd|pre|samp)$/.test(parent.openingElement.tagName.getText());
}

function inConsole(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === 'console') return true;
  }
  return false;
}

/** English-looking prose: a capitalised word followed by more words, as in `Delete layer` or `No files yet.` */
function looksLikeProse(text: string): boolean {
  if (!/[A-Za-z]{2,}/.test(text) || onlyTechnical(text)) return false;
  if (/^[a-z][\w-]*$/.test(text) || /^[\w-]+(\.[\w-]+)+$/.test(text)) return false; // identifiers, file names
  if (/^(--|\.|#|\/|@|https?:|data:|[\w-]+:)/.test(text)) return false; // CSS, selectors, paths, URLs
  return /^[A-Z][a-z']+([ ,.?!:…]|$)/.test(text) && /\s/.test(text.trim());
}

export function extract(root: string = EDITOR_SRC): Extraction {
  const messages = new Map<string, Message>();
  const dynamic: Extraction['dynamic'] = [];
  const candidates: Candidate[] = [];
  const problems: string[] = [];
  const files = sourceFiles(root);
  for (const path of files) {
    const file = relative(root, path);
    if (file.startsWith('i18n/') && !file.endsWith('.tsx')) continue;
    const text = readFileSync(path, 'utf8');
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const add = (key: string, node: ts.Node, one?: string) => {
      if (!key.trim()) {
        problems.push(`${file}:${where(node)}: empty message`);
        return;
      }
      const ref = `${file}:${where(node)}`;
      const had = messages.get(key);
      if (had) {
        if (one !== undefined && had.one !== undefined && had.one !== one) problems.push(`${ref}: plural "${key}" has another singular than at ${had.refs[0]}`);
        if ((one === undefined) !== (had.one === undefined)) problems.push(`${ref}: "${key}" is used both as a plural and as a plain message (first at ${had.refs[0]})`);
        had.refs.push(ref);
      } else {
        messages.set(key, { key, ...(one !== undefined ? { one } : {}), refs: [ref] });
      }
    };
    const excluded = file in EXCLUDED_FILES;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ctx') {
        const context = literal(node.arguments[0]);
        const text = literal(node.arguments[1]);
        if (context !== undefined && text !== undefined) add(`${context}\u0004${text}`, node);
        else problems.push(`${file}:${where(node)}: ctx() needs two string literals`);
      }
      if (ts.isCallExpression(node)) {
        const kind = translatorCall(node.expression);
        if (kind === 'n') {
          const one = literal(node.arguments[1]);
          const other = literal(node.arguments[2]);
          if (one !== undefined && other !== undefined) add(other, node, one);
          else dynamic.push({ file, line: where(node), code: node.getText(sf).slice(0, 120) });
        } else if (kind) {
          const key = literal(node.arguments[0]);
          if (key !== undefined) add(key, node);
          else {
            // `t(a ? 'One' : 'Other')`, `t(table[k] ?? 'Fallback')`: the literal branches are messages too.
            const leaves = literalLeaves(node.arguments[0]);
            for (const leaf of leaves.literals) if (leaf) add(leaf, node);
            if (leaves.computed && kind !== 'msg') dynamic.push({ file, line: where(node), code: node.getText(sf).slice(0, 120) });
          }
        }
      }
      if (!excluded && !insideTranslatorCall(node)) {
        if (ts.isJsxText(node)) {
          const s = node.text.replace(/\s+/g, ' ').trim();
          if (!inCodeElement(node) && /[A-Za-z]{2,}/.test(s) && !onlyTechnical(s)) candidates.push({ file, line: where(node), text: s, kind: 'jsx-text' });
        } else if (ts.isJsxAttribute(node) && node.initializer && UI_ATTRIBUTES.has(node.name.getText(sf))) {
          const s = literal(node.initializer) ?? (ts.isJsxExpression(node.initializer) ? literal(node.initializer.expression) : undefined);
          if (s && /[A-Za-z]{2,}/.test(s) && !onlyTechnical(s)) candidates.push({ file, line: where(node), text: s, kind: 'attribute' });
        } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !(ts.isJsxAttribute(node.parent)) && !ts.isLiteralTypeNode(node.parent)) {
          const s = ts.isTemplateExpression(node) ? node.getText(sf).slice(1, -1) : node.text;
          const property = ts.isPropertyAssignment(node.parent) ? node.parent.name.getText(sf) : '';
          if (looksLikeProse(s) && !/^(id|key|value|type|kind|testId|className|origin)$/.test(property) && !inConsole(node)) {
            candidates.push({ file, line: where(node), text: s.slice(0, 160), kind: 'string' });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const allowPath = join(root, 'i18n/untranslated.json');
  const allow: Record<string, string> = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : {};
  const intentional: Extraction['intentional'] = [];
  const left: Candidate[] = [];
  for (const c of candidates) {
    const reason = allow[`${c.file}|${c.text}`];
    if (reason) intentional.push({ ...c, reason });
    else left.push(c);
  }
  return { messages, dynamic, candidates: left, intentional, problems, files: files.length };
}

/** The English catalog: each message under its key, plurals as their English forms. Sorted, for stable diffs. */
export function sourceCatalog(messages: Map<string, Message>): Record<string, string | { one: string; other: string }> {
  const out: Record<string, string | { one: string; other: string }> = {};
  for (const key of [...messages.keys()].sort()) {
    const m = messages.get(key)!;
    // A key with a context (`ctx()`) shows its English without the context.
    const english = key.includes('\u0004') ? key.slice(key.indexOf('\u0004') + 1) : key;
    out[key] = m.one !== undefined ? { one: m.one, other: key } : english;
  }
  return out;
}
