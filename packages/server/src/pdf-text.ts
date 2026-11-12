import { inflateSync } from 'node:zlib';

/**
 * The words of a PDF, as far as they can be read without a PDF library: the text operators of its content
 * streams, plain or Flate-compressed, with literal and hex strings in a one-byte encoding. That covers what
 * office programs, browsers' "print to PDF" and pdf-lib write for Latin text. Fonts that map glyphs through a
 * CMap (most CJK, some subset fonts) come out as nothing, and the caller says so instead of guessing.
 * Nothing here runs a program or a script: the bytes are only inflated, with a cap, and scanned.
 */

const MAX_INFLATED = 8 * 1024 * 1024;
const MAX_STREAMS = 2000;

function inflate(bytes: Buffer): Buffer | null {
  try {
    return inflateSync(bytes, { maxOutputLength: MAX_INFLATED });
  } catch {
    return null;
  }
}

/** The bodies of the streams that may hold page content: unfiltered or Flate, never images or fonts. */
function contentStreams(pdf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const text = pdf.toString('latin1');
  const marker = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text)) && out.length < MAX_STREAMS) {
    // `endstream` itself matches the marker: skip it.
    if (text.slice(Math.max(0, m.index - 3), m.index) === 'end') continue;
    const dictStart = text.lastIndexOf('<<', m.index);
    const dict = dictStart >= 0 ? text.slice(dictStart, m.index) : '';
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    marker.lastIndex = end + 9;
    if (/\/Subtype\s*\/(Image|Form)|\/Type\s*\/(XObject|XRef|ObjStm|Font)|\/Length1|\/FontFile/.test(dict)) continue;
    const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '';
    const body = pdf.subarray(start, end);
    if (!filters) out.push(body);
    else if (/^\/FlateDecode$|^\[\s*\/FlateDecode\s*\]$/.test(filters.trim())) {
      const inflated = inflate(body);
      if (inflated) out.push(inflated);
    }
  }
  return out;
}

/** A literal string `( ... )` from `i`, the index of its opening parenthesis. */
function literal(s: string, i: number): { value: string; end: number } {
  let depth = 0;
  let value = '';
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (c === '\\') {
      const n = s[j + 1] ?? '';
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (n in escapes) {
        value += escapes[n];
        j++;
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(j + 1))![0];
        value += String.fromCharCode(Number.parseInt(oct, 8));
        j += oct.length;
      } else if (n === '\r' || n === '\n') {
        j += n === '\r' && s[j + 2] === '\n' ? 2 : 1;
      }
      continue;
    }
    if (c === '(') {
      if (depth++ > 0) value += c;
      continue;
    }
    if (c === ')') {
      if (--depth === 0) return { value, end: j + 1 };
      value += c;
      continue;
    }
    value += c;
  }
  return { value, end: s.length };
}

function hex(s: string, i: number): { value: string; end: number } {
  const close = s.indexOf('>', i);
  const digits = s.slice(i + 1, close < 0 ? s.length : close).replace(/[^0-9a-fA-F]/g, '');
  const padded = digits.length % 2 ? `${digits}0` : digits;
  let value = '';
  for (let k = 0; k < padded.length; k += 2) value += String.fromCharCode(Number.parseInt(padded.slice(k, k + 2), 16));
  return { value, end: close < 0 ? s.length : close + 1 };
}

/** The text one content stream shows, in the order it is drawn, with a line break where a new line starts. */
function streamText(content: string): string {
  let out = '';
  const operands: (string | number | (string | number)[])[] = [];
  let array: (string | number)[] | null = null;
  let inText = false;
  const show = (value: string) => {
    out += value;
  };
  for (let i = 0; i < content.length;) {
    const c = content[i]!;
    if (c === '%') {
      const nl = content.indexOf('\n', i);
      i = nl < 0 ? content.length : nl + 1;
      continue;
    }
    if (c === '(') {
      const { value, end } = literal(content, i);
      (array ?? operands).push(value);
      i = end;
      continue;
    }
    if (c === '<' && content[i + 1] !== '<') {
      const { value, end } = hex(content, i);
      (array ?? operands).push(value);
      i = end;
      continue;
    }
    if (c === '[') {
      array = [];
      i++;
      continue;
    }
    if (c === ']') {
      if (array) operands.push(array);
      array = null;
      i++;
      continue;
    }
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(content.slice(i, i + 32));
    if (number) {
      (array ?? operands).push(Number(number[0]));
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z'"*]+/.exec(content.slice(i, i + 16));
    if (word) {
      const op = word[0];
      i += op.length;
      if (op === 'BT') inText = true;
      else if (op === 'ET') {
        inText = false;
        if (out && !out.endsWith('\n')) out += '\n';
      } else if (inText) {
        if (op === 'Tj' && typeof operands.at(-1) === 'string') show(operands.at(-1) as string);
        else if (op === "'" || op === '"') {
          out += '\n';
          if (typeof operands.at(-1) === 'string') show(operands.at(-1) as string);
        } else if (op === 'TJ' && Array.isArray(operands.at(-1))) {
          for (const part of operands.at(-1) as (string | number)[]) {
            if (typeof part === 'string') show(part);
            // A large negative adjustment is the gap between two words.
            else if (part < -180 && !out.endsWith(' ')) out += ' ';
          }
        } else if (op === 'T*') out += '\n';
        else if ((op === 'Td' || op === 'TD') && typeof operands.at(-1) === 'number' && operands.at(-1) !== 0 && out && !out.endsWith('\n')) out += '\n';
      }
      operands.length = 0;
      continue;
    }
    i++;
  }
  return out;
}

/** The text of a PDF, or null when it holds none that can be read this way. */
export function pdfText(pdf: Uint8Array): string | null {
  const bytes = Buffer.from(pdf);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
  const parts = contentStreams(bytes).map((b) => b.toString('latin1')).filter((s) => /\bBT\b/.test(s)).map(streamText);
  const text = parts.join('\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;
  // Glyph ids read as bytes look like noise: mostly control characters and no words.
  const readable = text.replace(/[^\p{L}\p{N}\p{P}\s]/gu, '').length / text.length;
  if (readable < 0.85 || !/\p{L}{2,}/u.test(text)) return null;
  return text;
}
