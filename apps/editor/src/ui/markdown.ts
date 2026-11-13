/**
 * The markdown agents write, read into a small tree that React draws as elements. Nothing here ever becomes HTML: a
 * tag in the text stays text, and a link is kept only when it goes to http or https. What it reads is what agents
 * use in a reply: paragraphs, headings, lists, quotes, code blocks, inline code, bold, italics and links.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'p'; children: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; children: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; children: Inline[] }
  | { t: 'pre'; lang: string; text: string };

const BULLET = /^\s{0,6}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,6}(\d{1,6})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', children: inline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const close = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(close.slice(0, 3)); i++) body.push(lines[i]!);
      blocks.push({ t: 'pre', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (RULE.test(line) && !para.length) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: 'h', level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, children: inline(heading[2]!) });
      continue;
    }
    if (BULLET.test(line) || NUMBER.test(line)) {
      flush();
      const ordered = !BULLET.test(line);
      const items: string[] = [];
      const start = ordered ? Number(NUMBER.exec(line)![1]) : 1;
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        const m = ordered ? NUMBER.exec(l) : BULLET.exec(l);
        if (m) items.push(ordered ? m[2]! : m[1]!);
        // A line indented under an item continues it.
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += `\n${l.trim()}`;
        else { i--; break; }
      }
      const parsed = items.map((item) => inline(item));
      blocks.push(ordered ? { t: 'ol', start, items: parsed } : { t: 'ul', items: parsed });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body: string[] = [quote[1]!];
      for (i++; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(QUOTE.exec(lines[i]!)![1]!);
      i--;
      blocks.push({ t: 'quote', children: inline(body.join('\n')) });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** Only web links are kept; anything else (javascript:, data:, a relative path) stays as its words. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (!/^https?:\/\//i.test(h)) return null;
  try {
    const url = new URL(h);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const push = (node: Inline) => {
    if (plain) out.push({ t: 'text', text: plain });
    plain = '';
    out.push(node);
  };
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length && /[\\`*_[\]()#>-]/.test(text[i + 1]!)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') { push({ t: 'br' }); i++; continue; }
    if (ch === '`') {
      const ticks = /^`+/.exec(rest)![0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        push({ t: 'code', text: text.slice(i + ticks.length, end).replace(/^ (.*) $/, '$1') });
        i = end + ticks.length;
        continue;
      }
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      push({ t: 'strong', children: inline(strong[2]!) });
      i += strong[0].length;
      continue;
    }
    const em = /^(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_])\1(?![\w*])/.exec(rest);
    if (em && (ch === '*' || !/\w/.test(text[i - 1] ?? ''))) {
      push({ t: 'em', children: inline(em[2]!) });
      i += em[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]!);
      if (href) push({ t: 'link', href, children: inline(link[1]!) });
      else plain += link[1];
      i += link[0].length;
      continue;
    }
    plain += ch;
    i++;
  }
  if (plain) out.push({ t: 'text', text: plain });
  return out;
}

/** The words of a tree, for a screen reader label or a test. */
export function plainText(blocks: Block[]): string {
  const words = (nodes: Inline[]): string => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.text : n.t === 'br' ? '\n' : words(n.children))).join('');
  return blocks.map((b) => (b.t === 'pre' ? b.text : b.t === 'ul' || b.t === 'ol' ? b.items.map(words).join('\n') : words(b.children))).join('\n\n');
}
