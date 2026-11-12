/**
 * Reads plain values out of JavaScript and TypeScript source without running it: object and array literals,
 * strings, numbers, booleans and null. A bare name comes back as a `JsName`, so that a caller can follow an
 * import; anything else (a call, a function, JSX, a template with `${}`) is `UNKNOWN`, and the reading goes on
 * after it. Stories and Tailwind configs are code, and Bogen does not run a person's code, so this is all it sees.
 */

export const UNKNOWN: unique symbol = Symbol('unknown');
export class JsName {
  constructor(readonly name: string) {}
}
export type JsValue = string | number | boolean | null | JsValue[] | { [key: string]: JsValue } | JsName | typeof UNKNOWN;

const CLOSE: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[\w$]/;

export class LiteralReader {
  i: number;
  constructor(readonly src: string, at = 0) {
    this.i = at;
  }

  private peek(): string {
    return this.src[this.i] ?? '';
  }

  /** Spaces and comments. */
  skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') this.i++;
      else if (c === '/' && this.src[this.i + 1] === '/') {
        const end = this.src.indexOf('\n', this.i);
        this.i = end < 0 ? this.src.length : end;
      } else if (c === '/' && this.src[this.i + 1] === '*') {
        const end = this.src.indexOf('*/', this.i + 2);
        this.i = end < 0 ? this.src.length : end + 2;
      } else return;
    }
  }

  private string(): string | typeof UNKNOWN {
    const quote = this.src[this.i]!;
    let out = '';
    let plain = true;
    this.i++;
    while (this.i < this.src.length && this.src[this.i] !== quote) {
      const c = this.src[this.i]!;
      if (c === '\\') {
        const n = this.src[this.i + 1] ?? '';
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        this.i += 2;
        continue;
      }
      if (quote === '`' && c === '$' && this.src[this.i + 1] === '{') {
        plain = false;
        this.i += 2;
        this.skipBalanced('}');
        continue;
      }
      out += c;
      this.i++;
    }
    this.i++;
    return plain ? out : UNKNOWN;
  }

  /** Past a bracketed stretch whose opening bracket was already read. */
  private skipBalanced(close: string): void {
    const stack = [close];
    while (this.i < this.src.length && stack.length) {
      const c = this.src[this.i]!;
      if (c === '"' || c === "'" || c === '`') {
        this.string();
        continue;
      }
      if (c === '/' && (this.src[this.i + 1] === '/' || this.src[this.i + 1] === '*')) {
        this.skipSpace();
        continue;
      }
      if (CLOSE[c]) stack.push(CLOSE[c]!);
      else if (c === stack.at(-1)) stack.pop();
      this.i++;
    }
  }

  /** A JSX element, from its `<` to the end of its closing tag. */
  private skipJsx(): void {
    let depth = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === '{') {
        this.i++;
        this.skipBalanced('}');
        continue;
      }
      if (c !== '<') {
        this.i++;
        continue;
      }
      if (this.src[this.i + 1] === '/') {
        const end = this.src.indexOf('>', this.i);
        this.i = end < 0 ? this.src.length : end + 1;
        depth--;
        if (depth <= 0) return;
        continue;
      }
      // An opening tag: to its `>`, past attribute values, and self-closing when it ends with `/>`.
      this.i++;
      let selfClosing = false;
      while (this.i < this.src.length && this.src[this.i] !== '>') {
        const a = this.src[this.i]!;
        if (a === '{') {
          this.i++;
          this.skipBalanced('}');
        } else if (a === '"' || a === "'") this.string();
        else {
          selfClosing = a === '/';
          this.i++;
        }
      }
      this.i++;
      if (!selfClosing) depth++;
      if (depth <= 0) return;
    }
  }

  /** Past whatever expression starts here, up to a comma or a closing bracket at its own level. */
  skipExpression(): void {
    for (;;) {
      this.skipSpace();
      const c = this.peek();
      if (!c || c === ',' || c === ';' || c === ')' || c === '}' || c === ']') return;
      if (c === '"' || c === "'" || c === '`') this.string();
      else if (CLOSE[c]) {
        this.i++;
        this.skipBalanced(CLOSE[c]!);
      } else if (c === '<' && /[A-Za-z>]/.test(this.src[this.i + 1] ?? '')) this.skipJsx();
      else if (c === '=' && this.src[this.i + 1] === '>') this.i += 2;
      else this.i++;
    }
  }

  private name(): string {
    const start = this.i;
    while (this.i < this.src.length && IDENT.test(this.src[this.i]!)) this.i++;
    return this.src.slice(start, this.i);
  }

  /** One value. What follows it up to the next comma has to be nothing, `as …` or `satisfies …`, or it is unknown. */
  value(): JsValue {
    this.skipSpace();
    const start = this.i;
    const v = this.primary();
    this.skipSpace();
    const c = this.peek();
    if (!c || c === ',' || c === ';' || c === ')' || c === '}' || c === ']') return v;
    const rest = this.src.slice(this.i, this.i + 12);
    this.skipExpression();
    if (/^(as|satisfies)\b/.test(rest)) return v;
    // `a.b`, `a()`, `a + b`: an expression this reader does not evaluate.
    this.i = Math.max(this.i, start);
    return UNKNOWN;
  }

  private primary(): JsValue {
    const c = this.peek();
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"' || c === "'" || c === '`') return this.string();
    if (c === '<' && /[A-Za-z>]/.test(this.src[this.i + 1] ?? '')) {
      this.skipJsx();
      return UNKNOWN;
    }
    const num = /^-?(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?|\.\d+)/i.exec(this.src.slice(this.i, this.i + 40));
    if (num) {
      this.i += num[0].length;
      return Number(num[0].replace(/_/g, ''));
    }
    if (IDENT_START.test(c)) {
      const word = this.name();
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      if (word === 'undefined') return UNKNOWN;
      this.skipSpace();
      return this.peek() === '.' || this.peek() === '(' || this.peek() === '=' ? UNKNOWN : new JsName(word);
    }
    return UNKNOWN;
  }

  private array(): JsValue[] {
    const out: JsValue[] = [];
    this.i++;
    for (;;) {
      this.skipSpace();
      const c = this.peek();
      if (!c) return out;
      if (c === ']') {
        this.i++;
        return out;
      }
      if (c === ',') {
        this.i++;
        continue;
      }
      if (this.src.startsWith('...', this.i)) {
        this.i += 3;
        this.skipExpression();
        continue;
      }
      out.push(this.value());
    }
  }

  private object(): { [key: string]: JsValue } {
    const out: { [key: string]: JsValue } = {};
    this.i++;
    for (;;) {
      this.skipSpace();
      const c = this.peek();
      if (!c) return out;
      if (c === '}') {
        this.i++;
        return out;
      }
      if (c === ',') {
        this.i++;
        continue;
      }
      if (this.src.startsWith('...', this.i)) {
        this.i += 3;
        this.skipExpression();
        continue;
      }
      let key: string | null = null;
      if (c === '"' || c === "'") {
        const k = this.string();
        key = k === UNKNOWN ? null : k;
      } else if (c === '[') {
        this.i++;
        this.skipBalanced(']');
      } else if (IDENT_START.test(c) || /\d/.test(c)) key = this.name() || this.src[this.i++]!;
      else {
        this.i++;
        continue;
      }
      this.skipSpace();
      const next = this.peek();
      if (next === ':') {
        this.i++;
        const v = this.value();
        if (key !== null && key !== '__proto__') out[key] = v;
      } else if (next === '(' || (key && /^(get|set|async)$/.test(key) && IDENT_START.test(next))) {
        // A method: its body is code.
        this.skipExpression();
        if (key !== null && key !== '__proto__') out[key] = UNKNOWN;
      } else if (key !== null && key !== '__proto__' && (next === ',' || next === '}')) out[key] = new JsName(key);
    }
  }
}

/** The value of the literal at `at`, where `at` is its first character. */
export function readLiteral(src: string, at: number): { value: JsValue; end: number } {
  const reader = new LiteralReader(src, at);
  const value = reader.value();
  return { value, end: reader.i };
}

/** The literal a `const name = …` declaration holds, if it is one. */
export function constLiteral(src: string, name: string): JsValue | undefined {
  const m = new RegExp(`(?:^|[\\s;])(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=]+?)?=\\s*`).exec(src);
  if (!m) return undefined;
  return readLiteral(src, m.index + m[0].length).value;
}

export function isRecord(v: JsValue | undefined): v is { [key: string]: JsValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsName);
}
